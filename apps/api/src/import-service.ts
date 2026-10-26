import { parse } from "csv-parse/sync";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const expectedHeaders = [
  "id",
  "source",
  "department_hint",
  "requester_role",
  "submitted_at",
  "content",
] as const;

const departments = [
  "IT",
  "Marketing",
  "E-commerce",
  "Customer Service",
  "SCM",
  "Finance",
  "HR",
  "Production",
] as const;

function isIsoTimestampWithTimezone(value: string) {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (match === null) {
    return false;
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = Number(match[10] ?? 0);
  const offsetMinute = Number(match[11] ?? 0);

  if (
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return false;
  }

  const calendarDate = new Date(0);
  calendarDate.setUTCFullYear(year, month - 1, day);
  calendarDate.setUTCHours(hour, minute, second, 0);

  return (
    calendarDate.getUTCFullYear() === year &&
    calendarDate.getUTCMonth() === month - 1 &&
    calendarDate.getUTCDate() === day &&
    Number.isFinite(Date.parse(value))
  );
}

const sourceRequestSchema = z.object({
  id: z.string().regex(/^REQ-\d{3}$/),
  source: z.enum(["chat", "email", "form"]),
  department_hint: z.union([z.literal(""), z.enum(departments)]),
  requester_role: z.string().refine((value) => value.trim().length > 0),
  submitted_at: z
    .string()
    .refine(isIsoTimestampWithTimezone, "Expected a valid ISO-8601 timestamp with a timezone"),
  content: z.string().refine((value) => value.trim().length > 0),
});

type SourceRequest = {
  id: string;
  source: "chat" | "email" | "form";
  department_hint: string;
  requester_role: string;
  submitted_at: string;
  content: string;
};

type StoredSourceRequest = SourceRequest & {
  imported_at: string;
};

export type ImportResult = {
  inserted: number;
  skipped: number;
  total: number;
};

export class CsvValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvValidationError";
  }
}

export class ImportConflictError extends Error {
  constructor(readonly conflictingIds: string[]) {
    super(`Source requests already exist with different content: ${conflictingIds.join(", ")}`);
    this.name = "ImportConflictError";
  }
}

function parseSourceRequests(csvContent: string): SourceRequest[] {
  let records: string[][];
  try {
    records = parse(csvContent, {
      bom: true,
      skip_empty_lines: true,
      relax_column_count: false,
      trim: false,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Invalid CSV input";
    throw new CsvValidationError(`Could not parse CSV: ${detail}`);
  }

  const [headers, ...rows] = records;
  if (
    headers === undefined ||
    headers.length !== expectedHeaders.length ||
    headers.some((header, index) => header !== expectedHeaders[index])
  ) {
    throw new CsvValidationError(
      `CSV header must be exactly: ${expectedHeaders.join(", ")}`,
    );
  }

  if (rows.length === 0) {
    throw new CsvValidationError("CSV must contain at least one request");
  }

  const requests = rows.map((row, index) => {
    const input = Object.fromEntries(
      expectedHeaders.map((header, column) => [header, row[column]]),
    );
    const result = sourceRequestSchema.safeParse(input);

    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => `${issue.path.join(".") || "record"}: ${issue.message}`)
        .join("; ");
      throw new CsvValidationError(`Invalid CSV record ${index + 2}: ${issues}`);
    }

    return result.data;
  });

  const seenIds = new Set<string>();
  for (const request of requests) {
    if (seenIds.has(request.id)) {
      throw new CsvValidationError(`Duplicate request ID in CSV: ${request.id}`);
    }
    seenIds.add(request.id);
  }

  return requests;
}

function matchesSource(existing: StoredSourceRequest, incoming: SourceRequest) {
  return (
    existing.source === incoming.source &&
    existing.department_hint === incoming.department_hint &&
    existing.requester_role === incoming.requester_role &&
    existing.submitted_at === incoming.submitted_at &&
    existing.content === incoming.content
  );
}

export function importSourceRequests(
  database: DatabaseSync,
  csvContent: string,
  importedAt = new Date().toISOString(),
): ImportResult {
  const requests = parseSourceRequests(csvContent);
  const findRequest = database.prepare(
    `SELECT id, source, department_hint, requester_role, submitted_at, content, imported_at
     FROM requests WHERE id = ?`,
  );
  const conflictingIds: string[] = [];
  const newRequests: SourceRequest[] = [];
  let skipped = 0;

  database.exec("BEGIN IMMEDIATE");
  try {
    for (const request of requests) {
      const existing = findRequest.get(request.id) as
        | StoredSourceRequest
        | undefined;
      if (existing === undefined) {
        newRequests.push(request);
      } else if (matchesSource(existing, request)) {
        skipped += 1;
      } else {
        conflictingIds.push(request.id);
      }
    }

    if (conflictingIds.length > 0) {
      throw new ImportConflictError(conflictingIds);
    }

    const insertRequest = database.prepare(
      `INSERT INTO requests (
        id, source, department_hint, requester_role, submitted_at, content, imported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertWorkflow = database.prepare(
      `INSERT INTO request_workflows (request_id, state, version, updated_at)
       VALUES (?, 'Received', 0, ?)`,
    );

    for (const request of newRequests) {
      insertRequest.run(
        request.id,
        request.source,
        request.department_hint,
        request.requester_role,
        request.submitted_at,
        request.content,
        importedAt,
      );
      insertWorkflow.run(request.id, importedAt);
    }

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  return {
    inserted: newRequests.length,
    skipped,
    total: requests.length,
  };
}
