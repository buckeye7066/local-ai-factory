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

const RefusalSchema = z.object({
  path: z.string(),
  reason: z.string(),
});

const VerificationSchema = z.object({
  executed: z
    .array(
      z.object({
        command: z.string(),
        exitCode: z.number().int().nullable(),
        isTest: z.boolean().optional(),
        directTestPath: z.string().optional(),
        isBrowser: z.boolean().optional(),
        runner: z.enum(["vitest", "jest", "playwright", "pytest"]).optional(),
        directEvidenceValid: z.boolean().optional(),
        passedCount: z.number().int().nonnegative().optional(),
        skippedCount: z.number().int().nonnegative().optional(),
        passedTestNames: z.array(z.string()).optional(),
        outputTail: z.string().default(""),
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
});

/**
 * Fields shared by every checkpoint generation.
 *
 * The v3-only safety fields deliberately carry deterministic defaults. This
 * lets the loader upgrade v1/v2 records without trusting ad-hoc coercion at
 * every call site, while the public v3 schema still rejects old versions.
 */
const CheckpointBodySchema = z.object({
  runId: RunIdSchema,
  idea: z.string(),
  options: RunOptionsSchema,
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
  files: z.array(FileContentSchema).default([]),
  /** Durable safety ledger: a restart/resume must never forget refused writes. */
  writeRefusals: z.array(RefusalSchema).default([]),
  /** Only refused required builder/test writes block delivery permanently. */
  blockingWriteRefusals: z.array(RefusalSchema).default([]),
  testWriterComplete: z.boolean().default(false),
  commandOutput: z.string().default(""),
  /**
   * Structured record of commands that actually executed in the last
   * verification pass. A resumed run judges the same evidence as a fresh one.
   */
  verification: VerificationSchema.optional(),
  testsExecuted: z.boolean().default(false),
  testExit: z.number().int().nullable().default(null),
  qa: QaReportSchema.optional(),
  repairLoops: z.number().int().nonnegative().default(0),
  pendingRepair: RepairResultSchema.optional(),
  repairComplete: z.boolean().default(false),
  finalReport: FinalReportSchema.optional(),
  updatedAt: z.number(),
});

/**
 * Private durable execution state. This is stored under .factory/checkpoints
 * and is never returned by the runs API. It contains raw inputs and provider
 * outputs required to continue without replaying completed model calls.
 */
export const FactoryCheckpointSchema = CheckpointBodySchema.extend({
  schemaVersion: z.literal(3),
});

const LegacyFactoryCheckpointSchema = CheckpointBodySchema.extend({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
});

export type FactoryCheckpoint = z.infer<typeof FactoryCheckpointSchema>;

export class UnsupportedCheckpointVersionError extends Error {
  readonly version: unknown;

  constructor(version: unknown) {
    super(
      `Unsupported Factory Deck checkpoint schema version ${JSON.stringify(
        version,
      )}; this runtime supports v1/v2 migration and native v3 checkpoints.`,
    );
    this.name = "UnsupportedCheckpointVersionError";
    this.version = version;
  }
}

/**
 * Parse a persisted checkpoint and deterministically migrate supported legacy
 * generations into the current v3 shape. Callers receive only v3 values.
 *
 * Unknown versions are never treated as "missing": silently discarding one
 * would replay already-paid model stages and can repeat workspace mutations.
 */
export function migrateFactoryCheckpoint(input: unknown): FactoryCheckpoint {
  const version =
    input && typeof input === "object"
      ? (input as { schemaVersion?: unknown }).schemaVersion
      : undefined;

  if (version === 3) {
    return FactoryCheckpointSchema.parse(input);
  }
  if (version === 1 || version === 2) {
    const legacy = LegacyFactoryCheckpointSchema.parse(input);
    const rawOptions =
      input && typeof input === "object"
        ? (input as { options?: Record<string, unknown> }).options
        : undefined;
    // Before v3 there was no separate authorization bit: explicitly naming a
    // paid provider was the operator's only paid-routing action. Preserve that
    // intent during migration, but never infer authorization from configured
    // keys or server defaults.
    const explicitlySelectedPaid = [
      rawOptions?.codeProvider,
      rawOptions?.reviewProvider,
    ].some((name) => name === "anthropic" || name === "openai");
    return FactoryCheckpointSchema.parse({
      ...legacy,
      schemaVersion: 3,
      options: {
        ...legacy.options,
        allowPaidProviderCalls:
          legacy.options.allowPaidProviderCalls ?? explicitlySelectedPaid,
      },
      builderExistingPaths: legacy.builderExistingPaths ?? [],
      hostFileBaselines: legacy.hostFileBaselines ?? {},
      writeRefusals: legacy.writeRefusals ?? [],
      blockingWriteRefusals: legacy.blockingWriteRefusals ?? [],
    });
  }
  throw new UnsupportedCheckpointVersionError(version);
}
