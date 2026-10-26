# AI Triage Console — REST API contract

The contract below describes the implemented API, including request
list/detail, baseline import, triage, decisions, audit history, and task
listing.

Base: `/api`; JSON UTF-8. Assessment role switch sends `X-Demo-Role: Viewer|Manager`. **This header is insecure by design and only for local demo.** Server validates role for every mutation; a missing/unknown role is denied for writes. Real auth is out of scope.

## Endpoints
| Method | Route | Role | Purpose |
|---|---|---|---|
| GET | `/requests?state=&department=&risk=&q=` | Viewer/Manager | Filter by workflow state, proposed department, risk flag, and case-insensitive text |
| GET | `/requests/:id` | Viewer/Manager | Raw request, validated proposal, relations, workflow/version |
| GET | `/requests/:id/audit` | Viewer/Manager | Implemented chronological audit history |
| GET | `/tasks` | Viewer/Manager | Implemented Open tasks |
| POST | `/imports/baseline` | Manager | Import CSV; return inserted/skipped/conflicts/total |
| POST | `/requests/:id/triage` | Manager | Run deterministic adapter; optional test/demo-only fault mode |
| POST | `/requests/:id/decisions` | Manager | Implemented: `approve`, `reject`, `edit`, `merge`, `request_clarification`, `resolve_conflict` |
| GET | `/health` | Public | Local health check |

Request reads require `X-Demo-Role: Viewer` or `Manager`; unknown or missing
roles return `403 FORBIDDEN`. List filters are optional; unsupported filter
values return `400 BAD_REQUEST`. Text search checks request ID, source text,
and proposal summary. Results are sorted newest first and include flattened
proposal summary fields; absent proposals have `null` proposal fields. The
detail response separates the original `request`, current `workflow`, nullable
validated `proposal`, and related `relations`. An unknown valid request ID
returns `404 NOT_FOUND`.

## Request/response examples
### Import
`POST /api/imports/baseline` requires `X-Demo-Role: Manager`. The implemented
route reads the bundled `fixtures/assessment_requests.csv` and returns
`200 {"inserted":12,"skipped":0,"total":12}` on first run, then
`200 {"inserted":0,"skipped":12,"total":12}` on a repeated import. An invalid
CSV returns `400 BAD_REQUEST`. If same ID has different source content, it
returns `409 DUPLICATE_ID_CONFLICT` with `conflicting_ids`; the transaction is
rolled back so no source rows are partially imported.
Send JSON content type for POST requests; an unsupported content type returns
`415 UNSUPPORTED_MEDIA_TYPE`.

### Triage
`POST /api/requests/REQ-005/triage` with `X-Demo-Role: Manager` and body
`{}` -> `200 {"request_id":"REQ-005","state":"Needs Review","proposal":{...}}`.
The route requires an imported request in `Received`. It strictly validates the
proposal, persists only valid proposals, records a successful triage attempt and
audit entry, and routes low confidence (< 0.70), any risk flag, a `Needs Review`
department, or an unresolved conflict to `Needs Review`. Otherwise the request
uses the validated recommendation (`Draft` or `Needs Review`).

For local tests/demos, body `{"mode":"malformed"}`, `{"mode":"timeout"}`,
`{"mode":"unavailable"}`, or `{"mode":"low_confidence"}` exercises the fixture
fault cases. Fault modes are disabled when `NODE_ENV=production`. Invalid JSON
or schema -> `422 AI_OUTPUT_INVALID`; timeout -> `503 AI_TIMEOUT`; unavailable
-> `503 AI_UNAVAILABLE`. These failures do not persist a proposal or change the
workflow from `Received`; each records a failed triage attempt and audit entry.
Successful re-triage is rejected with `409 INVALID_TRANSITION`.

### Manager decisions

All supported decisions require a Manager role, `expected_version`, and a
non-empty reason. The service checks authorization again and applies state,
relation, proposal, task, and audit changes transactionally. A stale version
returns `409 STALE_VERSION`.

Approval is allowed only for a validated proposal in `Draft` or `Needs Review`,
with no unresolved duplicate/conflict relation. It creates one task and returns
the final state `Open`; audit records the intermediate `Approved` then `Open`
transitions in order. The workflow version increments once for this atomic
decision.

`resolve_conflict` requires an unresolved relation and both requests in
`Needs Review`. It requires a reason, resolves the relation, increments both
workflow versions, and records audit entries for both requests. It does not
approve either request.

`merge` marks the source `Merged`, retains its source row, resolves its
duplicate-candidate relation, and records a `merged_into` relation. It rejects
self-merge, a target that does not match the seeded duplicate candidate,
terminal targets, and cycles. The target's workflow state is unchanged.

`edit` accepts only validated proposal fields (not state, owner role, or audit
actor); it revalidates the merged proposal and records the changed field names.
Risk flags, low confidence, or an unresolved relation keep the workflow in
`Needs Review`. `request_clarification` is valid only in `Needs Review` and
retains that state while incrementing the version.

`POST /api/requests/REQ-002/decisions`
```json
{"action":"merge","target_request_id":"REQ-001","reason":"Same checkout incident","expected_version":1}
```
Result `200 {"request_id":"REQ-002","state":"Merged","target_request_id":"REQ-001","version":2}`. Source request persists.

`POST /api/requests/REQ-003/decisions`
```json
{"action":"resolve_conflict","related_request_id":"REQ-004","reason":"Security review required before pixel installation","expected_version":1}
```
Result: relation becomes resolved; both requests remain `Needs Review`; no Open task. Conflict resolution must be deliberate and audited. Approval is a separate action.

`POST /api/requests/REQ-005/decisions`
```json
{"action":"request_clarification","reason":"Please identify the affected system and desired outcome","expected_version":1}
```
Result: stays `Needs Review`, appends audit entry.

`POST /api/requests/REQ-008/decisions`
```json
{"action":"approve","reason":"Scope and owner verified","expected_version":1}
```
Result: `200 {"request_id":"REQ-008","state":"Open","task_id":1,"version":2}`; audit contains both Approved and Open transitions in order, task created transactionally. Repeated approve does not create another task.

`edit` body uses `{ "action":"edit", "patch": {"priority":"High", "proposed_owner":"Marketing Operations"}, "reason":"...", "expected_version":1 }`; patch limited to validated proposal fields, never workflow state or audit actor.

`reject` requires nonempty reason. `merge` requires valid target and reason. `approve` requires a validated proposal, no unresolved conflict/duplicate
blocker, and a Manager. For security/privacy flagged proposals, a Manager must
explicitly document the review rationale; this local test does not simulate
actual security clearance.

## Common errors
- `400 BAD_REQUEST` malformed input/unknown action.
- `415 UNSUPPORTED_MEDIA_TYPE` request uses an unsupported content type.
- `400 FAULT_INJECTION_DISABLED` a fault mode was requested in production mode.
- `403 FORBIDDEN` Viewer mutation (even when API called directly).
- `404 NOT_FOUND` unknown request.
- `409 INVALID_TRANSITION | STALE_VERSION | DUPLICATE_ID_CONFLICT | UNRESOLVED_BLOCKER`.
- `409 STALE_VERSION` decision carries a version other than the current version.
- `409 UNRESOLVED_BLOCKER` approval is blocked by a duplicate candidate or conflict.
- `422 AI_OUTPUT_INVALID` strict AI validation failure.
- `503 AI_TIMEOUT | AI_UNAVAILABLE` deterministic fault injection.

Error envelope: `{ "error": {"code":"FORBIDDEN","message":"Manager role required"} }`. Never expose stack traces or secrets.

## Invariants to test
- Every write has Manager guard in service layer, not just route or UI.
- Every accepted decision is atomic with audit; Viewer denial returns 403.
- No direct endpoint sets `Open`; task creation is only through `approve` service.
- Merge retains both source IDs; reimport doesn't reset state.
- AI fields are validated before storage or rendering.
