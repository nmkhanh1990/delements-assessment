import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "./database.js";
import { importSourceRequests } from "./import-service.js";
import { buildServer } from "./server.js";
import { seedFixtureRelations } from "./workflow-service.js";
import { triageRequest } from "./triage-service.js";

const sourceCsv = readFileSync(
  new URL("../../../fixtures/assessment_requests.csv", import.meta.url),
  "utf8",
);
const fixturePath = fileURLToPath(
  new URL("../../../fixtures/mock-ai-responses.json", import.meta.url),
);

describe("request read APIs", () => {
  let app: ReturnType<typeof buildServer>;
  let database: ReturnType<typeof openDatabase>;

  beforeEach(() => {
    database = openDatabase(":memory:");
    importSourceRequests(database, sourceCsv);
    seedFixtureRelations(database, fixturePath);
    app = buildServer({ database });
  });

  afterEach(async () => {
    await app.close();
  });

  it("lists source requests and supports state, department, risk, and text filters", async () => {
    await triageRequest(database, fixturePath, "REQ-005", "valid");
    await triageRequest(database, fixturePath, "REQ-006", "valid");
    await triageRequest(database, fixturePath, "REQ-008", "valid");

    const all = await app.inject({
      method: "GET",
      url: "/api/requests",
      headers: { "x-demo-role": "Viewer" },
    });
    const needsReview = await app.inject({
      method: "GET",
      url: "/api/requests?state=Needs%20Review",
      headers: { "x-demo-role": "Manager" },
    });
    const privacy = await app.inject({
      method: "GET",
      url: "/api/requests?risk=privacy",
      headers: { "x-demo-role": "Viewer" },
    });
    const marketing = await app.inject({
      method: "GET",
      url: "/api/requests?department=Marketing",
      headers: { "x-demo-role": "Viewer" },
    });
    const search = await app.inject({
      method: "GET",
      url: "/api/requests?q=blank%20page",
      headers: { "x-demo-role": "Viewer" },
    });

    expect(all.statusCode).toBe(200);
    expect(all.json().requests).toHaveLength(12);
    expect(all.json().requests[0]).toMatchObject({
      id: "REQ-012",
      state: "Received",
      department: null,
      summary: null,
    });
    expect(
      needsReview.json().requests.map((request: { id: string }) => request.id),
    ).toEqual(["REQ-006", "REQ-005"]);
    expect(privacy.json().requests.map((request: { id: string }) => request.id))
      .toEqual(["REQ-006"]);
    expect(
      marketing.json().requests.map((request: { id: string }) => request.id),
    ).toContain("REQ-008");
    expect(search.json().requests.map((request: { id: string }) => request.id))
      .toEqual(["REQ-007"]);
  });

  it("rejects invalid filters and unauthorized reads", async () => {
    const unknownRole = await app.inject({
      method: "GET",
      url: "/api/requests",
      headers: { "x-demo-role": "Unknown" },
    });
    const invalidFilter = await app.inject({
      method: "GET",
      url: "/api/requests?state=Open%20Maybe",
      headers: { "x-demo-role": "Viewer" },
    });

    expect(unknownRole.statusCode).toBe(403);
    expect(invalidFilter.statusCode).toBe(400);
  });

  it("returns a complete request, proposal, workflow, and relation detail", async () => {
    await triageRequest(database, fixturePath, "REQ-002", "valid");

    const response = await app.inject({
      method: "GET",
      url: "/api/requests/REQ-002",
      headers: { "x-demo-role": "Viewer" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      request: {
        id: "REQ-002",
        source: "chat",
        content: expect.stringContaining("Same incident"),
      },
      workflow: { state: "Needs Review", version: 1 },
      proposal: {
        department: "E-commerce",
        risk_flags: ["duplicate"],
      },
      relations: [
        {
          from_request_id: "REQ-002",
          to_request_id: "REQ-001",
          relation_type: "duplicate_candidate",
          status: "unresolved",
        },
      ],
    });
  });

  it("returns not found for an unknown request and validates path IDs", async () => {
    const missing = await app.inject({
      method: "GET",
      url: "/api/requests/REQ-099",
      headers: { "x-demo-role": "Manager" },
    });
    const invalid = await app.inject({
      method: "GET",
      url: "/api/requests/bad-id",
      headers: { "x-demo-role": "Manager" },
    });

    expect(missing.statusCode).toBe(404);
    expect(invalid.statusCode).toBe(400);
  });
});
