import React from "react";
import ReactDOM from "react-dom/client";

import { toastDurationFor } from "./toast-duration.js";
import "./style.css";

type Role = "Viewer" | "Manager";
type Toast = {
  id: number;
  type: "error" | "success";
  message: string;
  duration: number;
};
type WorkflowState =
  | "Received"
  | "Triaged"
  | "Draft"
  | "Needs Review"
  | "Approved"
  | "Open"
  | "Rejected"
  | "Merged";

type ProposalStep = {
  action: string;
  done_when: string;
};

type RequestSummary = {
  id: string;
  source: string;
  department_hint: string | null;
  requester_role: string;
  submitted_at: string;
  content: string;
  state: WorkflowState;
  version: number;
  department: string | null;
  priority: string | null;
  confidence: number | null;
  summary: string | null;
  proposed_owner: string | null;
  proposed_steps: ProposalStep[] | null;
  risk_flags: string[] | null;
};

type Relation = {
  id: number;
  from_request_id: string;
  to_request_id: string;
  relation_type: "duplicate_candidate" | "conflict" | "merged_into";
  status: "unresolved" | "resolved";
  reason: string | null;
  created_at: string;
  resolved_at: string | null;
};

type RequestDetail = {
  request: Omit<
    RequestSummary,
    | "state"
    | "version"
    | "department"
    | "priority"
    | "confidence"
    | "summary"
    | "proposed_owner"
    | "proposed_steps"
    | "risk_flags"
  >;
  workflow: { state: WorkflowState; version: number; updated_at: string };
  proposal: {
    department: string;
    priority: string;
    confidence: number;
    summary: string;
    proposed_owner: string;
    proposed_steps: ProposalStep[];
    risk_flags: string[];
    recommended_state: string;
  } | null;
  relations: Relation[];
};

type AuditEntry = {
  id: number;
  actor_role: string;
  action: string;
  from_state: string | null;
  to_state: string | null;
  reason: string | null;
  created_at: string;
};

type Task = {
  id: number;
  request_id: string;
  status: string;
  opened_at: string;
  opened_by: string;
};

async function api<T>(
  path: string,
  role: Role,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("X-Demo-Role", role);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");

  const response = await fetch(path, { ...init, headers });
  const body = (await response.json()) as
    | T
    | { error?: { message?: string; code?: string } };
  if (!response.ok) {
    const errorBody = body as { error?: { message?: string; code?: string } };
    throw new Error(
      errorBody.error?.message ??
        errorBody.error?.code ??
        `Request failed (${response.status})`,
    );
  }
  return body as T;
}

function App() {
  const [role, setRole] = React.useState<Role>("Manager");
  const [stateFilter, setStateFilter] = React.useState("");
  const [departmentFilter, setDepartmentFilter] = React.useState("");
  const [riskFilter, setRiskFilter] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [requests, setRequests] = React.useState<RequestSummary[]>([]);
  const [selectedId, setSelectedId] = React.useState("");
  const [detail, setDetail] = React.useState<RequestDetail | null>(null);
  const [audit, setAudit] = React.useState<AuditEntry[]>([]);
  const [tasks, setTasks] = React.useState<Task[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [toast, setToast] = React.useState<Toast | null>(null);
  const toastId = React.useRef(0);
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [reason, setReason] = React.useState("");
  const [decisionAction, setDecisionAction] = React.useState("approve");
  const [relatedRequestId, setRelatedRequestId] = React.useState("");
  const [editPriority, setEditPriority] = React.useState("");
  const [editOwner, setEditOwner] = React.useState("");
  const [faultMode, setFaultMode] = React.useState("valid");

  const notify = React.useCallback((type: Toast["type"], message: string) => {
    setToast({
      id: ++toastId.current,
      type,
      message,
      duration: toastDurationFor(message),
    });
  }, []);

  React.useEffect(() => {
    if (!toast) return;

    const timeout = window.setTimeout(() => {
      setToast((current) => (current?.id === toast.id ? null : current));
    }, toast.duration);

    return () => window.clearTimeout(timeout);
  }, [toast]);

  React.useEffect(() => {
    let active = true;
    const params = new URLSearchParams();
    if (stateFilter) params.set("state", stateFilter);
    if (departmentFilter) params.set("department", departmentFilter);
    if (riskFilter) params.set("risk", riskFilter);
    if (search.trim()) params.set("q", search.trim());

    setLoading(true);
    api<{ requests: RequestSummary[] }>(
      `/api/requests${params.size > 0 ? `?${params.toString()}` : ""}`,
      role,
    )
      .then(({ requests: rows }) => {
        if (!active) return;
        setRequests(rows);
        setSelectedId((current) =>
          rows.some((item) => item.id === current)
            ? current
            : (rows[0]?.id ?? ""),
        );
      })
      .catch((cause: unknown) => {
        if (active) {
          notify(
            "error",
            cause instanceof Error ? cause.message : String(cause),
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [
    role,
    stateFilter,
    departmentFilter,
    riskFilter,
    search,
    refreshKey,
    notify,
  ]);

  React.useEffect(() => {
    let active = true;
    setDetail(null);
    setRelatedRequestId("");
    if (!selectedId) {
      setAudit([]);
      return () => {
        active = false;
      };
    }

    Promise.all([
      api<RequestDetail>(`/api/requests/${selectedId}`, role),
      api<{ audit: AuditEntry[] }>(`/api/requests/${selectedId}/audit`, role),
      api<{ tasks: Task[] }>("/api/tasks", role),
    ])
      .then(([requestDetail, auditResult, taskResult]) => {
        if (!active) return;
        setDetail(requestDetail);
        setAudit(auditResult.audit);
        setTasks(taskResult.tasks);
      })
      .catch((cause: unknown) => {
        if (active) {
          notify(
            "error",
            cause instanceof Error ? cause.message : String(cause),
          );
        }
      });

    return () => {
      active = false;
    };
  }, [role, selectedId, refreshKey, notify]);

  async function perform(
    label: string,
    action: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await action();
      setReason("");
      notify("success", label);
      setRefreshKey((value) => value + 1);
    } catch (cause) {
      notify(
        "error",
        cause instanceof Error ? cause.message : String(cause),
      );
    }
  }

  function submitDecision(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detail || role !== "Manager") return;

    const body: Record<string, unknown> = {
      action: decisionAction,
      reason,
      expected_version: detail.workflow.version,
    };
    if (decisionAction === "merge") {
      body.target_request_id =
        unresolvedDuplicate && relatedRequestId === unresolvedDuplicate.id
          ? relatedRequestId
          : unresolvedDuplicate?.id;
    }
    if (decisionAction === "resolve_conflict") {
      body.related_request_id =
        unresolvedConflict && relatedRequestId === unresolvedConflict.id
          ? relatedRequestId
          : unresolvedConflict?.id;
    }
    if (decisionAction === "edit") {
      const patch: Record<string, string> = {};
      if (editPriority) patch.priority = editPriority;
      if (editOwner.trim()) patch.proposed_owner = editOwner.trim();
      body.patch = patch;
    }
    void perform("Decision saved", () =>
      api(`/api/requests/${selectedId}/decisions`, role, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
  }

  const linkedRequests = detail?.relations.map((relation) => ({
    relation,
    id:
      relation.from_request_id === selectedId
        ? relation.to_request_id
        : relation.from_request_id,
  })) ?? [];
  const unresolvedDuplicate = linkedRequests.find(
    ({ relation }) =>
      relation.relation_type === "duplicate_candidate" &&
      relation.status === "unresolved",
  );
  const unresolvedConflict = linkedRequests.find(
    ({ relation }) =>
      relation.relation_type === "conflict" && relation.status === "unresolved",
  );

  return (
    <main className="console">
      <header className="topbar">
        <div>
          <p className="eyebrow">Delements assessment</p>
          <h1>AI Triage Console</h1>
          <p className="subtitle">
            Review incoming requests, routing proposals, and audit evidence.
          </p>
        </div>
        <div className="topbar-actions">
          <span className="api-status" role="status">Local API</span>
          <label className="role-control">
            Demo role
            <select
              value={role}
              onChange={(event) => setRole(event.target.value as Role)}
            >
              <option>Manager</option>
              <option>Viewer</option>
            </select>
          </label>
          {role === "Manager" && (
            <button
              className="primary"
              onClick={() =>
                void perform("Baseline import complete", () =>
                  api("/api/imports/baseline", role, {
                    method: "POST",
                    body: "{}",
                  }),
                )
              }
            >
              Import baseline
            </button>
          )}
        </div>
      </header>

      {toast && (
        <div className="toast-container">
          <div
            key={toast.id}
            className={`toast toast-${toast.type}`}
            role={toast.type === "error" ? "alert" : "status"}
            style={{ "--toast-duration": `${toast.duration}ms` } as React.CSSProperties}
          >
            <p>{toast.message}</p>
            <button
              aria-label="Dismiss notification"
              className="toast-dismiss"
              onClick={() => setToast(null)}
            >
              ×
            </button>
            <span className="toast-progress" aria-hidden="true" />
          </div>
        </div>
      )}

      <section className="filters" aria-label="Request filters">
        <label>
          Search
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="ID, request text, or summary"
          />
        </label>
        <label>
          Workflow
          <select value={stateFilter} onChange={(event) => setStateFilter(event.target.value)}>
            <option value="">All states</option>
            {["Received", "Triaged", "Draft", "Needs Review", "Approved", "Open", "Rejected", "Merged"].map(
              (state) => <option key={state}>{state}</option>,
            )}
          </select>
        </label>
        <label>
          Department
          <select
            value={departmentFilter}
            onChange={(event) => setDepartmentFilter(event.target.value)}
          >
            <option value="">All departments</option>
            {[
              "IT", "Marketing", "E-commerce", "Customer Service", "SCM",
              "Finance", "HR", "Production", "Needs Review",
            ].map((department) => <option key={department}>{department}</option>)}
          </select>
        </label>
        <label>
          Risk flag
          <select value={riskFilter} onChange={(event) => setRiskFilter(event.target.value)}>
            <option value="">All risks</option>
            {["duplicate", "conflict", "security", "privacy", "missing-information"].map(
              (risk) => <option key={risk}>{risk}</option>,
            )}
          </select>
        </label>
      </section>

      <div className="workspace">
        <section className="request-list" aria-labelledby="requests-heading">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Work queue</p>
              <h2 id="requests-heading">Requests <span>{requests.length}</span></h2>
            </div>
            {loading && <span className="muted">Loading…</span>}
          </div>
          {requests.length === 0 && !loading ? (
            <div className="empty-state">
              <strong>No requests found</strong>
              <p>Import the baseline or adjust the filters.</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>ID / request</th><th>Routing</th><th>State</th></tr>
                </thead>
                <tbody>
                  {requests.map((item) => (
                    <tr
                      key={item.id}
                      className={selectedId === item.id ? "selected" : ""}
                      onClick={() => setSelectedId(item.id)}
                    >
                      <td>
                        <button className="request-link" onClick={() => setSelectedId(item.id)}>
                          {item.id}
                        </button>
                        <p className="row-summary">{item.summary ?? item.content}</p>
                      </td>
                      <td>
                        <span>{item.department ?? item.department_hint ?? "Unassigned"}</span>
                        {item.confidence !== null && (
                          <small>{Math.round(item.confidence * 100)}% confidence</small>
                        )}
                      </td>
                      <td><span className={`state state-${item.state.toLowerCase().replaceAll(" ", "-")}`}>{item.state}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="detail-panel" aria-label="Request detail">
          {!detail ? (
            <div className="empty-state"><p>Select a request to review its details.</p></div>
          ) : (
            <>
              <div className="detail-heading">
                <div>
                  <p className="eyebrow">Request detail</p>
                  <h2>{detail.request.id}</h2>
                </div>
                <span className={`state state-${detail.workflow.state.toLowerCase().replaceAll(" ", "-")}`}>
                  {detail.workflow.state}
                </span>
              </div>
              <div className="meta-line">
                <span>{detail.request.source}</span>
                <span>{detail.request.requester_role}</span>
                <span>Version {detail.workflow.version}</span>
              </div>
              <article className="content-card">
                <h3>Original request</h3>
                <p className="request-content">{detail.request.content}</p>
              </article>

              {detail.proposal ? (
                <article className="content-card proposal-card">
                  <div className="card-title">
                    <h3>Routing proposal</h3>
                    <span>{Math.round(detail.proposal.confidence * 100)}% confidence</span>
                  </div>
                  <p>{detail.proposal.summary}</p>
                  <dl className="proposal-meta">
                    <div><dt>Department</dt><dd>{detail.proposal.department}</dd></div>
                    <div><dt>Priority</dt><dd>{detail.proposal.priority}</dd></div>
                    <div><dt>Proposed owner</dt><dd>{detail.proposal.proposed_owner}</dd></div>
                  </dl>
                  <h4>Suggested steps</h4>
                  <ol className="proposal-steps">
                    {detail.proposal.proposed_steps.map((step, index) => (
                      <li key={index}>
                        <span>{step.action}</span>
                        <small>Done when: {step.done_when}</small>
                      </li>
                    ))}
                  </ol>
                  <div className="risk-list">
                    {detail.proposal.risk_flags.length > 0
                      ? detail.proposal.risk_flags.map((risk) => <span className="risk" key={risk}>{risk}</span>)
                      : <span className="muted">No risk flags</span>}
                  </div>
                </article>
              ) : (
                <article className="content-card no-proposal">
                  <h3>No proposal yet</h3>
                  <p>Run triage to create a validated routing proposal.</p>
                  {role === "Manager" && detail.workflow.state === "Received" && (
                    <div className="inline-action">
                      <button
                        className="primary"
                        onClick={() =>
                          void perform("Triage completed", () =>
                            api(`/api/requests/${selectedId}/triage`, role, {
                              method: "POST",
                              body: JSON.stringify({ mode: faultMode }),
                            }),
                          )
                        }
                      >
                        Run triage
                      </button>
                      <label>
                        Demo response
                        <select value={faultMode} onChange={(event) => setFaultMode(event.target.value)}>
                          <option value="valid">Valid response</option>
                          <option value="malformed">Malformed output</option>
                          <option value="timeout">Timeout</option>
                          <option value="unavailable">Unavailable</option>
                          <option value="low_confidence">Low confidence</option>
                        </select>
                      </label>
                    </div>
                  )}
                </article>
              )}

              {linkedRequests.length > 0 && (
                <article className="content-card">
                  <h3>Related requests</h3>
                  <ul className="relations">
                    {linkedRequests.map(({ relation, id }) => (
                      <li key={relation.id}>
                        <button className="text-button" onClick={() => setSelectedId(id)}>{id}</button>
                        <span>{relation.relation_type.replaceAll("_", " ")}</span>
                        <span className={`relation-status ${relation.status}`}>{relation.status}</span>
                      </li>
                    ))}
                  </ul>
                </article>
              )}

              {role === "Manager" && (
                <form className="decision-card" onSubmit={submitDecision}>
                  <div className="card-title">
                    <h3>Manager actions</h3>
                    <span>Version {detail.workflow.version}</span>
                  </div>
                  {detail.workflow.state === "Received" && (
                    <p className="muted">Run triage before making a workflow decision.</p>
                  )}
                  {detail.workflow.state !== "Received" && !["Rejected", "Merged", "Open"].includes(detail.workflow.state) && (
                    <>
                      <label>
                        Decision
                        <select value={decisionAction} onChange={(event) => setDecisionAction(event.target.value)}>
                          <option value="approve">Approve and create task</option>
                          <option value="reject">Reject</option>
                          <option value="request_clarification">Request clarification</option>
                          <option value="edit">Edit proposal</option>
                          {unresolvedDuplicate && <option value="merge">Merge duplicate</option>}
                          {unresolvedConflict && <option value="resolve_conflict">Resolve conflict</option>}
                        </select>
                      </label>
                      {decisionAction === "merge" && unresolvedDuplicate && (
                        <label>
                          Merge into
                          <select value={relatedRequestId || unresolvedDuplicate.id} onChange={(event) => setRelatedRequestId(event.target.value)}>
                            <option value={unresolvedDuplicate.id}>{unresolvedDuplicate.id}</option>
                          </select>
                        </label>
                      )}
                      {decisionAction === "resolve_conflict" && unresolvedConflict && (
                        <label>
                          Related request
                          <select value={relatedRequestId || unresolvedConflict.id} onChange={(event) => setRelatedRequestId(event.target.value)}>
                            <option value={unresolvedConflict.id}>{unresolvedConflict.id}</option>
                          </select>
                        </label>
                      )}
                      {decisionAction === "edit" && (
                        <div className="edit-fields">
                          <label>
                            Priority
                            <select value={editPriority} onChange={(event) => setEditPriority(event.target.value)}>
                              <option value="">Keep current</option>
                              {["Critical", "High", "Medium", "Low"].map((priority) => <option key={priority}>{priority}</option>)}
                            </select>
                          </label>
                          <label>
                            Proposed owner
                            <input value={editOwner} onChange={(event) => setEditOwner(event.target.value)} placeholder={detail.proposal?.proposed_owner ?? "Owner"} />
                          </label>
                        </div>
                      )}
                      <label>
                        Reason
                        <textarea
                          value={reason}
                          onChange={(event) => setReason(event.target.value)}
                          required
                          minLength={1}
                          placeholder="Record the review rationale"
                        />
                      </label>
                      <button
                        className="primary"
                        type="submit"
                        disabled={
                          !detail.proposal ||
                          !reason.trim() ||
                          (decisionAction === "edit" && !editPriority && !editOwner.trim())
                        }
                      >
                        Submit decision
                      </button>
                    </>
                  )}
                  {["Rejected", "Merged", "Open"].includes(detail.workflow.state) && (
                    <p className="muted">This request is in a terminal or task state.</p>
                  )}
                </form>
              )}

              <section className="content-card audit-card">
                <h3>Audit timeline</h3>
                {audit.length === 0 ? <p className="muted">No audit events recorded.</p> : (
                  <ol className="timeline">
                    {audit.map((entry) => (
                      <li key={entry.id}>
                        <div className="timeline-head">
                          <strong>{entry.action}</strong>
                          <time>{new Date(entry.created_at).toLocaleString()}</time>
                        </div>
                        <p>{entry.from_state ?? "—"} → {entry.to_state ?? "—"} · {entry.actor_role}</p>
                        {entry.reason && <p className="audit-reason">{entry.reason}</p>}
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </>
          )}
        </section>
      </div>

      <section className="tasks-card">
        <div className="section-heading">
          <div><p className="eyebrow">Approved work</p><h2>Open tasks <span>{tasks.length}</span></h2></div>
        </div>
        {tasks.length === 0 ? <p className="muted">Approval creates an open task.</p> : (
          <div className="task-list">
            {tasks.map((task) => (
              <button key={task.id} onClick={() => setSelectedId(task.request_id)}>
                <strong>{task.request_id}</strong><span>{task.status}</span>
              </button>
            ))}
          </div>
        )}
      </section>
      <footer>Request text is untrusted input. Workflow policy and authorization are enforced by the API.</footer>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
