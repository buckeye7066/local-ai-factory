import { z } from "zod";
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
  plan: TaskPlanSchema.optional(),
  build: FileBuildSchema.optional(),
  testPlan: TestPlanSchema.optional(),
  files: z.array(FileContentSchema).default([]),
  testWriterComplete: z.boolean().default(false),
  commandOutput: z.string().default(""),
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
