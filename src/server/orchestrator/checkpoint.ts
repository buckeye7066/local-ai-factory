import { z } from "zod";
import { ResearchFindingsSchema } from "../agents/researchAgent.js";
import {
  ArchitectureSchema,
  FileBuildSchema,
  FileContentSchema,
  FinalReportSchema,
  ProductSpecSchema,
  QaReportSchema,
  RepairResultSchema,
  RunIdSchema,
  RunOptionsSchema,
  TaskPlanSchema,
  TestPlanSchema,
} from "../../shared/schemas.js";

/**
 * Private durable execution state. This is stored under .factory/checkpoints
 * and is never returned by the runs API. It contains the raw idea and raw model
 * outputs required to continue without replaying completed provider calls.
 */
export const FactoryCheckpointSchema = z.object({
  schemaVersion: z.literal(1),
  runId: RunIdSchema,
  idea: z.string(),
  options: RunOptionsSchema,
  spec: ProductSpecSchema.optional(),
  architecture: ArchitectureSchema.optional(),
  /** Keyless web research (extend-era feature) — persisted so a resume never replays it. */
  research: ResearchFindingsSchema.optional(),
  plan: TaskPlanSchema.optional(),
  build: FileBuildSchema.optional(),
  testPlan: TestPlanSchema.optional(),
  files: z.array(FileContentSchema).default([]),
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
            outputTail: z.string().default(""),
          }),
        )
        .default([]),
    })
    .optional(),
  testsExecuted: z.boolean().default(false),
  testExit: z.number().int().nullable().default(null),
  qa: QaReportSchema.optional(),
  repairLoops: z.number().int().nonnegative().default(0),
  pendingRepair: RepairResultSchema.optional(),
  repairComplete: z.boolean().default(false),
  finalReport: FinalReportSchema.optional(),
  updatedAt: z.number(),
});

export type FactoryCheckpoint = z.infer<typeof FactoryCheckpointSchema>;
