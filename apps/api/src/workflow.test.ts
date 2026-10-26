import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "./database.js";
import { importSourceRequests } from "./import-service.js";
import { buildServer } from "./server.js";
import { applyDecision } from "./workflow-service.js";
import { seedFixtureRelations } from "./workflow-service.js";

const sourceCsv = readFileSync(
  new URL("../../../fixtures/assessment_requests.csv", import.meta.url),
  "utf8",
);
const fixturePath = fileURLToPath(
  new URL("../../../fixtures/mock-ai-responses.json", import.meta.url),
);

describe("workflow decisions, relations, and audit", () => {
  let app: ReturnType<typeof buildServer>;
  let database: DatabaseSync;

  beforeEach(() => {
    database = openDatabase(":memory:");
    importSourceRequests(database, sourceCsv);
    seedFixtureRelations(database, fixturePath);
    app = buildServer({ database });
  });

  afterEach(async () => {
    await app.close();
  });

  async function triage(requestId: string) {
    return app.inject({
      method: "POST",
      url: `/api/requests/${requestId}/triage`,
      headers: { "x-demo-role": "Manager" },
      payload: {},
    });
  }

  async function decide(
    requestId: string,
    decision: Record<string, unknown>,
    role = "Manager",
  ) {
    return app.inject({
      method: "POST",
      url: `/api/requests/${requestId}/decisions`,
      headers: { "x-demo-role": role },
      payload: decision,
    });
  }

  function getWorkflow(requestId: string) {
    return database
      .prepare(
        "SELECT state, version FROM request_workflows WHERE request_id = ?",
      )
      .get(requestId);
  }

  it("seeds explicit duplicate and canonical conflict relations idempotently", () => {
    seedFixtureRelations(database, fixturePath);

    expect(
      database
        .prepare(
          `SELECT from_request_id, to_request_id, relation_type, status
           FROM request_relations ORDER BY relation_type`,
        )
        .all(),
    ).toEqual([
      {
        from_request_id: "REQ-003",
        to_request_id: "REQ-004",
        relation_type: "conflict",
        status: "unresolved",
      },
      {
        from_request_id: "REQ-002",
        to_request_id: "REQ-001",
        relation_type: "duplicate_candidate",
        status: "unresolved",
      },
    ]);
  });

  it("requires Manager authorization in both route and decision service", async () => {
    const triaged = await triage("REQ-008");
    expect(triaged.statusCode).toBe(200);

    const viewer = await decide(
      "REQ-008",
      { action: "reject", reason: "Not needed", expected_version: 1 },
      "Viewer",
    );

    expect(viewer.statusCode).toBe(403);
    expect(viewer.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(getWorkflow("REQ-008")).toEqual({ state: "Draft", version: 1 });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE request_id = ?")
        .get("REQ-008"),
    ).toEqual({ count: 1 });

    expect(() =>
      applyDecision(
        database,
        "REQ-008",
        "Viewer",
        {
          action: "reject",
          reason: "Direct service call",
          expected_version: 1,
        },
      ),
    ).toThrowError(
      expect.objectContaining({
        statusCode: 403,
        code: "FORBIDDEN",
      }),
    );
  });

  it("validates decisions and requires reason and version values", async () => {
    const emptyReason = await decide("REQ-008", {
      action: "reject",
      reason: "  ",
      expected_version: 1,
    });
    const missingVersion = await decide("REQ-008", {
      action: "approve",
      reason: "Reviewed",
    });
    const untrustedField = await decide("REQ-008", {
      action: "approve",
      reason: "Reviewed",
      expected_version: 1,
      state: "Open",
    });
    const invalidPatch = await decide("REQ-008", {
      action: "edit",
      reason: "Adjust proposal",
      expected_version: 1,
      patch: { recommended_state: "Open" },
    });

    expect(emptyReason.statusCode).toBe(400);
    expect(missingVersion.statusCode).toBe(400);
    expect(untrustedField.statusCode).toBe(400);
    expect(invalidPatch.statusCode).toBe(400);
    expect(getWorkflow("REQ-008")).toEqual({ state: "Received", version: 0 });
  });

  it("blocks approval without a proposal and rejects stale versions", async () => {
    const noProposal = await decide("REQ-008", {
      action: "approve",
      reason: "Reviewed",
      expected_version: 0,
    });
    expect(noProposal.statusCode).toBe(409);
    expect(noProposal.json()).toMatchObject({
      error: { code: "INVALID_TRANSITION" },
    });

    await triage("REQ-008");
    const stale = await decide("REQ-008", {
      action: "approve",
      reason: "Reviewed",
      expected_version: 0,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      error: { code: "STALE_VERSION" },
    });
    expect(getWorkflow("REQ-008")).toEqual({ state: "Draft", version: 1 });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM tasks").get(),
    ).toEqual({ count: 0 });
  });

  it("approves atomically, opens one task, and records ordered audit transitions", async () => {
    await triage("REQ-008");

    const approval = await decide("REQ-008", {
      action: "approve",
      reason: "Scope and owner verified",
      expected_version: 1,
    });

    expect(approval.statusCode).toBe(200);
    expect(approval.json()).toMatchObject({
      request_id: "REQ-008",
      state: "Open",
      version: 2,
      task_id: 1,
    });
    expect(getWorkflow("REQ-008")).toEqual({ state: "Open", version: 2 });
    expect(
      database
        .prepare("SELECT request_id, status, opened_by FROM tasks")
        .all(),
    ).toEqual([{ request_id: "REQ-008", status: "Open", opened_by: "Manager" }]);

    const tasksResponse = await app.inject({
      method: "GET",
      url: "/api/tasks",
      headers: { "x-demo-role": "Viewer" },
    });
    expect(tasksResponse.statusCode).toBe(200);
    expect(tasksResponse.json()).toMatchObject({
      tasks: [
        {
          id: 1,
          request_id: "REQ-008",
          status: "Open",
          opened_by: "Manager",
        },
      ],
    });

    const auditResponse = await app.inject({
      method: "GET",
      url: "/api/requests/REQ-008/audit",
      headers: { "x-demo-role": "Viewer" },
    });
    expect(auditResponse.statusCode).toBe(200);
    expect(auditResponse.json().audit.slice(-2)).toMatchObject([
      {
        action: "approve",
        from_state: "Draft",
        to_state: "Approved",
        reason: "Scope and owner verified",
      },
      {
        action: "task_opened",
        from_state: "Approved",
        to_state: "Open",
        reason: "Scope and owner verified",
      },
    ]);

    const repeated = await decide("REQ-008", {
      action: "approve",
      reason: "Duplicate submission",
      expected_version: 2,
    });
    expect(repeated.statusCode).toBe(409);
    expect(getWorkflow("REQ-008")).toEqual({ state: "Open", version: 2 });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM tasks").get(),
    ).toEqual({ count: 1 });
  });

  it("rolls back state and task changes when audit persistence fails", async () => {
    await triage("REQ-008");
    database.exec(`
      CREATE TRIGGER reject_task_audit
      BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'task_opened'
      BEGIN
        SELECT RAISE(ABORT, 'simulated audit write failure');
      END;
    `);

    const response = await decide("REQ-008", {
      action: "approve",
      reason: "Test audit transaction",
      expected_version: 1,
    });

    expect(response.statusCode).toBe(500);
    expect(getWorkflow("REQ-008")).toEqual({ state: "Draft", version: 1 });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM tasks").get(),
    ).toEqual({ count: 0 });
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM audit_logs WHERE request_id = ?",
        )
        .get("REQ-008"),
    ).toEqual({ count: 1 });
  });

  it("rejects a request with reason and appends immutable audit evidence", async () => {
    await triage("REQ-010");

    const response = await decide("REQ-010", {
      action: "reject",
      reason: "The reported condition is not reproducible in the test queue",
      expected_version: 1,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      state: "Rejected",
      version: 2,
    });
    expect(getWorkflow("REQ-010")).toEqual({ state: "Rejected", version: 2 });
    expect(
      database
        .prepare(
          "SELECT action, from_state, to_state, reason FROM audit_logs WHERE request_id = ? ORDER BY id DESC LIMIT 1",
        )
        .get("REQ-010"),
    ).toEqual({
      action: "reject",
      from_state: "Draft",
      to_state: "Rejected",
      reason: "The reported condition is not reproducible in the test queue",
    });
  });

  it("allows proposal edits only through the validated schema and audits changed fields", async () => {
    await triage("REQ-008");

    const response = await decide("REQ-008", {
      action: "edit",
      patch: {
        priority: "High",
        proposed_owner: "Marketing Operations",
        risk_flags: ["privacy"],
      },
      reason: "Updated scope indicates a privacy review is needed",
      expected_version: 1,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      state: "Needs Review",
      version: 2,
    });
    expect(
      database
        .prepare(
          "SELECT priority, proposed_owner, risk_flags_json FROM proposals WHERE request_id = ?",
        )
        .get("REQ-008"),
    ).toEqual({
      priority: "High",
      proposed_owner: "Marketing Operations",
      risk_flags_json: '["privacy"]',
    });
    expect(
      database
        .prepare(
          "SELECT action, details_json FROM audit_logs WHERE request_id = ? ORDER BY id DESC LIMIT 1",
        )
        .get("REQ-008"),
    ).toEqual({
      action: "edit_proposal",
      details_json:
        '{"changed_fields":["priority","proposed_owner","risk_flags"]}',
    });
  });

  it("requests clarification only in Needs Review and retains that state", async () => {
    await triage("REQ-005");

    const response = await decide("REQ-005", {
      action: "request_clarification",
      reason: "Please identify the affected application and business impact",
      expected_version: 1,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      state: "Needs Review",
      version: 2,
    });
    expect(
      database
        .prepare(
          "SELECT action, from_state, to_state FROM audit_logs WHERE request_id = ? ORDER BY id DESC LIMIT 1",
        )
        .get("REQ-005"),
    ).toEqual({
      action: "clarification_requested",
      from_state: "Needs Review",
      to_state: "Needs Review",
    });
  });

  it("requires matching conflict and both requests in review, then resolves without approval", async () => {
    await triage("REQ-003");
    await triage("REQ-004");

    const blockedApproval = await decide("REQ-003", {
      action: "approve",
      reason: "Proceed",
      expected_version: 1,
    });
    expect(blockedApproval.statusCode).toBe(409);
    expect(blockedApproval.json()).toMatchObject({
      error: { code: "UNRESOLVED_BLOCKER" },
    });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM tasks").get(),
    ).toEqual({ count: 0 });

    const resolution = await decide("REQ-004", {
      action: "resolve_conflict",
      related_request_id: "REQ-003",
      reason: "Security review will precede any pixel deployment",
      expected_version: 1,
    });
    expect(resolution.statusCode).toBe(200);
    expect(resolution.json()).toMatchObject({
      request_id: "REQ-004",
      state: "Needs Review",
      version: 2,
      related_request_id: "REQ-003",
      related_state: "Needs Review",
      related_version: 2,
    });
    expect(getWorkflow("REQ-003")).toEqual({
      state: "Needs Review",
      version: 2,
    });
    expect(getWorkflow("REQ-004")).toEqual({
      state: "Needs Review",
      version: 2,
    });
    expect(
      database
        .prepare(
          "SELECT status, reason FROM request_relations WHERE relation_type = 'conflict'",
        )
        .get(),
    ).toEqual({
      status: "resolved",
      reason: "Security review will precede any pixel deployment",
    });
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'resolve_conflict'",
        )
        .get(),
    ).toEqual({ count: 2 });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM tasks").get(),
    ).toEqual({ count: 0 });
  });

  it("rejects conflict resolution without an unresolved relation or review states", async () => {
    await triage("REQ-003");
    const missingRelation = await decide("REQ-003", {
      action: "resolve_conflict",
      related_request_id: "REQ-001",
      reason: "No matching fixture relation",
      expected_version: 1,
    });
    expect(missingRelation.statusCode).toBe(409);

    const wrongState = await decide("REQ-003", {
      action: "resolve_conflict",
      related_request_id: "REQ-004",
      reason: "Other request is not yet triaged",
      expected_version: 1,
    });
    expect(wrongState.statusCode).toBe(409);
    expect(
      database
        .prepare(
          "SELECT status FROM request_relations WHERE relation_type = 'conflict'",
        )
        .get(),
    ).toEqual({ status: "unresolved" });
  });

  it("merges only the duplicate source, preserves both requests, and resolves its blocker", async () => {
    await triage("REQ-001");
    await triage("REQ-002");

    const blockedTarget = await decide("REQ-001", {
      action: "approve",
      reason: "Duplicate candidate is unresolved",
      expected_version: 1,
    });
    expect(blockedTarget.statusCode).toBe(409);
    expect(blockedTarget.json()).toMatchObject({
      error: { code: "UNRESOLVED_BLOCKER" },
    });

    const wrongTarget = await decide("REQ-002", {
      action: "merge",
      target_request_id: "REQ-003",
      reason: "Try a different target",
      expected_version: 1,
    });
    expect(wrongTarget.statusCode).toBe(409);
    expect(getWorkflow("REQ-002")).toEqual({
      state: "Needs Review",
      version: 1,
    });

    const response = await decide("REQ-002", {
      action: "merge",
      target_request_id: "REQ-001",
      reason: "Same checkout incident",
      expected_version: 1,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      state: "Merged",
      version: 2,
      target_request_id: "REQ-001",
    });
    expect(getWorkflow("REQ-002")).toEqual({ state: "Merged", version: 2 });
    expect(getWorkflow("REQ-001")).toEqual({ state: "Draft", version: 1 });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM requests WHERE id IN (?, ?)")
        .get("REQ-001", "REQ-002"),
    ).toEqual({ count: 2 });
    expect(
      database
        .prepare(
          "SELECT relation_type, status, reason FROM request_relations WHERE from_request_id = ? ORDER BY relation_type",
        )
        .all("REQ-002"),
    ).toEqual([
      {
        relation_type: "duplicate_candidate",
        status: "resolved",
        reason: "Same checkout incident",
      },
      {
        relation_type: "merged_into",
        status: "resolved",
        reason: "Same checkout incident",
      },
    ]);

    const targetApproval = await decide("REQ-001", {
      action: "approve",
      reason: "Merge resolved the duplicate candidate",
      expected_version: 1,
    });
    expect(targetApproval.statusCode).toBe(200);
  });

  it("prevents self-merge, terminal targets, and merge cycles", async () => {
    await triage("REQ-002");
    await triage("REQ-001");

    const selfMerge = await decide("REQ-002", {
      action: "merge",
      target_request_id: "REQ-002",
      reason: "Self merge",
      expected_version: 1,
    });
    expect(selfMerge.statusCode).toBe(400);

    database
      .prepare(
        `INSERT INTO request_relations (
          from_request_id, to_request_id, relation_type, status,
          reason, created_at, resolved_at
        ) VALUES ('REQ-001', 'REQ-002', 'merged_into', 'resolved', 'test', ?, ?)`,
      )
      .run("2026-10-26T00:00:00.000Z", "2026-10-26T00:00:00.000Z");
    const cycle = await decide("REQ-002", {
      action: "merge",
      target_request_id: "REQ-001",
      reason: "Would create a cycle",
      expected_version: 1,
    });
    expect(cycle.statusCode).toBe(409);
    expect(getWorkflow("REQ-002")).toEqual({
      state: "Needs Review",
      version: 1,
    });

    database
      .prepare(
        "UPDATE request_workflows SET state = 'Rejected' WHERE request_id = 'REQ-003'",
      )
      .run();
    const terminalTarget = await decide("REQ-002", {
      action: "merge",
      target_request_id: "REQ-003",
      reason: "Terminal target",
      expected_version: 1,
    });
    expect(terminalTarget.statusCode).toBe(409);
  });

  it("exposes audit and tasks to readers and hides them from unknown roles", async () => {
    const viewerAudit = await app.inject({
      method: "GET",
      url: "/api/requests/REQ-001/audit",
      headers: { "x-demo-role": "Viewer" },
    });
    const unknownRoleAudit = await app.inject({
      method: "GET",
      url: "/api/requests/REQ-001/audit",
      headers: { "x-demo-role": "Unknown" },
    });
    const viewerTasks = await app.inject({
      method: "GET",
      url: "/api/tasks",
      headers: { "x-demo-role": "Viewer" },
    });
    const missingRequestAudit = await app.inject({
      method: "GET",
      url: "/api/requests/REQ-099/audit",
      headers: { "x-demo-role": "Manager" },
    });

    expect(viewerAudit.statusCode).toBe(200);
    expect(viewerAudit.json()).toEqual({ request_id: "REQ-001", audit: [] });
    expect(unknownRoleAudit.statusCode).toBe(403);
    expect(viewerTasks.statusCode).toBe(200);
    expect(viewerTasks.json()).toEqual({ tasks: [] });
    expect(missingRequestAudit.statusCode).toBe(404);
  });
});
