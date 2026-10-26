import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "./database.js";
import { buildServer } from "./server.js";

describe("GET /api/health", () => {
  it("returns a successful health response", async () => {
    const app = buildServer({ database: openDatabase(":memory:") });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/health",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "ok" });
    } finally {
      await app.close();
    }
  });
});

describe("POST /api/imports/baseline", () => {
  let app: ReturnType<typeof buildServer> | undefined;
  let temporaryDirectory: string | undefined;

  afterEach(async () => {
    if (app !== undefined) {
      await app.close();
      app = undefined;
    }
    if (temporaryDirectory !== undefined) {
      rmSync(temporaryDirectory, { recursive: true, force: true });
      temporaryDirectory = undefined;
    }
  });

  it("requires the Manager demo role", async () => {
    app = buildServer({ database: openDatabase(":memory:") });

    const response = await app.inject({
      method: "POST",
      url: "/api/imports/baseline",
      headers: { "x-demo-role": "Viewer" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: "FORBIDDEN",
        message: "Manager role required",
      },
    });
  });

  it("rejects an invalid CSV without writing requests", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "delements-import-"));
    const csvPath = join(temporaryDirectory, "invalid.csv");
    writeFileSync(csvPath, "id,wrong_header\nREQ-001,value\n");

    const database = openDatabase(":memory:");
    app = buildServer({ database, baselineCsvPath: csvPath });
    const response = await app.inject({
      method: "POST",
      url: "/api/imports/baseline",
      headers: { "x-demo-role": "Manager" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: "BAD_REQUEST",
        message:
          "CSV header must be exactly: id, source, department_hint, requester_role, submitted_at, content",
      },
    });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM requests").get(),
    ).toEqual({ count: 0 });
  });

  it("returns an explicit client error for unsupported content types", async () => {
    const database = openDatabase(":memory:");
    app = buildServer({ database });

    const response = await app.inject({
      method: "POST",
      url: "/api/imports/baseline",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-demo-role": "Manager",
      },
      payload: "unexpected=body",
    });

    expect(response.statusCode).toBe(415);
    expect(response.json()).toEqual({
      error: {
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "Content-Type must be application/json",
      },
    });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM requests").get(),
    ).toEqual({ count: 0 });
  });

  it("imports the baseline idempotently for a Manager", async () => {
    const database = openDatabase(":memory:");
    app = buildServer({ database });

    const firstImport = await app.inject({
      method: "POST",
      url: "/api/imports/baseline",
      headers: { "x-demo-role": "Manager" },
    });
    const secondImport = await app.inject({
      method: "POST",
      url: "/api/imports/baseline",
      headers: { "x-demo-role": "Manager" },
    });

    expect(firstImport.statusCode).toBe(200);
    expect(firstImport.json()).toEqual({
      inserted: 12,
      skipped: 0,
      total: 12,
    });
    expect(secondImport.statusCode).toBe(200);
    expect(secondImport.json()).toEqual({
      inserted: 0,
      skipped: 12,
      total: 12,
    });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM requests").get(),
    ).toEqual({ count: 12 });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM request_relations").get(),
    ).toEqual({ count: 2 });

    database
      .prepare(
        `UPDATE request_relations
         SET status = 'resolved', reason = 'Preserve resolution', resolved_at = ?
         WHERE relation_type = 'conflict'`,
      )
      .run("2026-10-26T00:00:00.000Z");
    const thirdImport = await app.inject({
      method: "POST",
      url: "/api/imports/baseline",
      headers: { "x-demo-role": "Manager" },
    });
    expect(thirdImport.json()).toEqual({
      inserted: 0,
      skipped: 12,
      total: 12,
    });
    expect(
      database
        .prepare(
          "SELECT status, reason FROM request_relations WHERE relation_type = 'conflict'",
        )
        .get(),
    ).toEqual({
      status: "resolved",
      reason: "Preserve resolution",
    });
  });

  it("returns conflicting IDs without partially importing the batch", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "delements-import-"));
    const csvPath = join(temporaryDirectory, "assessment_requests.csv");
    const baselineCsv = readFileSync(
      new URL("../../../fixtures/assessment_requests.csv", import.meta.url),
      "utf8",
    );
    writeFileSync(csvPath, baselineCsv);

    const database = openDatabase(":memory:");
    app = buildServer({ database, baselineCsvPath: csvPath });
    const firstImport = await app.inject({
      method: "POST",
      url: "/api/imports/baseline",
      headers: { "x-demo-role": "Manager" },
    });
    writeFileSync(
      csvPath,
      baselineCsv
        .replace(
          "Checkout on the storefront returns an error",
          "Changed source content for collision test",
        )
        .concat(
          "REQ-013,form,IT,Tester,2026-10-22T12:00:00+07:00,New test request\n",
        ),
    );

    const conflictResponse = await app.inject({
      method: "POST",
      url: "/api/imports/baseline",
      headers: { "x-demo-role": "Manager" },
    });

    expect(firstImport.statusCode).toBe(200);
    expect(conflictResponse.statusCode).toBe(409);
    expect(conflictResponse.json()).toEqual({
      error: {
        code: "DUPLICATE_ID_CONFLICT",
        message: "Source requests already exist with different content: REQ-001",
        conflicting_ids: ["REQ-001"],
      },
    });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM requests").get(),
    ).toEqual({ count: 12 });
    expect(
      database.prepare("SELECT id FROM requests WHERE id = ?").get("REQ-013"),
    ).toBeUndefined();
  });
});
