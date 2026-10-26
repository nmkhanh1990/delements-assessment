import Fastify from "fastify";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import { baselineCsvPath, mockAiFixturePath } from "./config.js";
import { openDatabase } from "./database.js";
import {
  CsvValidationError,
  ImportConflictError,
  importSourceRequests,
} from "./import-service.js";
import type { MockAiMode } from "./mock-ai-schema.js";
import { TriageServiceError, triageRequest } from "./triage-service.js";
import {
  applyDecision,
  decisionSchema,
  seedFixtureRelations,
  WorkflowServiceError,
} from "./workflow-service.js";

const triageParamsSchema = z
  .object({
    id: z.string().regex(/^REQ-\d{3}$/),
  })
  .strict();

const triageBodySchema = z
  .object({
    mode: z
      .enum([
        "valid",
        "malformed",
        "timeout",
        "unavailable",
        "low_confidence",
      ])
      .optional(),
  })
  .strict()
  .default({});

const requestParamsSchema = z
  .object({
    id: z.string().regex(/^REQ-\d{3}$/),
  })
  .strict();

const requestListQuerySchema = z
  .object({
    state: z
      .enum([
        "Received",
        "Triaged",
        "Draft",
        "Needs Review",
        "Approved",
        "Open",
        "Rejected",
        "Merged",
      ])
      .optional(),
    department: z
      .enum([
        "IT",
        "Marketing",
        "E-commerce",
        "Customer Service",
        "SCM",
        "Finance",
        "HR",
        "Production",
        "Needs Review",
      ])
      .optional(),
    risk: z
      .enum([
        "duplicate",
        "conflict",
        "security",
        "privacy",
        "missing-information",
      ])
      .optional(),
    q: z.string().trim().max(200).optional(),
  })
  .strict();

const readableRole = z.enum(["Viewer", "Manager"]);

type ServerOptions = {
  database?: DatabaseSync;
  baselineCsvPath?: string;
  mockAiFixturePath?: string;
  allowFaultInjection?: boolean;
};

export function buildServer(options: ServerOptions = {}) {
  const app = Fastify({ logger: true });
  const database = options.database ?? openDatabase();
  const csvPath = options.baselineCsvPath ?? baselineCsvPath;
  const aiFixturePath = options.mockAiFixturePath ?? mockAiFixturePath;
  const allowFaultInjection =
    options.allowFaultInjection ?? process.env.NODE_ENV !== "production";

  app.addHook("onClose", async () => {
    database.close();
  });

  app.setErrorHandler((error, request, reply) => {
    const statusCode =
      error instanceof Error &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    if (statusCode >= 400 && statusCode < 500) {
      request.log.warn(error);
      return reply.status(statusCode).send({
        error: {
          code:
            statusCode === 415
              ? "UNSUPPORTED_MEDIA_TYPE"
              : "BAD_REQUEST",
          message:
            statusCode === 415
              ? "Content-Type must be application/json"
              : "Invalid request",
        },
      });
    }

    request.log.error(error);
    reply.status(500).send({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "An unexpected server error occurred",
      },
    });
  });

  app.get("/api/health", async () => ({ status: "ok" }));

  app.post("/api/imports/baseline", async (request, reply) => {
    if (request.headers["x-demo-role"] !== "Manager") {
      return reply.status(403).send({
        error: {
          code: "FORBIDDEN",
          message: "Manager role required",
        },
      });
    }

    try {
      const csvContent = readFileSync(csvPath, "utf8");
      const result = importSourceRequests(database, csvContent);
      seedFixtureRelations(database, aiFixturePath);
      return reply.send(result);
    } catch (error) {
      if (error instanceof CsvValidationError) {
        return reply.status(400).send({
          error: {
            code: "BAD_REQUEST",
            message: error.message,
          },
        });
      }

      if (error instanceof ImportConflictError) {
        return reply.status(409).send({
          error: {
            code: "DUPLICATE_ID_CONFLICT",
            message: error.message,
            conflicting_ids: error.conflictingIds,
          },
        });
      }

      throw error;
    }
  });

  app.post("/api/requests/:id/triage", async (request, reply) => {
    if (request.headers["x-demo-role"] !== "Manager") {
      return reply.status(403).send({
        error: {
          code: "FORBIDDEN",
          message: "Manager role required",
        },
      });
    }

    const paramsResult = triageParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      return reply.status(400).send({
        error: {
          code: "BAD_REQUEST",
          message: "Request ID must use the REQ-NNN format",
        },
      });
    }

    const bodyResult = triageBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      return reply.status(400).send({
        error: {
          code: "BAD_REQUEST",
          message: "Triage body must contain only a supported mode",
        },
      });
    }

    const mode: MockAiMode = bodyResult.data.mode ?? "valid";
    if (mode !== "valid" && !allowFaultInjection) {
      return reply.status(400).send({
        error: {
          code: "FAULT_INJECTION_DISABLED",
          message: "Fault injection is disabled outside test/demo mode",
        },
      });
    }

    try {
      return reply.send(
        await triageRequest(
          database,
          aiFixturePath,
          paramsResult.data.id,
          mode,
        ),
      );
    } catch (error) {
      if (error instanceof TriageServiceError) {
        return reply.status(error.statusCode).send({
          error: {
            code: error.code,
            message: error.message,
          },
        });
      }
      throw error;
    }
  });

  app.post("/api/requests/:id/decisions", async (request, reply) => {
    const actorRole = request.headers["x-demo-role"];
    if (actorRole !== "Manager") {
      return reply.status(403).send({
        error: {
          code: "FORBIDDEN",
          message: "Manager role required",
        },
      });
    }

    const paramsResult = requestParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      return reply.status(400).send({
        error: {
          code: "BAD_REQUEST",
          message: "Request ID must use the REQ-NNN format",
        },
      });
    }
    const bodyResult = decisionSchema.safeParse(request.body);
    if (!bodyResult.success) {
      return reply.status(400).send({
        error: {
          code: "BAD_REQUEST",
          message: bodyResult.error.issues
            .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
            .join("; "),
        },
      });
    }

    try {
      return reply.send(
        applyDecision(
          database,
          paramsResult.data.id,
          actorRole,
          bodyResult.data,
        ),
      );
    } catch (error) {
      if (error instanceof WorkflowServiceError) {
        return reply.status(error.statusCode).send({
          error: {
            code: error.code,
            message: error.message,
          },
        });
      }
      throw error;
    }
  });

  app.get("/api/requests", async (request, reply) => {
    const role = readableRole.safeParse(request.headers["x-demo-role"]);
    if (!role.success) {
      return reply.status(403).send({
        error: {
          code: "FORBIDDEN",
          message: "Viewer or Manager role required",
        },
      });
    }

    const queryResult = requestListQuerySchema.safeParse(request.query);
    if (!queryResult.success) {
      return reply.status(400).send({
        error: {
          code: "BAD_REQUEST",
          message: "Invalid request list filters",
        },
      });
    }

    const filters = queryResult.data;
    const where: string[] = [];
    const values: string[] = [];
    if (filters.state !== undefined) {
      where.push("workflow.state = ?");
      values.push(filters.state);
    }
    if (filters.department !== undefined) {
      where.push("proposal.department = ?");
      values.push(filters.department);
    }
    if (filters.risk !== undefined) {
      where.push(
        `EXISTS (
          SELECT 1 FROM json_each(proposal.risk_flags_json)
          WHERE json_each.value = ?
        )`,
      );
      values.push(filters.risk);
    }
    if (filters.q !== undefined && filters.q.length > 0) {
      where.push(
        `instr(
          lower(requests.id || ' ' || requests.content || ' ' || COALESCE(proposal.summary, '')),
          lower(?)
        ) > 0`,
      );
      values.push(filters.q);
    }

    const rows = database
      .prepare(
        `SELECT requests.id, requests.source, requests.department_hint,
                requests.requester_role, requests.submitted_at,
                requests.content, workflow.state, workflow.version,
                proposal.department, proposal.priority, proposal.confidence,
                proposal.summary, proposal.proposed_owner,
                proposal.proposed_steps_json, proposal.risk_flags_json
         FROM requests
         JOIN request_workflows AS workflow ON workflow.request_id = requests.id
         LEFT JOIN proposals AS proposal ON proposal.request_id = requests.id
         ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY requests.submitted_at DESC, requests.id`,
      )
      .all(...values) as Array<{
      id: string;
      source: string;
      department_hint: string | null;
      requester_role: string;
      submitted_at: string;
      content: string;
      state: string;
      version: number;
      department: string | null;
      priority: string | null;
      confidence: number | null;
      summary: string | null;
      proposed_owner: string | null;
      proposed_steps_json: string | null;
      risk_flags_json: string | null;
    }>;

    return reply.send({
      requests: rows.map(({ proposed_steps_json, risk_flags_json, ...row }) => ({
        ...row,
        proposed_steps:
          proposed_steps_json === null
            ? null
            : (JSON.parse(proposed_steps_json) as unknown),
        risk_flags:
          risk_flags_json === null
            ? null
            : (JSON.parse(risk_flags_json) as unknown),
      })),
    });
  });

  app.get("/api/requests/:id", async (request, reply) => {
    const role = readableRole.safeParse(request.headers["x-demo-role"]);
    if (!role.success) {
      return reply.status(403).send({
        error: {
          code: "FORBIDDEN",
          message: "Viewer or Manager role required",
        },
      });
    }

    const paramsResult = requestParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      return reply.status(400).send({
        error: {
          code: "BAD_REQUEST",
          message: "Request ID must use the REQ-NNN format",
        },
      });
    }

    const row = database
      .prepare(
        `SELECT requests.id, requests.source, requests.department_hint,
                requests.requester_role, requests.submitted_at, requests.content,
                workflow.state, workflow.version, workflow.updated_at AS workflow_updated_at,
                proposal.department, proposal.priority, proposal.confidence,
                proposal.summary, proposal.proposed_owner,
                proposal.proposed_steps_json, proposal.risk_flags_json,
                proposal.recommended_state, proposal.validation_version,
                proposal.created_at AS proposal_created_at,
                proposal.updated_at AS proposal_updated_at
         FROM requests
         JOIN request_workflows AS workflow ON workflow.request_id = requests.id
         LEFT JOIN proposals AS proposal ON proposal.request_id = requests.id
         WHERE requests.id = ?`,
      )
      .get(paramsResult.data.id) as
      | {
          id: string;
          source: string;
          department_hint: string | null;
          requester_role: string;
          submitted_at: string;
          content: string;
          state: string;
          version: number;
          workflow_updated_at: string;
          department: string | null;
          priority: string | null;
          confidence: number | null;
          summary: string | null;
          proposed_owner: string | null;
          proposed_steps_json: string | null;
          risk_flags_json: string | null;
          recommended_state: string | null;
          validation_version: string | null;
          proposal_created_at: string | null;
          proposal_updated_at: string | null;
        }
      | undefined;

    if (row === undefined) {
      return reply.status(404).send({
        error: {
          code: "NOT_FOUND",
          message: `Request ${paramsResult.data.id} was not found`,
        },
      });
    }

    const relations = database
      .prepare(
        `SELECT id, from_request_id, to_request_id, relation_type, status,
                reason, created_at, resolved_at
         FROM request_relations
         WHERE from_request_id = ? OR to_request_id = ?
         ORDER BY id`,
      )
      .all(paramsResult.data.id, paramsResult.data.id);
    const {
      proposed_steps_json,
      risk_flags_json,
      ...requestDetail
    } = row;
    return reply.send({
      request: {
        id: requestDetail.id,
        source: requestDetail.source,
        department_hint: requestDetail.department_hint,
        requester_role: requestDetail.requester_role,
        submitted_at: requestDetail.submitted_at,
        content: requestDetail.content,
      },
      workflow: {
        state: requestDetail.state,
        version: requestDetail.version,
        updated_at: requestDetail.workflow_updated_at,
      },
      proposal:
        requestDetail.department === null
          ? null
          : {
              department: requestDetail.department,
              priority: requestDetail.priority,
              confidence: requestDetail.confidence,
              summary: requestDetail.summary,
              proposed_owner: requestDetail.proposed_owner,
              proposed_steps: JSON.parse(proposed_steps_json ?? "[]") as unknown,
              risk_flags: JSON.parse(risk_flags_json ?? "[]") as unknown,
              recommended_state: requestDetail.recommended_state,
              validation_version: requestDetail.validation_version,
              created_at: requestDetail.proposal_created_at,
              updated_at: requestDetail.proposal_updated_at,
            },
      relations,
    });
  });

  app.get("/api/requests/:id/audit", async (request, reply) => {
    const role = request.headers["x-demo-role"];
    if (role !== "Manager" && role !== "Viewer") {
      return reply.status(403).send({
        error: {
          code: "FORBIDDEN",
          message: "Viewer or Manager role required",
        },
      });
    }

    const paramsResult = requestParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      return reply.status(400).send({
        error: {
          code: "BAD_REQUEST",
          message: "Request ID must use the REQ-NNN format",
        },
      });
    }
    const requestExists = database
      .prepare("SELECT 1 FROM requests WHERE id = ?")
      .get(paramsResult.data.id);
    if (requestExists === undefined) {
      return reply.status(404).send({
        error: {
          code: "NOT_FOUND",
          message: `Request ${paramsResult.data.id} was not found`,
        },
      });
    }

    const rows = database
      .prepare(
        `SELECT id, actor_role, action, from_state, to_state, reason,
                details_json, created_at
         FROM audit_logs
         WHERE request_id = ?
         ORDER BY id`,
      )
      .all(paramsResult.data.id) as Array<{
      id: number;
      actor_role: string;
      action: string;
      from_state: string | null;
      to_state: string | null;
      reason: string | null;
      details_json: string;
      created_at: string;
    }>;
    return reply.send({
      request_id: paramsResult.data.id,
      audit: rows.map(({ details_json, ...row }) => ({
        ...row,
        details: JSON.parse(details_json) as unknown,
      })),
    });
  });

  app.get("/api/tasks", async (request, reply) => {
    const role = request.headers["x-demo-role"];
    if (role !== "Manager" && role !== "Viewer") {
      return reply.status(403).send({
        error: {
          code: "FORBIDDEN",
          message: "Viewer or Manager role required",
        },
      });
    }
    const tasks = database
      .prepare(
        `SELECT id, request_id, status, opened_at, opened_by
         FROM tasks ORDER BY id`,
      )
      .all();
    return reply.send({ tasks });
  });

  return app;
}
