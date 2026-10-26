import type { DatabaseSync } from "node:sqlite";
import type { Proposal, MockAiMode } from "./mock-ai-schema.js";
import {
  analyzeRequest,
  loadMockAiFixture,
  MockAiError,
} from "./mock-ai-adapter.js";

type WorkflowRow = {
  state: string;
  version: number;
};

export class TriageServiceError extends Error {
  constructor(
    readonly statusCode: 404 | 409 | 422 | 503,
    readonly code:
      | "NOT_FOUND"
      | "INVALID_TRANSITION"
      | "AI_OUTPUT_INVALID"
      | "AI_TIMEOUT"
      | "AI_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "TriageServiceError";
  }
}

export type TriageResult = {
  request_id: string;
  state: "Draft" | "Needs Review";
  proposal: Proposal;
};

function beginTransaction(database: DatabaseSync) {
  database.exec("BEGIN IMMEDIATE");
}

function rollbackTransaction(database: DatabaseSync) {
  database.exec("ROLLBACK");
}

function getWorkflow(database: DatabaseSync, requestId: string) {
  return database
    .prepare(
      `SELECT workflow.state, workflow.version
       FROM request_workflows AS workflow
       JOIN requests ON requests.id = workflow.request_id
       WHERE workflow.request_id = ?`,
    )
    .get(requestId) as WorkflowRow | undefined;
}

function ensureReceivedState(database: DatabaseSync, requestId: string) {
  const workflow = getWorkflow(database, requestId);
  if (workflow === undefined) {
    throw new TriageServiceError(
      404,
      "NOT_FOUND",
      `Request ${requestId} was not found`,
    );
  }
  if (workflow.state !== "Received") {
    throw new TriageServiceError(
      409,
      "INVALID_TRANSITION",
      `Request ${requestId} cannot be triaged from state ${workflow.state}`,
    );
  }
  return workflow;
}

function recordFailure(
  database: DatabaseSync,
  requestId: string,
  error: MockAiError,
  createdAt: string,
) {
  beginTransaction(database);
  try {
    ensureReceivedState(database, requestId);
    database
      .prepare(
        `INSERT INTO triage_attempts (request_id, outcome, error_code, created_at)
         VALUES (?, 'failed', ?, ?)`,
      )
      .run(requestId, error.code, createdAt);
    database
      .prepare(
        `INSERT INTO audit_logs (
          request_id, actor_role, action, from_state, to_state,
          reason, details_json, created_at
        ) VALUES (?, 'Manager', 'triage_failed', 'Received', 'Received', ?, ?, ?)`,
      )
      .run(
        requestId,
        error.message,
        JSON.stringify({ error_code: error.code }),
        createdAt,
      );
    database.exec("COMMIT");
  } catch (failure) {
    rollbackTransaction(database);
    throw failure;
  }
}

function resolveState(
  database: DatabaseSync,
  requestId: string,
  proposal: Proposal,
): "Draft" | "Needs Review" {
  const unresolvedConflict = database
    .prepare(
      `SELECT 1
       FROM request_relations
       WHERE relation_type = 'conflict'
         AND status = 'unresolved'
         AND (from_request_id = ? OR to_request_id = ?)
       LIMIT 1`,
    )
    .get(requestId, requestId);

  if (
    proposal.confidence < 0.7 ||
    proposal.risk_flags.length > 0 ||
    proposal.department === "Needs Review" ||
    unresolvedConflict !== undefined
  ) {
    return "Needs Review";
  }

  return proposal.recommended_state;
}

export async function triageRequest(
  database: DatabaseSync,
  fixturePath: string,
  requestId: string,
  mode: MockAiMode,
  createdAt = new Date().toISOString(),
): Promise<TriageResult> {
  ensureReceivedState(database, requestId);
  const fixture = loadMockAiFixture(fixturePath);

  let proposal: Proposal;
  try {
    proposal = await analyzeRequest(fixture, requestId, mode);
  } catch (error) {
    if (error instanceof MockAiError) {
      recordFailure(database, requestId, error, createdAt);
      const statusCode = error.code === "AI_OUTPUT_INVALID" ? 422 : 503;
      throw new TriageServiceError(statusCode, error.code, error.message);
    }
    throw error;
  }

  beginTransaction(database);
  try {
    const workflow = ensureReceivedState(database, requestId);
    const state = resolveState(database, requestId, proposal);
    database
      .prepare(
        `INSERT INTO proposals (
          request_id, department, priority, confidence, summary, proposed_owner,
          proposed_steps_json, risk_flags_json, recommended_state,
          validation_version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        requestId,
        proposal.department,
        proposal.priority,
        proposal.confidence,
        proposal.summary,
        proposal.proposed_owner,
        JSON.stringify(proposal.proposed_steps),
        JSON.stringify(proposal.risk_flags),
        proposal.recommended_state,
        "1.0",
        createdAt,
        createdAt,
      );
    const update = database
      .prepare(
        `UPDATE request_workflows
         SET state = ?, version = version + 1, updated_at = ?
         WHERE request_id = ? AND state = 'Received' AND version = ?`,
      )
      .run(state, createdAt, requestId, workflow.version);
    if (Number(update.changes) !== 1) {
      throw new TriageServiceError(
        409,
        "INVALID_TRANSITION",
        `Request ${requestId} changed while triage was running`,
      );
    }
    database
      .prepare(
        `INSERT INTO triage_attempts (request_id, outcome, error_code, created_at)
         VALUES (?, 'succeeded', NULL, ?)`,
      )
      .run(requestId, createdAt);
    database
      .prepare(
        `INSERT INTO audit_logs (
          request_id, actor_role, action, from_state, to_state,
          reason, details_json, created_at
        ) VALUES (?, 'Manager', 'triage_completed', 'Received', ?, NULL, ?, ?)`,
      )
      .run(
        requestId,
        state,
        JSON.stringify({
          confidence: proposal.confidence,
          risk_flags: proposal.risk_flags,
          mode,
        }),
        createdAt,
      );
    database.exec("COMMIT");
    return {
      request_id: requestId,
      state,
      proposal,
    };
  } catch (error) {
    rollbackTransaction(database);
    throw error;
  }
}
