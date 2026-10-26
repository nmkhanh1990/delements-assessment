import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import { loadMockAiFixture } from "./mock-ai-adapter.js";
import {
  proposalSchema,
  type Proposal,
} from "./mock-ai-schema.js";

const requestIdSchema = z.string().regex(/^REQ-\d{3}$/);
const reasonSchema = z.string().trim().min(1).max(1000);

const proposalPatchSchema = z
  .object({
    department: proposalSchema.shape.department.optional(),
    priority: proposalSchema.shape.priority.optional(),
    confidence: proposalSchema.shape.confidence.optional(),
    summary: proposalSchema.shape.summary.optional(),
    proposed_owner: proposalSchema.shape.proposed_owner.optional(),
    proposed_steps: proposalSchema.shape.proposed_steps.optional(),
    risk_flags: proposalSchema.shape.risk_flags.optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "Patch must include at least one proposal field",
  });

export const decisionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("approve"),
      reason: reasonSchema,
      expected_version: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      action: z.literal("reject"),
      reason: reasonSchema,
      expected_version: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      action: z.literal("edit"),
      patch: proposalPatchSchema,
      reason: reasonSchema,
      expected_version: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      action: z.literal("merge"),
      target_request_id: requestIdSchema,
      reason: reasonSchema,
      expected_version: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      action: z.literal("request_clarification"),
      reason: reasonSchema,
      expected_version: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      action: z.literal("resolve_conflict"),
      related_request_id: requestIdSchema,
      reason: reasonSchema,
      expected_version: z.number().int().nonnegative(),
    })
    .strict(),
]);

export type DecisionInput = z.infer<typeof decisionSchema>;
export type DemoRole = "Manager" | "Viewer" | undefined;

type WorkflowRow = {
  state: string;
  version: number;
};

type ProposalRow = {
  department: Proposal["department"];
  priority: Proposal["priority"];
  confidence: number;
  summary: string;
  proposed_owner: string;
  proposed_steps_json: string;
  risk_flags_json: string;
  recommended_state: Proposal["recommended_state"];
};

export type DecisionResult = {
  request_id: string;
  state: string;
  version: number;
  task_id?: number;
  target_request_id?: string;
  related_request_id?: string;
  related_state?: string;
  related_version?: number;
};

export class WorkflowServiceError extends Error {
  constructor(
    readonly statusCode: 400 | 403 | 404 | 409,
    readonly code:
      | "BAD_REQUEST"
      | "FORBIDDEN"
      | "NOT_FOUND"
      | "INVALID_TRANSITION"
      | "STALE_VERSION"
      | "UNRESOLVED_BLOCKER",
    message: string,
  ) {
    super(message);
    this.name = "WorkflowServiceError";
  }
}

function beginTransaction(database: DatabaseSync) {
  database.exec("BEGIN IMMEDIATE");
}

function rollbackTransaction(database: DatabaseSync) {
  database.exec("ROLLBACK");
}

function recordAudit(
  database: DatabaseSync,
  input: {
    requestId: string;
    actorRole: "Manager";
    action: string;
    fromState: string;
    toState: string;
    reason: string;
    details?: Record<string, unknown>;
    createdAt: string;
  },
) {
  database
    .prepare(
      `INSERT INTO audit_logs (
        request_id, actor_role, action, from_state, to_state,
        reason, details_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.requestId,
      input.actorRole,
      input.action,
      input.fromState,
      input.toState,
      input.reason,
      JSON.stringify(input.details ?? {}),
      input.createdAt,
    );
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

function requireWorkflow(database: DatabaseSync, requestId: string) {
  const workflow = getWorkflow(database, requestId);
  if (workflow === undefined) {
    throw new WorkflowServiceError(
      404,
      "NOT_FOUND",
      `Request ${requestId} was not found`,
    );
  }
  return workflow;
}

function requireExpectedVersion(
  workflow: WorkflowRow,
  expectedVersion: number,
  requestId: string,
) {
  if (workflow.version !== expectedVersion) {
    throw new WorkflowServiceError(
      409,
      "STALE_VERSION",
      `Request ${requestId} is at version ${workflow.version}, not ${expectedVersion}`,
    );
  }
}

function requireDecisionState(workflow: WorkflowRow, requestId: string) {
  if (workflow.state !== "Draft" && workflow.state !== "Needs Review") {
    throw new WorkflowServiceError(
      409,
      "INVALID_TRANSITION",
      `Request ${requestId} cannot be changed from state ${workflow.state}`,
    );
  }
}

function updateWorkflow(
  database: DatabaseSync,
  requestId: string,
  current: WorkflowRow,
  nextState: string,
  createdAt: string,
) {
  const result = database
    .prepare(
      `UPDATE request_workflows
       SET state = ?, version = version + 1, updated_at = ?
       WHERE request_id = ? AND version = ?`,
    )
    .run(nextState, createdAt, requestId, current.version);
  if (Number(result.changes) !== 1) {
    throw new WorkflowServiceError(
      409,
      "STALE_VERSION",
      `Request ${requestId} changed while the decision was being applied`,
    );
  }
  return current.version + 1;
}

function getProposal(database: DatabaseSync, requestId: string) {
  return database
    .prepare(
      `SELECT department, priority, confidence, summary, proposed_owner,
              proposed_steps_json, risk_flags_json, recommended_state
       FROM proposals WHERE request_id = ?`,
    )
    .get(requestId) as ProposalRow | undefined;
}

function parseProposal(row: ProposalRow): Proposal {
  return proposalSchema.parse({
    department: row.department,
    priority: row.priority,
    confidence: row.confidence,
    summary: row.summary,
    proposed_owner: row.proposed_owner,
    proposed_steps: JSON.parse(row.proposed_steps_json) as unknown,
    risk_flags: JSON.parse(row.risk_flags_json) as unknown,
    recommended_state: row.recommended_state,
  });
}

function findUnresolvedBlockers(database: DatabaseSync, requestId: string) {
  return database
    .prepare(
      `SELECT relation_type, from_request_id, to_request_id
       FROM request_relations
       WHERE status = 'unresolved'
         AND relation_type IN ('conflict', 'duplicate_candidate')
         AND (from_request_id = ? OR to_request_id = ?)
       ORDER BY relation_type, from_request_id, to_request_id`,
    )
    .all(requestId, requestId) as Array<{
    relation_type: "conflict" | "duplicate_candidate";
    from_request_id: string;
    to_request_id: string;
  }>;
}

function assertNoApprovalBlockers(database: DatabaseSync, requestId: string) {
  const blockers = findUnresolvedBlockers(database, requestId);
  if (blockers.length > 0) {
    const blockerNames = blockers
      .map((blocker) => blocker.relation_type)
      .join(", ");
    throw new WorkflowServiceError(
      409,
      "UNRESOLVED_BLOCKER",
      `Request ${requestId} has unresolved relation blockers: ${blockerNames}`,
    );
  }
}

function hasMergePath(
  database: DatabaseSync,
  fromRequestId: string,
  toRequestId: string,
) {
  const visited = new Set<string>();
  const pending = [fromRequestId];
  const findTargets = database.prepare(
    `SELECT to_request_id
     FROM request_relations
     WHERE relation_type = 'merged_into' AND status = 'resolved'
       AND from_request_id = ?`,
  );

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) {
      continue;
    }
    if (current === toRequestId) {
      return true;
    }
    visited.add(current);
    const targets = findTargets.all(current) as Array<{
      to_request_id: string;
    }>;
    pending.push(...targets.map((target) => target.to_request_id));
  }
  return false;
}

function assertMergeTarget(
  database: DatabaseSync,
  sourceId: string,
  targetId: string,
) {
  if (sourceId === targetId) {
    throw new WorkflowServiceError(
      400,
      "BAD_REQUEST",
      "A request cannot be merged into itself",
    );
  }

  const target = getWorkflow(database, targetId);
  if (target === undefined) {
    throw new WorkflowServiceError(
      404,
      "NOT_FOUND",
      `Merge target ${targetId} was not found`,
    );
  }
  if (target.state === "Rejected" || target.state === "Merged") {
    throw new WorkflowServiceError(
      409,
      "INVALID_TRANSITION",
      `Cannot merge into terminal request ${targetId}`,
    );
  }
  if (hasMergePath(database, targetId, sourceId)) {
    throw new WorkflowServiceError(
      409,
      "INVALID_TRANSITION",
      `Merging ${sourceId} into ${targetId} would create a merge cycle`,
    );
  }

  const candidate = database
    .prepare(
      `SELECT to_request_id
       FROM request_relations
       WHERE relation_type = 'duplicate_candidate'
         AND status = 'unresolved' AND from_request_id = ?`,
    )
    .get(sourceId) as { to_request_id: string } | undefined;
  if (candidate !== undefined && candidate.to_request_id !== targetId) {
    throw new WorkflowServiceError(
      409,
      "INVALID_TRANSITION",
      `Request ${sourceId} is a duplicate candidate of ${candidate.to_request_id}`,
    );
  }
}

function nextStateForEditedProposal(
  database: DatabaseSync,
  requestId: string,
  currentState: string,
  proposal: Proposal,
): "Draft" | "Needs Review" {
  const unresolvedBlockers = findUnresolvedBlockers(database, requestId);
  if (
    currentState === "Needs Review" ||
    proposal.confidence < 0.7 ||
    proposal.risk_flags.length > 0 ||
    proposal.department === "Needs Review" ||
    unresolvedBlockers.length > 0
  ) {
    return "Needs Review";
  }
  return "Draft";
}

export function seedFixtureRelations(
  database: DatabaseSync,
  fixturePath: string,
  createdAt = new Date().toISOString(),
) {
  const fixture = loadMockAiFixture(fixturePath);
  const relations = [
    {
      from: fixture.scenario_metadata.S1.duplicate_candidate.source_id,
      to: fixture.scenario_metadata.S1.duplicate_candidate.target_id,
      type: "duplicate_candidate",
    },
    {
      from: [...fixture.scenario_metadata.S2.source_ids].sort()[0],
      to: [...fixture.scenario_metadata.S2.source_ids].sort()[1],
      type: "conflict",
    },
  ] as const;
  const insert = database.prepare(
    `INSERT OR IGNORE INTO request_relations (
      from_request_id, to_request_id, relation_type, status, created_at
    )
    SELECT ?, ?, ?, 'unresolved', ?
    WHERE EXISTS (SELECT 1 FROM requests WHERE id = ?)
      AND EXISTS (SELECT 1 FROM requests WHERE id = ?)`,
  );

  beginTransaction(database);
  try {
    for (const relation of relations) {
      insert.run(
        relation.from,
        relation.to,
        relation.type,
        createdAt,
        relation.from,
        relation.to,
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    rollbackTransaction(database);
    throw error;
  }
}

export function applyDecision(
  database: DatabaseSync,
  requestId: string,
  actorRole: DemoRole,
  input: DecisionInput,
  createdAt = new Date().toISOString(),
): DecisionResult {
  if (actorRole !== "Manager") {
    throw new WorkflowServiceError(
      403,
      "FORBIDDEN",
      "Manager role required",
    );
  }

  beginTransaction(database);
  try {
    const current = requireWorkflow(database, requestId);
    requireExpectedVersion(current, input.expected_version, requestId);
    const actor: "Manager" = actorRole;

    if (input.action === "resolve_conflict") {
      const related = requireWorkflow(database, input.related_request_id);
      const [firstId, secondId] = [requestId, input.related_request_id].sort();
      const relation = database
        .prepare(
          `SELECT id FROM request_relations
           WHERE from_request_id = ? AND to_request_id = ?
             AND relation_type = 'conflict' AND status = 'unresolved'`,
        )
        .get(firstId, secondId);
      if (relation === undefined) {
        throw new WorkflowServiceError(
          409,
          "INVALID_TRANSITION",
          `No unresolved conflict exists between ${requestId} and ${input.related_request_id}`,
        );
      }
      if (
        current.state !== "Needs Review" ||
        related.state !== "Needs Review"
      ) {
        throw new WorkflowServiceError(
          409,
          "INVALID_TRANSITION",
          "Both requests must be in Needs Review to resolve their conflict",
        );
      }

      database
        .prepare(
          `UPDATE request_relations
           SET status = 'resolved', reason = ?, resolved_at = ?
           WHERE from_request_id = ? AND to_request_id = ?
             AND relation_type = 'conflict' AND status = 'unresolved'`,
        )
        .run(input.reason, createdAt, firstId, secondId);
      const currentVersion = updateWorkflow(
        database,
        requestId,
        current,
        current.state,
        createdAt,
      );
      const relatedVersion = updateWorkflow(
        database,
        input.related_request_id,
        related,
        related.state,
        createdAt,
      );
      for (const id of [firstId, secondId]) {
        const workflow = id === requestId ? current : related;
        recordAudit(database, {
          requestId: id,
          actorRole: actor,
          action: "resolve_conflict",
          fromState: workflow.state,
          toState: workflow.state,
          reason: input.reason,
          details: { related_request_id: id === requestId ? input.related_request_id : requestId },
          createdAt,
        });
      }
      database.exec("COMMIT");
      return {
        request_id: requestId,
        state: current.state,
        version: currentVersion,
        related_request_id: input.related_request_id,
        related_state: related.state,
        related_version: relatedVersion,
      };
    }

    requireDecisionState(current, requestId);

    if (input.action === "approve") {
      assertNoApprovalBlockers(database, requestId);
      const proposalRow = getProposal(database, requestId);
      if (proposalRow === undefined) {
        throw new WorkflowServiceError(
          409,
          "INVALID_TRANSITION",
          "A validated proposal is required before approval",
        );
      }
      const proposal = parseProposal(proposalRow);
      const approvedVersion = updateWorkflow(
        database,
        requestId,
        current,
        "Open",
        createdAt,
      );
      const taskResult = database
        .prepare(
          `INSERT INTO tasks (request_id, status, opened_at, opened_by)
           VALUES (?, 'Open', ?, ?)`,
        )
        .run(requestId, createdAt, actor);
      recordAudit(database, {
        requestId,
        actorRole: actor,
        action: "approve",
        fromState: current.state,
        toState: "Approved",
        reason: input.reason,
        details: { confidence: proposal.confidence },
        createdAt,
      });
      recordAudit(database, {
        requestId,
        actorRole: actor,
        action: "task_opened",
        fromState: "Approved",
        toState: "Open",
        reason: input.reason,
        details: { task_id: Number(taskResult.lastInsertRowid) },
        createdAt,
      });
      database.exec("COMMIT");
      return {
        request_id: requestId,
        state: "Open",
        version: approvedVersion,
        task_id: Number(taskResult.lastInsertRowid),
      };
    }

    if (input.action === "reject") {
      const version = updateWorkflow(
        database,
        requestId,
        current,
        "Rejected",
        createdAt,
      );
      recordAudit(database, {
        requestId,
        actorRole: actor,
        action: "reject",
        fromState: current.state,
        toState: "Rejected",
        reason: input.reason,
        createdAt,
      });
      database.exec("COMMIT");
      return { request_id: requestId, state: "Rejected", version };
    }

    if (input.action === "merge") {
      assertMergeTarget(database, requestId, input.target_request_id);
      const version = updateWorkflow(
        database,
        requestId,
        current,
        "Merged",
        createdAt,
      );
      database
        .prepare(
          `UPDATE request_relations
           SET status = 'resolved', reason = ?, resolved_at = ?
           WHERE from_request_id = ? AND relation_type = 'duplicate_candidate'
             AND status = 'unresolved'`,
        )
        .run(input.reason, createdAt, requestId);
      database
        .prepare(
          `INSERT INTO request_relations (
            from_request_id, to_request_id, relation_type, status,
            reason, created_at, resolved_at
          ) VALUES (?, ?, 'merged_into', 'resolved', ?, ?, ?)`,
        )
        .run(
          requestId,
          input.target_request_id,
          input.reason,
          createdAt,
          createdAt,
        );
      recordAudit(database, {
        requestId,
        actorRole: actor,
        action: "merge",
        fromState: current.state,
        toState: "Merged",
        reason: input.reason,
        details: { target_request_id: input.target_request_id },
        createdAt,
      });
      database.exec("COMMIT");
      return {
        request_id: requestId,
        state: "Merged",
        version,
        target_request_id: input.target_request_id,
      };
    }

    if (input.action === "request_clarification") {
      if (current.state !== "Needs Review") {
        throw new WorkflowServiceError(
          409,
          "INVALID_TRANSITION",
          "Clarification can only be requested for a request in Needs Review",
        );
      }
      const version = updateWorkflow(
        database,
        requestId,
        current,
        current.state,
        createdAt,
      );
      recordAudit(database, {
        requestId,
        actorRole: actor,
        action: "clarification_requested",
        fromState: current.state,
        toState: current.state,
        reason: input.reason,
        createdAt,
      });
      database.exec("COMMIT");
      return {
        request_id: requestId,
        state: current.state,
        version,
      };
    }

    const existingProposal = getProposal(database, requestId);
    if (existingProposal === undefined) {
      throw new WorkflowServiceError(
        409,
        "INVALID_TRANSITION",
        "A validated proposal is required before editing",
      );
    }
    const proposal = parseProposal(existingProposal);
    const updatedProposal = proposalSchema.parse({
      ...proposal,
      ...input.patch,
    });
    const nextState = nextStateForEditedProposal(
      database,
      requestId,
      current.state,
      updatedProposal,
    );
    const version = updateWorkflow(
      database,
      requestId,
      current,
      nextState,
      createdAt,
    );
    database
      .prepare(
        `UPDATE proposals
         SET department = ?, priority = ?, confidence = ?, summary = ?,
             proposed_owner = ?, proposed_steps_json = ?, risk_flags_json = ?,
             updated_at = ?
         WHERE request_id = ?`,
      )
      .run(
        updatedProposal.department,
        updatedProposal.priority,
        updatedProposal.confidence,
        updatedProposal.summary,
        updatedProposal.proposed_owner,
        JSON.stringify(updatedProposal.proposed_steps),
        JSON.stringify(updatedProposal.risk_flags),
        createdAt,
        requestId,
      );
    recordAudit(database, {
      requestId,
      actorRole: actor,
      action: "edit_proposal",
      fromState: current.state,
      toState: nextState,
      reason: input.reason,
      details: { changed_fields: Object.keys(input.patch) },
      createdAt,
    });
    database.exec("COMMIT");
    return { request_id: requestId, state: nextState, version };
  } catch (error) {
    rollbackTransaction(database);
    throw error;
  }
}
