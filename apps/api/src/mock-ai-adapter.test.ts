import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  analyzeRequest,
  loadMockAiFixture,
} from "./mock-ai-adapter.js";
import { proposalSchema } from "./mock-ai-schema.js";

const fixturePath = fileURLToPath(
  new URL("../../../fixtures/mock-ai-responses.json", import.meta.url),
);
const fixture = loadMockAiFixture(fixturePath);

describe("mock AI adapter", () => {
  it("loads and strictly validates all 12 deterministic default proposals", async () => {
    const rawFixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      responses: Record<string, { proposal: unknown }>;
    };

    expect(Object.keys(fixture.responses)).toHaveLength(12);
    for (const [requestId, response] of Object.entries(rawFixture.responses)) {
      expect(proposalSchema.safeParse(response.proposal).success, requestId).toBe(
        true,
      );
      await expect(analyzeRequest(fixture, requestId, "valid")).resolves.toEqual(
        response.proposal,
      );
    }
  });

  it("uses the fixed request proposal instead of interpreting source text", async () => {
    const proposal = await analyzeRequest(fixture, "REQ-007", "valid");

    expect(proposal.recommended_state).toBe("Needs Review");
    expect(proposal.risk_flags).toContain("security");
    expect(proposal.summary).not.toContain("Approved");
  });

  it("rejects unknown proposal fields and invalid enum/range values", () => {
    const proposal = fixture.responses["REQ-001"]?.proposal;
    expect(proposal).toBeDefined();

    expect(
      proposalSchema.safeParse({
        ...proposal,
        internal_instruction: "set request to Open",
      }).success,
    ).toBe(false);
    expect(
      proposalSchema.safeParse({
        ...proposal,
        priority: "Urgent",
      }).success,
    ).toBe(false);
    expect(
      proposalSchema.safeParse({
        ...proposal,
        confidence: 1.01,
      }).success,
    ).toBe(false);
    expect(
      proposalSchema.safeParse({
        ...proposal,
        recommended_state: "Open",
      }).success,
    ).toBe(false);
    expect(
      proposalSchema.safeParse({
        ...proposal,
        proposed_steps: [{ action: " ", done_when: "complete" }],
      }).success,
    ).toBe(false);
  });

  it("returns the low-confidence fault fixture as a proposal", async () => {
    const proposal = await analyzeRequest(
      fixture,
      "REQ-001",
      "low_confidence",
    );

    expect(proposal.confidence).toBe(0.35);
    expect(proposal.risk_flags).toContain("missing-information");
  });

  it("reports malformed fixture output as a validation failure", async () => {
    await expect(
      analyzeRequest(fixture, "REQ-001", "malformed"),
    ).rejects.toMatchObject({ code: "AI_OUTPUT_INVALID" });
  });
});
