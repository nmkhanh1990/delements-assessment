import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "./database.js";
import {
  CsvValidationError,
  ImportConflictError,
  importSourceRequests,
} from "./import-service.js";

const baselineCsv = readFileSync(
  new URL("../../../fixtures/assessment_requests.csv", import.meta.url),
  "utf8",
);

describe("importSourceRequests", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = openDatabase(":memory:");
  });

  afterEach(() => {
    database.close();
  });

  it("inserts all source rows once and skips identical reimports", () => {
    const firstImport = importSourceRequests(
      database,
      baselineCsv,
      "2026-10-26T00:00:00.000Z",
    );
    const secondImport = importSourceRequests(
      database,
      baselineCsv,
      "2026-10-27T00:00:00.000Z",
    );

    expect(firstImport).toEqual({ inserted: 12, skipped: 0, total: 12 });
    expect(secondImport).toEqual({ inserted: 0, skipped: 12, total: 12 });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM requests").get(),
    ).toEqual({ count: 12 });
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM request_workflows WHERE state = 'Received' AND version = 0",
        )
        .get(),
    ).toEqual({ count: 12 });
    expect(
      database
        .prepare("SELECT imported_at FROM requests WHERE id = ?")
        .get("REQ-001"),
    ).toEqual({ imported_at: "2026-10-26T00:00:00.000Z" });
    expect(
      database
        .prepare("SELECT department_hint FROM requests WHERE id = ?")
        .get("REQ-005"),
    ).toEqual({ department_hint: "" });
  });

  it("preserves workflow decisions on reimport", () => {
    importSourceRequests(database, baselineCsv);
    database
      .prepare(
        `UPDATE request_workflows
         SET state = 'Needs Review', version = 3
         WHERE request_id = 'REQ-001'`,
      )
      .run();

    importSourceRequests(database, baselineCsv);

    expect(
      database
        .prepare(
          "SELECT state, version FROM request_workflows WHERE request_id = ?",
        )
        .get("REQ-001"),
    ).toEqual({ state: "Needs Review", version: 3 });
  });

  it("rolls back the entire batch when an existing ID has different content", () => {
    importSourceRequests(database, baselineCsv);
    const changedAndExtendedCsv = baselineCsv
      .replace(
        "Checkout on the storefront returns an error",
        "Changed source content for collision test",
      )
      .concat(
        "REQ-013,form,IT,Tester,2026-10-22T12:00:00+07:00,New test request\n",
      );

    let conflict: ImportConflictError | undefined;
    try {
      importSourceRequests(database, changedAndExtendedCsv);
    } catch (error) {
      if (error instanceof ImportConflictError) {
        conflict = error;
      } else {
        throw error;
      }
    }

    expect(conflict?.conflictingIds).toEqual(["REQ-001"]);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM requests").get(),
    ).toEqual({ count: 12 });
    expect(
      database.prepare("SELECT id FROM requests WHERE id = ?").get("REQ-013"),
    ).toBeUndefined();
    expect(
      database
        .prepare("SELECT content FROM requests WHERE id = ?")
        .get("REQ-001"),
    ).toEqual({
      content:
        "Checkout on the storefront returns an error after clicking Place Order. Several test orders fail before confirmation.",
    });
  });

  it("rejects an unexpected header and duplicate IDs before writing", () => {
    const invalidHeader = baselineCsv.replace("department_hint", "department");
    expect(() => importSourceRequests(database, invalidHeader)).toThrow(
      CsvValidationError,
    );

    const invalidTimestamp = baselineCsv.replace(
      "2026-10-20T09:00:00+07:00",
      "2026-02-30T09:00:00+07:00",
    );
    expect(() => importSourceRequests(database, invalidTimestamp)).toThrow(
      CsvValidationError,
    );

    const duplicateRows = `${baselineCsv}${baselineCsv.split("\n")[1]}\n`;
    expect(() => importSourceRequests(database, duplicateRows)).toThrow(
      CsvValidationError,
    );
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM requests").get(),
    ).toEqual({ count: 0 });
  });

  it("persists imported requests when the SQLite database is reopened", () => {
    const directory = mkdtempSync(join(tmpdir(), "delements-database-"));
    const path = join(directory, "assessment.sqlite");
    let persistentDatabase: DatabaseSync | undefined = openDatabase(path);

    try {
      importSourceRequests(persistentDatabase, baselineCsv);
      persistentDatabase.close();
      persistentDatabase = undefined;

      const reopenedDatabase = openDatabase(path);
      try {
        expect(
          reopenedDatabase
            .prepare("SELECT COUNT(*) AS count FROM requests")
            .get(),
        ).toEqual({ count: 12 });
        expect(
          reopenedDatabase
            .prepare("SELECT state FROM request_workflows WHERE request_id = ?")
            .get("REQ-001"),
        ).toEqual({ state: "Received" });
      } finally {
        reopenedDatabase.close();
      }
    } finally {
      persistentDatabase?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
