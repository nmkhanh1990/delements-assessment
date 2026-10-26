import { readFileSync } from "node:fs";
import type { Proposal } from "./mock-ai-schema.js";
import {
  mockAiFixtureSchema,
  proposalSchema,
  type MockAiFixture,
  type MockAiMode,
} from "./mock-ai-schema.js";

export type AiErrorCode = "AI_OUTPUT_INVALID" | "AI_TIMEOUT" | "AI_UNAVAILABLE";

export class MockAiError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MockAiError";
  }
}

export class MockAiConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MockAiConfigurationError";
  }
}

export function loadMockAiFixture(fixturePath: string): MockAiFixture {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(fixturePath, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Invalid JSON";
    throw new MockAiConfigurationError(
      `Could not load mock AI fixture: ${detail}`,
    );
  }

  const result = mockAiFixtureSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new MockAiConfigurationError(
      `Mock AI fixture does not match its schema: ${detail}`,
    );
  }

  return result.data;
}

function validateRawProposal(rawOutput: string): Proposal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawOutput);
  } catch {
    throw new MockAiError(
      "AI_OUTPUT_INVALID",
      "Mock AI returned invalid JSON",
    );
  }

  const result = proposalSchema.safeParse(parsed);
  if (!result.success) {
    throw new MockAiError(
      "AI_OUTPUT_INVALID",
      "Mock AI proposal failed strict schema validation",
    );
  }

  return result.data;
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export async function analyzeRequest(
  fixture: MockAiFixture,
  requestId: string,
  mode: MockAiMode,
): Promise<Proposal> {
  if (mode === "valid") {
    const response = fixture.responses[requestId];
    if (response === undefined) {
      throw new MockAiError(
        "AI_UNAVAILABLE",
        `No mock AI response is configured for ${requestId}`,
      );
    }
    return response.proposal;
  }

  if (mode === "low_confidence") {
    return fixture.fault_injection.low_confidence.proposal;
  }

  if (mode === "malformed") {
    return validateRawProposal(fixture.fault_injection.malformed.raw_output);
  }

  if (mode === "timeout") {
    await wait(fixture.fault_injection.timeout.delay_ms);
    throw new MockAiError("AI_TIMEOUT", "Mock AI analysis timed out");
  }

  throw new MockAiError(
    "AI_UNAVAILABLE",
    "Mock AI service is unavailable",
  );
}
