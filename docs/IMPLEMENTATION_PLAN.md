# AI Triage Console — Implementation plan

**Purpose:** implement the local MVP described in
[ARCHITECTURE.md](./ARCHITECTURE.md), using the synthetic fixtures in
`fixtures/`. This is a sequence of deliverables and acceptance gates, not a
time estimate or a claim that the application has already been implemented.
Stages 1–6 technical deliverables are implemented and locally verified: the
repository has a runnable API/UI, SQLite persistence, baseline import,
deterministic mock triage, workflow decisions, seeded relations, filtered
request list/detail reads, audit history, task listing, and a minimal
assessment console. External repository-access confirmation remains a
submission handoff item.

## Scope and constraints

### MVP deliverables

- A local React/Vite UI and Fastify API with SQLite persistence, Zod validation,
  and automated tests.
- Idempotent import of the 12 requests in
  `fixtures/assessment_requests.csv`.
- A deterministic mock adapter backed by
  `fixtures/mock-ai-responses.json`; no paid AI account, credentials, or network
  calls are required.
- Server-side Manager/Viewer authorization, explicit duplicate/conflict
  relations, workflow decisions, and audit evidence.
- A usable interface for demonstrating scenarios S1–S5 and the safety gates.

### Out of scope

Live LLM integration, real authentication, deployment, generalized duplicate
detection, production security approval, and third-party integrations. The
local role switch is for assessment demonstration only. Do not publish the
repository or change its access settings without explicit handoff authorization.

## How AI-assisted implementation should work

AI is a development aid, not an authority for requirements, security decisions,
or acceptance. Use it to accelerate bounded implementation tasks while keeping
the repository documents, fixtures, and tests as the source of truth.

- Give the coding assistant one small, verifiable deliverable at a time, with
  relevant file paths and acceptance criteria. Ask it to inspect existing code
  and patterns before editing, make focused changes, and report changed files,
  assumptions, and validation results.
- Implement in dependency order. Do not ask for broad, simultaneous rewrites of
  persistence, workflow, API, and UI; later work depends on stable behavior in
  earlier layers.
- Review generated code and tests, especially authorization, transaction
  boundaries, validation, error handling, and any code that treats request text
  as instructions. AI-generated code must not be accepted solely because it
  compiles or its author reports success.
- Use the fixture and acceptance criteria below to check behavior. Run the
  relevant tests/build locally and inspect failures; have the assistant iterate
  until the evidence matches the requirement.
- Ask the assistant to state uncertainty rather than inventing requirements.
  Update the relevant documentation when an implementation choice changes a
  documented contract or assumption.
- Do not provide secrets or real customer/employee data to an AI tool. The
  supplied fixture is synthetic and should remain untrusted input at runtime.

## Dependency order

```text
Inspect requirements, fixtures, and repository state
  └─ Scaffold runtime and database
       ├─ Import and persistence
       ├─ Mock adapter, validation, and routing
       └─ Workflow, authorization, relations, and audit
            └─ API contract and integration tests
                 └─ UI and end-to-end demonstration
                      └─ Full verification and handoff documentation
```

Keep policy enforcement in server-side services, not only in the UI. Define API
shapes alongside the services and tests that establish their behavior.

## Implementation stages

### 1. Confirm baseline and scaffold the application

**Work**

- Review the architecture, API contract, assumptions, scenarios, and both
  fixtures. Confirm the current worktree and avoid overwriting existing work.
- Add a root npm workspace with `apps/api` and `apps/web`, plus reproducible
  `dev`, `build`, and `test` scripts.
- Configure TypeScript, Fastify, Vite/React, Vitest, Zod, and a SQLite driver.
- Add a minimal health endpoint and UI shell. Set a local database path and
  exclude generated databases/build outputs from version control.

**Deliverables:** workspace manifests, app entry points, local development
configuration, and a health endpoint.

**Acceptance gate:** dependencies can be installed from the manifest; the
development command starts the API and UI; `/api/health` responds and the UI
loads.

### 2. Implement persistence and safe, idempotent import

**Work**

- Create the tables, constraints, indexes, and foreign-key behavior described
  in [ARCHITECTURE.md](./ARCHITECTURE.md).
- Parse the CSV with a CSV parser; validate the exact header and every row.
- Import transactionally using request ID as the stable key. Skip an identical
  existing row; report same-ID/different-content collisions without replacing
  the original.
- Initialize workflow state only for new requests. Reimport must not reset
  decisions, relations, tasks, or audit history.
- Implement the documented Manager-only baseline import API.

**Acceptance gate:** first import inserts exactly 12 requests; second import
inserts 0 and skips 12; all source IDs remain unique and unchanged. A collision
does not overwrite source data. Invalid headers or records fail explicitly.

### 3. Implement the mock adapter, strict validation, and routing

**Work**

- Load the fixed response map and implement the adapter. Keep
  `scenario_metadata` and `fault_injection` separate from proposal data and
  workflow authority.
- Define strict proposal validation for department, priority, confidence,
  summary, owner, steps, risk flags, and `recommended_state`.
- Reject invalid proposals before persistence or rendering. For valid proposals,
  enforce application routing: confidence below `0.70`, any risk flag, or an
  unresolved conflict results in **Needs Review**.
- Handle malformed, timeout, and unavailable responses without saving a
  proposal: leave workflow at **Received**, record the triage attempt and audit
  evidence, and allow explicit retry.
- Restrict fault injection to tests/demo mode; it must not be an unrestricted
  production control.

**Acceptance gate:** each of the 12 default proposals validates; REQ-005 routes
to **Needs Review** at confidence `0.35`; low-confidence behavior is tested.
Malformed, timeout, and unavailable modes return explicit errors, persist no
invalid proposal, and create no Open task.

### 4. Implement workflow, authorization, relations, and audit

**Work**

- Enforce Manager authorization for every mutation in the service layer;
  missing/unknown roles and Viewer writes are denied by the server.
- Seed the S1 duplicate candidate and S2 conflict relation from explicit fixture
  metadata. Preserve both original requests.
- Implement approve, reject, edit, merge, request-clarification, and
  resolve-conflict decisions with input validation and documented reasons.
- Require non-empty reasons for reject, merge, clarification, and conflict
  resolution. Record approval rationale, especially for security/privacy
  risks.
- Block approval while conflicts remain unresolved. Conflict resolution only
  resolves the relation; it does not approve either request. Merge requires a
  distinct valid target, prevents cycles, and cannot merge into a terminal
  request.
- Require `expected_version` on workflow decisions. Use transactions to keep
  state changes, tasks, relations, and audit records atomic.
- Allow task creation only as part of an explicit authorized approval flow.
  Repeated approval must not create duplicate tasks. The AI proposal cannot
  set authoritative workflow state or bypass any Manager decision.

**Acceptance gate:** Manager can merge REQ-002 into REQ-001 and both source
rows remain. Resolving REQ-003/004 leaves both **Needs Review** until approved
separately. Viewer mutation returns 403. Stale versions, invalid transitions,
missing reasons, and unresolved blockers fail explicitly without partial
updates.

### 5. Complete the API and build the minimal UI — implemented

**Delivered**

- Implemented the routes in [API_CONTRACT.md](./API_CONTRACT.md), including
  filtered request list/detail reads, audit, tasks, import, triage, and
  decisions.
- Built a minimal console with request filters, import/triage, source and
  proposal detail, relations, Manager decisions, audit history, task listing,
  and a visible demo-role switch. Viewer controls are read-only; server
  authorization remains authoritative.
- Request and proposal text render as escaped text and are never interpreted
  as markup or privileged instructions.

**Acceptance gate:** list/detail and authorization behaviors have focused API
tests. The full-suite, build, and demo verification is tracked in stage 6.

### 6. Verify behavior and close documentation gaps — locally verified

**Verified**

- The complete suite passed: six API test files and 41 tests, covering import
  idempotency/conflicts, workflow atomicity and audit, authorization,
  list/detail serialization, routing, validation, and adapter fault modes.
- The API TypeScript build and web production bundle passed.
- A browser smoke walkthrough used a fresh temporary SQLite database: imported
  all 12 requests, triaged REQ-008, approved it, and verified the Open task and
  ordered audit transitions. `git diff --check` passed.
- README and design documents now describe implemented behavior and known
  limitations. No generated database/log files or credential-like values were
  found in the repository paths checked; fixture content is synthetic.

**Acceptance gate:** local test/build and fresh-database demo checks passed.
This was not a clean-clone/install verification; the demo used the existing
workspace dependencies. Web behavior was smoke-tested in the browser and does
not yet have automated UI tests. Repository access/reviewer handoff remains an
external submission step and was not changed.

## Required end-to-end acceptance scenarios

1. **Import:** importing twice leaves 12 unique requests and does not reset
   workflow state. A same-ID/different-content row does not overwrite source.
2. **Duplicate (S1):** REQ-002 is a candidate duplicate of REQ-001; only a
   Manager can merge it; both source rows remain.
3. **Conflict (S2):** REQ-003/004 cannot be approved while the conflict is
   unresolved. Resolution requires a Manager reason and alone creates no Open
   task.
4. **Low confidence (S3):** REQ-005 routes to **Needs Review** with its missing
   information flag; a clarification request is audited.
5. **Security/privacy (S4):** REQ-006 shows both risk flags and requires an
   explicit Manager rationale for approval.
6. **Untrusted input and RBAC (S5):** REQ-007's embedded prompt is treated as
   request text; it cannot cause approval/Open or suppress audit. Viewer writes
   are denied.
7. **Adapter failures:** malformed, timeout, and unavailable responses create
   no proposal and no Open task; failure and retry evidence are recorded.
8. **Consistency:** stale versions and invalid transitions do not partially
   change workflow, task, relation, or audit data.

## Suggested reviewer walkthrough

1. Import twice and verify the 12 source IDs.
2. Inspect the REQ-002 duplicate candidate and perform a Manager merge into
   REQ-001; verify both source records remain.
3. Inspect the REQ-003/004 conflict, resolve it with a reason, and verify that
   neither request is automatically approved or opened.
4. Inspect REQ-005 clarification and REQ-006 security/privacy review.
5. Triage REQ-007, then switch to Viewer and attempt a mutation.
6. Exercise malformed output and one service failure; inspect safe errors,
   audit evidence, and test results.

## Decisions this plan treats as fixed

- Confidence below `0.70`, any risk flag, or an unresolved conflict routes to
  **Needs Review**.
- AI `recommended_state` is limited to `Draft` or **Needs Review** and never
  authorizes approval or task creation.
- Conflict resolution requires a Manager reason and is distinct from approval.
- Merge marks the source **Merged**, leaves the target in its prior state, and
  preserves both source rows. Reimport never resets either.
- A schema-valid low-confidence proposal may be saved as **Needs Review**.
  Invalid/malformed, timed-out, and unavailable responses are not saved as
  proposals; they leave the request **Received** and record failure evidence.
- Clarification leaves the request **Needs Review** and appends an audit event.
  Re-triage after new requester information is outside the initial MVP.
