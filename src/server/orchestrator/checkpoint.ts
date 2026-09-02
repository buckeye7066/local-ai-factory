import { z } from "zod";
import { ResearchFindingsSchema } from "../agents/researchAgent.js";
import {
  ArchitectureSchema,
  FileBuildSchema,
  FileContentSchema,
  FinalReportSchema,
  GoalContractSchema,
  PurposeProfileSchema,
  ProductSpecSchema,
  QaReportSchema,
  RepairResultSchema,
  RunIdSchema,
  RunOptionsSchema,
  TaskPlanSchema,
  TestPlanSchema,
} from "../../shared/schemas.js";

const PreReleaseBrainReviewSchema = z.object({
  // Accept both current reviewer slots and legacy identities so old checkpoints
  // remain resumable after the paid-ladder migration.
  identity: z.enum(["lead", "challenger", "sol", "fable", "opus"]),
  provider: z.enum(["openai", "anthropic"]),
  model: z.string().min(1),
  evidenceDigest: z.string().min(1),
  decision: z.enum(["ready", "not_ready"]),
  purposeAligned: z.boolean(),
  implementationComplete: z.boolean(),
  technicallyReady: z.boolean(),
  blockers: z.array(
    z.object({
      category: z.enum([
        "purpose",
        "implementation",
        "verification",
        "security",
        "operations",
        "delivery",
        "usability",
        "performance",
      ]),
      detail: z.string(),
    }),
  ),
});

/**
 * Private durable execution state. This is stored under .factory/checkpoints
 * and is never returned by the runs API. It contains the raw idea and raw model
 * outputs required to continue without replaying completed provider calls.
 */
export const FactoryCheckpointSchema = z.object({
  schemaVersion: z.literal(3),
  runId: RunIdSchema,
  idea: z.string(),
  options: RunOptionsSchema,
  /** Stable identity joining separate runs for the same target project. */
  projectKey: z.string().min(1).max(500).optional(),
  /** Immutable mission and continuity contract stamped into every downstream spec. */
  goalContract: GoalContractSchema.optional(),
  /** Repository-grounded standing purpose; extend runs carry it through planning. */
  purposeProfile: PurposeProfileSchema.optional(),
  spec: ProductSpecSchema.optional(),
  architecture: ArchitectureSchema.optional(),
  /** Keyless web research (extend-era feature) — persisted so a resume never replays it. */
  research: ResearchFindingsSchema.optional(),
  plan: TaskPlanSchema.optional(),
  build: FileBuildSchema.optional(),
  /** Captured before builder writes; generated code cannot self-author its browser authority. */
  baselineBrowserHarness: z.boolean().optional(),
  /** Existing host paths shown in full to the builder; all other host edits are refused. */
  builderExistingPaths: z.array(z.string()).default([]),
  /** Immutable pre-run host contents used to bound cumulative change across repair passes. */
  hostFileBaselines: z.record(z.string()).default({}),
  testPlan: TestPlanSchema.optional(),
  /** Last paid Test Writer draft persisted before deterministic validation. */
  testPlanDraft: z.number().int().min(1).max(3).optional(),
  files: z.array(FileContentSchema).default([]),
  /** Durable safety ledger: a restart/resume must never forget refused writes. */
  writeRefusals: z
    .array(
      z.object({
        path: z.string(),
        reason: z.string(),
      }),
    )
    .default([]),
  /** Only refused required builder/test writes block delivery permanently. */
  blockingWriteRefusals: z
    .array(
      z.object({
        path: z.string(),
        reason: z.string(),
      }),
    )
    .default([]),
  testWriterComplete: z.boolean().default(false),
  commandOutput: z.string().default(""),
  /**
   * Structured record of the commands that actually EXECUTED in the last
   * verification pass — the evidence that grounds every QA verdict
   * (qaGrounding.ts). Kept beside commandOutput so a resumed run judges the
   * same evidence a fresh one would.
   */
  verification: z
    .object({
      executed: z
        .array(
          z.object({
            command: z.string(),
            exitCode: z.number().int().nullable(),
            isTest: z.boolean().optional(),
            directTestPath: z.string().optional(),
            isBrowser: z.boolean().optional(),
            hostPlatform: z
              .enum([
                "aix",
                "android",
                "darwin",
                "freebsd",
                "haiku",
                "linux",
                "openbsd",
                "sunos",
                "win32",
                "cygwin",
                "netbsd",
              ])
              .optional(),
            verifiedTargets: z
              .array(z.enum(["windows", "webkit", "macos", "ios", "android"]))
              .optional(),
            runner: z.enum(["vitest", "jest", "playwright", "pytest"]).optional(),
            directEvidenceValid: z.boolean().optional(),
            passedCount: z.number().int().nonnegative().optional(),
            skippedCount: z.number().int().nonnegative().optional(),
            passedTestNames: z.array(z.string()).optional(),
            outputTail: z.string().max(32_768).default(""),
          }),
        )
        .default([]),
      incomplete: z
        .array(
          z.object({
            command: z.string(),
            reason: z.string(),
          }),
        )
        .optional(),
      /** SHA-256 receipt for every deliverable path after the last verification pass. */
      fileDigests: z.record(z.string()).optional(),
    })
    .optional(),
  testsExecuted: z.boolean().default(false),
  testExit: z.number().int().nullable().default(null),
  qa: QaReportSchema.optional(),
  repairLoops: z.number().int().nonnegative().default(0),
  pendingRepair: RepairResultSchema.optional(),
  repairComplete: z.boolean().default(false),
  finalReport: FinalReportSchema.optional(),
  /** Exact candidate-byte approval earned before any release/deploy side effect. */
  preReleaseApproval: z
    .object({
      schema: z.literal("factory.pre-release-readiness.v1"),
      evidenceDigest: z.string().min(1),
      approved: z.boolean(),
      reviews: z.array(PreReleaseBrainReviewSchema),
      blockers: z.array(z.string()),
    })
    .optional(),
  updatedAt: z.number(),
});

export type FactoryCheckpoint = z.infer<typeof FactoryCheckpointSchema>;
