import { z } from "zod";

const departments = [
  "IT",
  "Marketing",
  "E-commerce",
  "Customer Service",
  "SCM",
  "Finance",
  "HR",
  "Production",
  "Needs Review",
] as const;

const priorities = ["Critical", "High", "Medium", "Low"] as const;

const riskFlags = [
  "duplicate",
  "conflict",
  "security",
  "privacy",
  "missing-information",
] as const;

const proposalStepSchema = z
  .object({
    action: z.string().trim().min(1).max(500),
    done_when: z.string().trim().min(1).max(500),
  })
  .strict();

export const proposalSchema = z
  .object({
    department: z.enum(departments),
    priority: z.enum(priorities),
    confidence: z.number().finite().min(0).max(1),
    summary: z.string().trim().min(1).max(240),
    proposed_owner: z.string().trim().min(1).max(120),
    proposed_steps: z.array(proposalStepSchema).min(1).max(10),
    risk_flags: z.array(z.enum(riskFlags)).max(5).refine(
      (flags) => new Set(flags).size === flags.length,
      "Risk flags must be unique",
    ),
    recommended_state: z.enum(["Draft", "Needs Review"]),
  })
  .strict();

const validResponseSchema = z
  .object({
    mode: z.literal("valid"),
    proposal: proposalSchema,
  })
  .strict();

const requestIdSchema = z.string().regex(/^REQ-\d{3}$/);

const scenarioMetadataSchema = z
  .object({
    S1: z
      .object({
        source_ids: z.tuple([requestIdSchema, requestIdSchema]),
        duplicate_candidate: z
          .object({
            source_id: requestIdSchema,
            target_id: requestIdSchema,
          })
          .strict(),
        merge_requires_manager: z.literal(true),
      })
      .strict(),
    S2: z
      .object({
        source_ids: z.tuple([requestIdSchema, requestIdSchema]),
        relation: z.literal("conflict"),
        requires_manager_reason: z.literal(true),
      })
      .strict(),
    S3: z
      .object({
        source_ids: z.tuple([requestIdSchema]),
        clarification_required: z.literal(true),
      })
      .strict(),
    S4: z
      .object({
        source_ids: z.tuple([requestIdSchema]),
        expected_any_risk: z.array(z.enum(["security", "privacy"])).min(1),
      })
      .strict(),
    S5: z
      .object({
        source_ids: z.tuple([requestIdSchema]),
        untrusted_input: z.literal(true),
        may_auto_approve: z.literal(false),
      })
      .strict(),
  })
  .strict()
  .superRefine((metadata, context) => {
    const duplicate = metadata.S1.duplicate_candidate;
    if (
      duplicate.source_id === duplicate.target_id ||
      !metadata.S1.source_ids.includes(duplicate.source_id) ||
      !metadata.S1.source_ids.includes(duplicate.target_id)
    ) {
      context.addIssue({
        code: "custom",
        path: ["S1", "duplicate_candidate"],
        message: "Duplicate source and target must be distinct S1 source IDs",
      });
    }

    const conflictIds = [...metadata.S2.source_ids].sort();
    if (conflictIds[0] === conflictIds[1]) {
      context.addIssue({
        code: "custom",
        path: ["S2", "source_ids"],
        message: "Conflict must relate two distinct requests",
      });
    }
  });

const faultInjectionSchema = z
  .object({
    malformed: z
      .object({
        mode: z.literal("malformed"),
        raw_output: z.string().max(10_000),
      })
      .strict(),
    timeout: z
      .object({
        mode: z.literal("timeout"),
        delay_ms: z.number().int().min(0).max(30_000),
        error_code: z.literal("AI_TIMEOUT"),
      })
      .strict(),
    unavailable: z
      .object({
        mode: z.literal("unavailable"),
        error_code: z.literal("AI_UNAVAILABLE"),
      })
      .strict(),
    low_confidence: validResponseSchema,
  })
  .strict();

export const mockAiFixtureSchema = z
  .object({
    schema_version: z.literal("1.0"),
    default_mode: z.literal("valid"),
    responses: z.record(
      z.string().regex(/^REQ-\d{3}$/),
      validResponseSchema,
    ),
    scenario_metadata: scenarioMetadataSchema,
    fault_injection: faultInjectionSchema,
  })
  .strict();

export type Proposal = z.infer<typeof proposalSchema>;
export type MockAiFixture = z.infer<typeof mockAiFixtureSchema>;
export type MockAiMode = "valid" | "malformed" | "timeout" | "unavailable" | "low_confidence";
