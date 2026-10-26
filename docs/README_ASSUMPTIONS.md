# Fixture assumptions (candidate-authored)

The recruiter explicitly authorized candidates to create the 12-record fixture and deterministic mock AI response map. These files are synthetic and **not provided by Delements**. The PDF is the requirements source; fixture content, mock scores, dates, owners, and thresholds are implementation assumptions.

- Request IDs are exactly REQ-001 through REQ-012. CSV columns: `id, source, department_hint, requester_role, submitted_at, content`. Source requests must be preserved on repeated import.
- Sources (`chat`, `email`, `form`), department hints, and timestamps are fabricated. No real customer or employee details are used.
- REQ-002 is a duplicate **candidate** of REQ-001, not automatically merged. REQ-003 and REQ-004 conflict and both remain Needs Review until a Manager resolves the conflict with a recorded reason.
- REQ-005 lacks sufficient routing context; the proposed confidence threshold is **0.70** (confidence below threshold => Needs Review). Clarification must be recorded in audit.
- REQ-006 has security/privacy flags and role-based ownership; no customer data is embedded. REQ-007 includes prompt injection as *untrusted input*; the application must never treat it as an instruction.
- REQ-008 through REQ-012 are normal routing cases. `department_hint` is an untrusted hint, not a definitive classifier output.
- The mock response map is a **test oracle / adapter fixture**, not a source of workflow authority. Never let `recommended_state` become `Approved` or `Open`; Manager-only transitions must be enforced server-side.
- `scenario_metadata` provides explicit relationship expectations for the mock adapter/test harness; it is not part of the required AI proposal schema. `fault_injection` cases are alternate responses, not additional source requests.
- The PDF permits role switches without real authentication; in a production system, identity would be verified. For the assessment, seeded local roles are used and server-side authorization is mandatory.
- The recruiter clarified that no GitHub reviewer account is needed before submission; confirm how repository access should be granted at handoff.

## Mock behavior assumptions

The default mode returns a fixed proposal by request ID. The adapter must validate proposals before persisting/rendering. `malformed` is deliberately invalid JSON/schema; `timeout` and `unavailable` simulate errors; `low_confidence` returns the REQ-005 proposal. The application should record failure/retry state and audit, never create an Open task from a failed AI response.

## Decisions for implementation

- Conflict resolution changes only the relation status and records the Manager's
  reason; it does not approve either request. Each request must be approved
  separately after blockers are cleared.
- A Manager merge marks the source request `Merged`, leaves the target in its
  prior state, and preserves both original request rows. Require a reason and
  reject self-merges, cycles, and terminal targets.
- Require a non-empty reason for reject, merge, clarification, and conflict
  resolution. Record approval rationale, especially for security/privacy risks.
- Save a low-confidence proposal only after schema validation and route it to
  `Needs Review`. For malformed, timeout, or unavailable responses, save no
  proposal; leave the request `Received` and record a failed attempt and audit
  evidence.

These decisions are specified in [ARCHITECTURE.md](./ARCHITECTURE.md) and
[IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md).
