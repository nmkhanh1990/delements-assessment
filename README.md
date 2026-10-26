# Delements AI Triage Console

An implementation assessment for a small, local IT-request triage application.
The intended MVP imports a fixed request set, presents deterministic AI-style
routing proposals, and lets a Manager review decisions with an auditable
workflow. It is designed to run without a paid AI account or external service.

> **Current repository status:** the local API, SQLite persistence, Manager
> workflow, request list/detail, audit/task reads, and a minimal React triage
> console are implemented. The assessment remains a local demo, not a production
> service. See
> [the implementation plan](docs/IMPLEMENTATION_PLAN.md) for current scope.

## Repository contents

```text
.
├── README.md
├── apps/
│   ├── api/       # Fastify API, health route, SQLite bootstrap
│   └── web/       # React/Vite triage console
├── docs/
│   ├── API_CONTRACT.md
│   ├── ARCHITECTURE.md
│   ├── IMPLEMENTATION_PLAN.md
│   ├── MOCK_AI_TEST_CASES.md
│   └── README_ASSUMPTIONS.md
└── fixtures/
│   ├── assessment_requests.csv
│   └── mock-ai-responses.json
├── package.json
└── tsconfig.base.json
```

## Assessment materials

| File | Purpose |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Proposed stack, service boundaries, data model, workflow, and safety gates. |
| [docs/API_CONTRACT.md](docs/API_CONTRACT.md) | Proposed REST routes, request/response examples, errors, and API invariants. |
| [docs/MOCK_AI_TEST_CASES.md](docs/MOCK_AI_TEST_CASES.md) | Deterministic scenario assertions, fault cases, and suggested demo sequence. |
| [docs/README_ASSUMPTIONS.md](docs/README_ASSUMPTIONS.md) | Fixture provenance, implementation assumptions, and decisions to preserve. |
| [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) | Deliverable-based implementation sequence with AI-assisted workflow and acceptance gates. |

## Fixture formats

### Source requests

[`fixtures/assessment_requests.csv`](fixtures/assessment_requests.csv) contains a
header and 12 synthetic source requests, identified as `REQ-001` through
`REQ-012`. Its columns are:

| Column | Meaning |
|---|---|
| `id` | Stable source request ID; use as the import idempotency key. |
| `source` | Fabricated channel: `chat`, `email`, or `form`. |
| `department_hint` | Untrusted routing hint; it is not an AI decision. |
| `requester_role` | Fabricated requester role. |
| `submitted_at` | Synthetic ISO-8601 timestamp with timezone. |
| `content` | Synthetic request text; treat as untrusted input. |

The sample includes a duplicate candidate (`REQ-002` relative to `REQ-001`), a
conflicting pair (`REQ-003` and `REQ-004`), a low-context request (`REQ-005`),
security/privacy-sensitive examples, and a prompt-injection string (`REQ-007`).
Importing the file repeatedly should retain the 12 original source IDs and must
not reset decisions or overwrite conflicting content silently.

### Mock AI responses

[`fixtures/mock-ai-responses.json`](fixtures/mock-ai-responses.json) is a
deterministic test fixture, not a live model response or workflow authority:

- `schema_version` and `default_mode` identify the fixture version and default
  response mode.
- `responses` maps each request ID to a proposal with department, priority,
  confidence, summary, owner, proposed steps, risk flags, and a suggested state.
- `scenario_metadata` records the expected relationships and assertions for
  scenarios S1–S5. It is test configuration, not part of the proposal schema.
- `fault_injection` defines invalid-output, timeout, unavailable-service, and
  low-confidence cases for exercising safe failure handling.

Validate proposal data strictly before persisting or displaying it. The
application must apply its own routing and authorization rules: an AI
recommendation must never approve a request or create an Open task. Keep failed
responses out of the proposal store and record appropriate retry/audit evidence.

## Intended MVP behavior

- Import the CSV transactionally and idempotently; reject same-ID/different-
  content collisions rather than silently replacing source records.
- Run the local mock adapter without a network call or provider credential.
- Route confidence below `0.70`, any risk flag, or an unresolved conflict to
  **Needs Review**.
- Keep duplicate and conflict relationships explicit. Only a Manager may merge
  or resolve a conflict, with a recorded reason; conflict resolution alone does
  not approve either request.
- Enforce Manager authorization server-side for every mutation. Viewer is
  read-only. The local role switch is a demo convenience, not authentication.
- Create an Open task only through an authorized approval flow and atomically
  record the resulting workflow and audit changes.
- Treat request text, including instructions embedded in `REQ-007`, as untrusted
  data rather than privileged instructions.

See [the architecture](docs/ARCHITECTURE.md) for the full state model and
[the API contract](docs/API_CONTRACT.md) for the proposed HTTP interface.

## Running and testing

Requires Node.js 22.13.0 or newer and npm.

```text
npm install
npm run dev
npm test
npm run build
```

The development command starts the API at `http://127.0.0.1:3001` and the Vite
UI at `http://127.0.0.1:5173`; the UI proxies `/api` calls to the API. The
health endpoint is `GET /api/health`. The API SQLite bootstrap uses
`.data/assessment.sqlite` (override with `DATABASE_PATH`). The database schema
is initialized on startup. Open the UI, choose the Manager demo role, then use
**Import baseline** to load the fixture. Select a request to run triage, inspect
the validated proposal and relations, and submit a reasoned workflow decision.
The list supports workflow, department, risk, and text filters. Switching to
Viewer keeps the read surfaces available and hides write controls.

The equivalent baseline import API call is:

```text
POST http://127.0.0.1:3001/api/imports/baseline
X-Demo-Role: Manager
Content-Type: application/json
Body: {}
```

The first import inserts 12 requests and seeds the S1 duplicate candidate and
S2 conflict; repeating it skips identical requests and does not reset existing
relation resolutions. A same-ID/different-content collision returns `409` and
rolls back the whole import batch. Triage is available to a Manager after
importing:

```text
POST http://127.0.0.1:3001/api/requests/REQ-005/triage
X-Demo-Role: Manager
Content-Type: application/json
Body: {}
```

Successful proposals are strictly validated, persisted, and routed to `Draft`
or `Needs Review`. Malformed, timed-out, or unavailable mock responses leave
the workflow at `Received`, save no proposal, and create failure/audit records.
Manager decisions use `POST /api/requests/:id/decisions` with a required
`expected_version` and a reason. For example, after triaging REQ-008:

```json
{
  "action": "approve",
  "reason": "Scope and owner verified",
  "expected_version": 1
}
```

Approval creates one Open task and records both transitions in the audit in the
same transaction. Viewer can read requests, audit, and tasks but cannot mutate.

The tests cover health, persistence/import, request list/detail filters and
serialization, mock triage, workflow transitions, authorization, relations,
audit, and task atomicity.

### Verification

The final local verification passed with `npm test` (41 API tests across six
test files; the web workspace currently has no automated test files) and
`npm run build` (API TypeScript build and web production bundle). A browser
walkthrough against a fresh temporary SQLite database imported all 12 requests,
triaged REQ-008, approved it, and confirmed the Open task and ordered
`approve`/`task_opened` audit entries. `git diff --check` passed. The browser
walkthrough is a manual smoke test, not an automated UI test.

## Assumptions and limitations

- The recruiter authorized candidate-authored synthetic requests and mock
  responses. Fixture content, scores, timestamps, owners, and the `0.70`
  threshold are assumptions, not Delements-provided production data or policy.
- No real customer or employee records are included.
- The role switch is not authentication; production use would require verified
  identity and authorization.
- Similarity detection is out of scope: the duplicate relationship is explicit
  fixture metadata, not a general-purpose duplicate detector.
- No live LLM, external integration, deployment, or production security
  clearance is included in this local assessment MVP.
- Reviewer access and repository handoff should be confirmed at submission;
  recruiter guidance says a reviewer account is not required beforehand.
