import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "./database.js";
import { importSourceRequests } from "./import-service.js";
import { loadMockAiFixture } from "./mock-ai-adapter.js";
import { buildServer } from "./server.js";

const sourceCsvPath = fileURLToPath(
  new URL("../../../fixtures/assessment_requests.csv", import.meta.url),
);
const aiFixturePath = fileURLToPath(
  new URL("../../../fixtures/mock-ai-responses.json", import.meta.url),
);
const sourceCsv = readFileSync(sourceCsvPath, "utf8");

describe("POST /api/requests/:id/triage", () => {
  let app: ReturnType<typeof buildServer>;
  let database: DatabaseSync;
  let temporaryDirectory: string | undefined;

  beforeEach(() => {
    database = openDatabase(":memory:");
    importSourceRequests(database, sourceCsv);
    app = buildServer({ database });
  });

  afterEach(async () => {
    await app.close();
    if (temporaryDirectory !== undefined) {
      rmSync(temporaryDirectory, { recursive: true, force: true });
      temporaryDirectory = undefined;
    }
  });

  async function triage(id: string, mode?: string) {
    return app.inject({
      method: "POST",
      url: `/api/requests/${id}/triage`,
      headers: {
        "x-demo-role": "Manager",
      },
      payload: mode === undefined ? {} : { mode },
    });
  }

  it("requires a Manager and validates request IDs and mode input", async () => {
    const viewerResponse = await app.inject({
      method: "POST",
      url: "/api/requests/REQ-001/triage",
      payload: {},
    });
    const invalidIdResponse = await triage("bad-id");
    const invalidModeResponse = await app.inject({
      method: "POST",
      url: "/api/requests/REQ-001/triage",
      headers: { "x-demo-role": "Manager" },
      payload: { mode: "untrusted" },
    });
    const unknownFieldResponse = await app.inject({
      method: "POST",
      url: "/api/requests/REQ-001/triage",
      headers: { "x-demo-role": "Manager" },
      payload: { mode: "valid", recommended_state: "Open" },
    });

    expect(viewerResponse.statusCode).toBe(403);
    expect(invalidIdResponse.statusCode).toBe(400);
    expect(invalidModeResponse.statusCode).toBe(400);
    expect(unknownFieldResponse.statusCode).toBe(400);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM triage_attempts").get(),
    ).toEqual({ count: 0 });
  });

  it("persists validated proposals and applies review routing policy", async () => {
    const ordinary = await triage("REQ-001");
    const lowConfidence = await triage("REQ-005");
    const sensitive = await triage("REQ-006");
    const injection = await triage("REQ-007");

    expect(ordinary.statusCode).toBe(200);
    expect(ordinary.json()).toMatchObject({
      request_id: "REQ-001",
      state: "Draft",
      proposal: { confidence: 0.95 },
    });
    expect(lowConfidence.json()).toMatchObject({
      request_id: "REQ-005",
      state: "Needs Review",
      proposal: {
        confidence: 0.35,
        risk_flags: ["missing-information"],
      },
    });
    expect(sensitive.json()).toMatchObject({
      request_id: "REQ-006",
      state: "Needs Review",
      proposal: { risk_flags: ["security", "privacy"] },
    });
    expect(injection.json()).toMatchObject({
      request_id: "REQ-007",
      state: "Needs Review",
      proposal: { recommended_state: "Needs Review" },
    });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM proposals").get(),
    ).toEqual({ count: 4 });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM tasks").get(),
    ).toEqual({ count: 0 });
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'triage_completed'",
        )
        .get(),
    ).toEqual({ count: 4 });
  });

  it("routes requests with an unresolved conflict to Needs Review", async () => {
    database
      .prepare(
        `INSERT INTO request_relations (
          from_request_id, to_request_id, relation_type, status, created_at
        ) VALUES ('REQ-001', 'REQ-004', 'conflict', 'unresolved', ?)`,
      )
      .run("2026-10-26T00:00:00.000Z");

    const response = await triage("REQ-001");

    expect(response.json()).toMatchObject({
      request_id: "REQ-001",
      state: "Needs Review",
      proposal: { risk_flags: [] },
    });
  });

  it("applies the confidence threshold exactly and overrides safe suggestions for risks", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "delements-routing-"));
    const fixture = loadMockAiFixture(aiFixturePath);
    fixture.responses["REQ-001"]!.proposal.confidence = 0.7;
    fixture.responses["REQ-008"]!.proposal.confidence = 0.69;
    fixture.responses["REQ-009"]!.proposal.risk_flags = ["security"];
    fixture.responses["REQ-009"]!.proposal.recommended_state = "Draft";
    const routingFixturePath = join(temporaryDirectory, "mock-ai-responses.json");
    writeFileSync(routingFixturePath, JSON.stringify(fixture));

    await app.close();
    database = openDatabase(":memory:");
    importSourceRequests(database, sourceCsv);
    app = buildServer({
      database,
      mockAiFixturePath: routingFixturePath,
    });

    const atThreshold = await triage("REQ-001");
    const belowThreshold = await triage("REQ-008");
    const riskOverride = await triage("REQ-009");

    expect(atThreshold.json()).toMatchObject({
      state: "Draft",
      proposal: { confidence: 0.7 },
    });
    expect(belowThreshold.json()).toMatchObject({
      state: "Needs Review",
      proposal: { confidence: 0.69 },
    });
    expect(riskOverride.json()).toMatchObject({
      state: "Needs Review",
      proposal: {
        recommended_state: "Draft",
        risk_flags: ["security"],
      },
    });
  });

  it("records safe failure evidence and allows retry after adapter faults", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "delements-mock-ai-"));
    const fixture = JSON.parse(readFileSync(aiFixturePath, "utf8")) as {
      fault_injection: {
        timeout: { delay_ms: number };
        malformed: { raw_output: string };
      };
    };
    fixture.fault_injection.timeout.delay_ms = 1;
    const fastFixturePath = join(temporaryDirectory, "mock-ai-responses.json");
    writeFileSync(fastFixturePath, JSON.stringify(fixture));

    await app.close();
    database = openDatabase(":memory:");
    importSourceRequests(database, sourceCsv);
    app = buildServer({
      database,
      mockAiFixturePath: fastFixturePath,
      allowFaultInjection: true,
    });

    const malformed = await triage("REQ-001", "malformed");
    fixture.fault_injection.malformed.raw_output = JSON.stringify({
      department: "IT",
      priority: "Urgent",
      confidence: 0.9,
      summary: "Invalid enum must fail schema validation",
      proposed_owner: "Test Owner",
      proposed_steps: [{ action: "Test", done_when: "Done" }],
      risk_flags: [],
      recommended_state: "Draft",
    });
    writeFileSync(fastFixturePath, JSON.stringify(fixture));
    const invalidSchema = await triage("REQ-002", "malformed");
    const timeout = await triage("REQ-008", "timeout");
    const unavailable = await triage("REQ-009", "unavailable");

    expect(malformed.statusCode).toBe(422);
    expect(malformed.json()).toMatchObject({
      error: { code: "AI_OUTPUT_INVALID" },
    });
    expect(invalidSchema.statusCode).toBe(422);
    expect(invalidSchema.json()).toMatchObject({
      error: { code: "AI_OUTPUT_INVALID" },
    });
    expect(timeout.statusCode).toBe(503);
    expect(timeout.json()).toMatchObject({ error: { code: "AI_TIMEOUT" } });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({
      error: { code: "AI_UNAVAILABLE" },
    });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM proposals").get(),
    ).toEqual({ count: 0 });
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM request_workflows WHERE state != 'Received' OR version != 0",
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(
      database
        .prepare(
          "SELECT request_id, error_code FROM triage_attempts ORDER BY request_id",
        )
        .all(),
    ).toEqual([
      { request_id: "REQ-001", error_code: "AI_OUTPUT_INVALID" },
        { request_id: "REQ-002", error_code: "AI_OUTPUT_INVALID" },
        { request_id: "REQ-008", error_code: "AI_TIMEOUT" },
        { request_id: "REQ-009", error_code: "AI_UNAVAILABLE" },
    ]);
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'triage_failed' AND from_state = 'Received' AND to_state = 'Received'",
        )
        .get(),
    ).toEqual({ count: 4 });

    const retry = await triage("REQ-001");
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({
      request_id: "REQ-001",
      state: "Draft",
    });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM proposals").get(),
    ).toEqual({ count: 1 });
  });

  it("rejects fault injection when disabled", async () => {
    await app.close();
    database = openDatabase(":memory:");
    importSourceRequests(database, sourceCsv);
    app = buildServer({
      database,
      allowFaultInjection: false,
    });

    const response = await triage("REQ-001", "unavailable");

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "FAULT_INJECTION_DISABLED" },
    });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM triage_attempts").get(),
    ).toEqual({ count: 0 });
  });

  it("rejects a repeated triage attempt after successful analysis", async () => {
    const first = await triage("REQ-008");
    const second = await triage("REQ-008");

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({
      error: { code: "INVALID_TRANSITION" },
    });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM proposals WHERE request_id = ?")
        .get("REQ-008"),
    ).toEqual({ count: 1 });
  });
});
