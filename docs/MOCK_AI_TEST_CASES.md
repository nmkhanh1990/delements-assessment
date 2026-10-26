# Deterministic test scenarios

| ID | Input | Expected assertions |
|---|---|---|
| S1 | REQ-001 and REQ-002 | Duplicate candidate flagged; only Manager may merge REQ-002 into REQ-001; both original source IDs remain in storage; importing CSV twice yields 12 unique requests. |
| S2 | REQ-003 and REQ-004 | Both Needs Review; conflict relation present; neither creates an Open task before authorized Manager resolution; audit records decision reason. |
| S3 | REQ-005 | Confidence 0.35, missing-information flag, Needs Review; clarification event appears in audit. |
| S4 | REQ-006 | Security/privacy risk flags, authorized-role owner proposal; no customer PII. |
| S5 | REQ-007 | Prompt injection ignored; no unauthorized Approved/Open transition; Viewer mutation denied; all transitions audited. |
| F1 | fault_injection.malformed | Validation fails safely, no malformed proposal persisted and no Open task created. |
| F2 | fault_injection.timeout | Timeout handled safely, error/retry evidence recorded, no Open task created. |
| F3 | fault_injection.unavailable | Service failure handled without a paid key or network call. |
| F4 | fault_injection.low_confidence | Needs Review, not Open. |
| RBAC | Viewer vs Manager | Viewer can read but all mutating endpoints reject Viewer server-side; Manager decisions succeed with audit evidence. |

## Suggested adapter API

`analyze(request, { mode = "valid" })`: look up `responses[request.id]` in valid mode; override with `fault_injection[mode]` in test mode. Keep scenario metadata separate from the proposal. Validate using a strict schema before persistence.

## Demo sequence

Import twice; verify 12 unique IDs; inspect REQ-002 duplicate; Manager merge into REQ-001; inspect conflict REQ-003/004; record clarification for REQ-005; inspect REQ-006 risks; attempt REQ-007 injection and Viewer mutation; inject malformed/timeout; inspect audit history.
