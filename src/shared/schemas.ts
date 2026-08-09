import { z } from "zod";

/**
 * shared/schemas.ts — the single source of truth.
 *
 * Every agent returns data validated by a Zod schema here, and the UI renders
 * the exact same shapes. Backend and frontend both import these, so there is
 * one contract and no drift. Secrets and raw prompts are NEVER part of any
 * schema that crosses the wire to the browser.
 */

/* ------------------------------------------------------------------ */
/* Canonical pipeline stages (assembly-line stations)                  */
/* ------------------------------------------------------------------ */

export const STAGE_IDS = [
  "intake",
  "product_spec",
  "architect",
  "task_planner",
  "builder",
  "test_writer",
  "qa_critic",
  "repair",
  "final_review",
] as const;

export const StageIdSchema = z.enum(STAGE_IDS);
export type StageId = z.infer<typeof StageIdSchema>;

export const StageStatusSchema = z.enum([
  "pending",
  "active",
  "completed",
  "failed",
  "skipped",
]);
export type StageStatus = z.infer<typeof StageStatusSchema>;

export const StageStateSchema = z.object({
  id: StageIdSchema,
  name: z.string(),
  description: z.string(),
  status: StageStatusSchema,
  startedAt: z.number().nullable().default(null),
  endedAt: z.number().nullable().default(null),
  durationMs: z.number().nullable().default(null),
});
export type StageState = z.infer<typeof StageStateSchema>;

/* ------------------------------------------------------------------ */
/* Logs                                                                */
/* ------------------------------------------------------------------ */

export const LogKindSchema = z.enum([
  "info",
  "success",
  "warning",
  "error",
  "model_call",
  "file_write",
  "command_run",
]);
export type LogKind = z.infer<typeof LogKindSchema>;

export const LogLineSchema = z.object({
  id: z.string(),
  ts: z.number(),
  stage: StageIdSchema.nullable().default(null),
  kind: LogKindSchema,
  message: z.string(),
});
export type LogLine = z.infer<typeof LogLineSchema>;

/* ------------------------------------------------------------------ */
/* Generated file summaries (metadata only on the wire)                */
/* ------------------------------------------------------------------ */

export const FileSummarySchema = z.object({
  path: z.string(),
  language: z.string(),
  size: z.number(),
  status: z.enum(["generated", "modified"]),
  purpose: z.string().default(""),
});
export type FileSummary = z.infer<typeof FileSummarySchema>;

export const FileContentSchema = FileSummarySchema.extend({
  contents: z.string(),
});
export type FileContent = z.infer<typeof FileContentSchema>;

/* ------------------------------------------------------------------ */
/* Provider usage (counts only — no prompts, no secrets)               */
/* ------------------------------------------------------------------ */

export const ProviderUsageSchema = z.object({
  anthropic: z.object({ calls: z.number() }).default({ calls: 0 }),
  openai: z.object({ calls: z.number() }).default({ calls: 0 }),
  stub: z.object({ calls: z.number() }).default({ calls: 0 }),
  mock: z.object({ calls: z.number() }).default({ calls: 0 }),
  totalCalls: z.number().default(0),
});
export type ProviderUsage = z.infer<typeof ProviderUsageSchema>;

/* ------------------------------------------------------------------ */
/* Agent output schemas                                                */
/* ------------------------------------------------------------------ */

export const ProductSpecSchema = z.object({
  appName: z.string(),
  tagline: z.string().default(""),
  targetUser: z.string(),
  coreFeatures: z.array(z.string()).min(1),
  dataModel: z
    .array(
      z.object({
        entity: z.string(),
        fields: z.array(z.string()),
      }),
    )
    .default([]),
  userFlows: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).min(1),
});
export type ProductSpec = z.infer<typeof ProductSpecSchema>;

export const ArchitectureSchema = z.object({
  overview: z.string(),
  frontend: z.string(),
  backend: z.string(),
  dataModel: z.string(),
  risks: z.array(z.string()).default([]),
});
export type Architecture = z.infer<typeof ArchitectureSchema>;

export const TaskPlanSchema = z.object({
  tasks: z
    .array(
      z.object({
        order: z.number(),
        category: z.enum(["frontend", "backend", "database", "tests", "docs"]),
        title: z.string(),
        detail: z.string().default(""),
      }),
    )
    .min(1),
});
export type TaskPlan = z.infer<typeof TaskPlanSchema>;

export const FileBuildSchema = z.object({
  files: z
    .array(
      z.object({
        path: z.string(),
        purpose: z.string().default(""),
        contents: z.string(),
      }),
    )
    .min(1),
});
export type FileBuild = z.infer<typeof FileBuildSchema>;

export const TestPlanSchema = z.object({
  testPlan: z.string(),
  files: z
    .array(
      z.object({
        path: z.string(),
        purpose: z.string().default(""),
        contents: z.string(),
      }),
    )
    .default([]),
});
export type TestPlan = z.infer<typeof TestPlanSchema>;

export const QaSeveritySchema = z.enum(["low", "medium", "high", "critical"]);
export type QaSeverity = z.infer<typeof QaSeveritySchema>;

export const QaReportSchema = z.object({
  summary: z.string(),
  passed: z.boolean(),
  issues: z
    .array(
      z.object({
        severity: QaSeveritySchema,
        title: z.string(),
        detail: z.string().default(""),
        file: z.string().nullable().default(null),
        repairInstruction: z.string().default(""),
      }),
    )
    .default([]),
});
export type QaReport = z.infer<typeof QaReportSchema>;

export const RepairResultSchema = z.object({
  notes: z.string().default(""),
  files: z
    .array(
      z.object({
        path: z.string(),
        purpose: z.string().default(""),
        contents: z.string(),
      }),
    )
    .default([]),
});
export type RepairResult = z.infer<typeof RepairResultSchema>;

export const FinalReportSchema = z.object({
  appName: z.string(),
  summary: z.string(),
  whatWasBuilt: z.array(z.string()).default([]),
  howToRun: z.string(),
  testStatus: z.enum(["passing", "failing", "skipped", "unknown"]),
  repairLoops: z.number().default(0),
  caveats: z.array(z.string()).default([]),
  nextImprovements: z.array(z.string()).default([]),
  workspacePath: z.string(),
  providerUsage: ProviderUsageSchema,
});
export type FinalReport = z.infer<typeof FinalReportSchema>;

/* ------------------------------------------------------------------ */
/* Run options + run record (the object the UI polls)                  */
/* ------------------------------------------------------------------ */

export const ProviderNameSchema = z.enum(["anthropic", "openai", "stub", "mock"]);
export type ProviderName = z.infer<typeof ProviderNameSchema>;

export const RunOptionsSchema = z.object({
  codeProvider: ProviderNameSchema.optional(),
  reviewProvider: ProviderNameSchema.optional(),
  demo: z.boolean().optional(),
  maxRepairLoops: z.number().optional(),
  /** Client-supplied idempotency key (also accepted via Idempotency-Key header). */
  idempotencyKey: z.string().min(1).max(200).optional(),
  /** Optional overall run timeout in ms (overrides FACTORY_RUN_TIMEOUT_MS). */
  timeoutMs: z.number().int().positive().max(3_600_000).optional(),
});
export type RunOptions = z.infer<typeof RunOptionsSchema>;

/** Per-job attribution so every generated change is traceable (acceptance #244). */
export const RunAttributionSchema = z.object({
  jobId: z.string().uuid(),
  worktreePath: z.string().nullable().default(null),
  approval: z.object({
    dryRunCommands: z.boolean(),
    allowUntrustedScripts: z.boolean(),
  }),
  testResult: z
    .enum(["passing", "failing", "skipped", "unknown", "not_run"])
    .nullable()
    .default(null),
  /** Path to the durable attribution manifest under .factory/attribution/. */
  commitPath: z.string().nullable().default(null),
  /** How to roll back: delete this worktree (jailed under WORKSPACE_ROOT). */
  rollbackPath: z.string().nullable().default(null),
  auditSeq: z.number().nullable().default(null),
});
export type RunAttribution = z.infer<typeof RunAttributionSchema>;

export const RunStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/**
 * Run IDs are always minted with randomUUID(). Constraining the schema to a
 * strict UUID means a hand-crafted/corrupt record whose `id` contains path
 * separators or `..` fails validation on load — so it can never be used to build
 * an out-of-store write path (defense-in-depth alongside the store's own
 * containment check).
 */
export const RunIdSchema = z.string().uuid();
export type RunId = z.infer<typeof RunIdSchema>;

/** True when `id` is a well-formed run id safe to use as a storage filename. */
export function isValidRunId(id: string): boolean {
  return RunIdSchema.safeParse(id).success;
}

export const RunRecordSchema = z.object({
  id: RunIdSchema,
  idea: z.string(),
  status: RunStatusSchema,
  demo: z.boolean(),
  codeProvider: ProviderNameSchema,
  reviewProvider: ProviderNameSchema,
  currentStage: StageIdSchema.nullable().default(null),
  stages: z.array(StageStateSchema),
  logs: z.array(LogLineSchema),
  files: z.array(FileSummarySchema),
  repairLoops: z.number().default(0),
  providerUsage: ProviderUsageSchema,
  finalReport: FinalReportSchema.nullable().default(null),
  appName: z.string().nullable().default(null),
  workspacePath: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  /** Populated as the run progresses; full attribution written at completion. */
  attribution: RunAttributionSchema.nullable().default(null),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

/** Compact summary used by the Run History list. */
export const RunSummarySchema = RunRecordSchema.pick({
  id: true,
  idea: true,
  status: true,
  demo: true,
  codeProvider: true,
  reviewProvider: true,
  appName: true,
  workspacePath: true,
  repairLoops: true,
  createdAt: true,
  updatedAt: true,
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

/* ------------------------------------------------------------------ */
/* Health (no secrets — only "configured" booleans)                    */
/* ------------------------------------------------------------------ */

export const HealthSchema = z.object({
  ok: z.literal(true),
  /** Always true when this process answers — independent of paid providers (#237). */
  controlPlaneOk: z.boolean(),
  service: z.literal("factory-deck").optional(),
  /** Deterministic offline provider is always available. */
  mockConfigured: z.boolean(),
  anthropicConfigured: z.boolean(),
  openaiConfigured: z.boolean(),
  providersAvailable: z.array(ProviderNameSchema),
  anthropicModel: z.string(),
  openaiModel: z.string(),
  defaultCodeProvider: ProviderNameSchema,
  defaultReviewProvider: ProviderNameSchema,
  maxRepairLoops: z.number(),
  maxModelCallsPerRun: z.number(),
  runTimeoutMs: z.number(),
  workspaceRoot: z.string(),
  dryRunCommands: z.boolean(),
  allowUntrustedScripts: z.boolean().optional(),
});
export type Health = z.infer<typeof HealthSchema>;

/* ------------------------------------------------------------------ */
/* Stage catalog — names + descriptions shared by orchestrator & UI    */
/* ------------------------------------------------------------------ */

export const STAGE_CATALOG: Record<StageId, { name: string; description: string }> = {
  intake: {
    name: "Intake",
    description: "Capture and normalize the raw app idea.",
  },
  product_spec: {
    name: "Product Spec",
    description: "Define users, features, data model, acceptance criteria.",
  },
  architect: {
    name: "Architect",
    description: "Design frontend, backend, data, and surface risks.",
  },
  task_planner: {
    name: "Task Planner",
    description: "Order the build into concrete tasks by category.",
  },
  builder: {
    name: "Builder",
    description: "Generate the working app files into the workspace.",
  },
  test_writer: {
    name: "Test Writer",
    description: "Author tests and a test plan, then run checks.",
  },
  qa_critic: {
    name: "QA Critic",
    description: "Review output, classify issues by severity.",
  },
  repair: {
    name: "Repair Loop",
    description: "Patch failing files and re-verify, bounded by a cap.",
  },
  final_review: {
    name: "Final Review",
    description: "Summarize what shipped, how to run it, and caveats.",
  },
};

export function freshStages(): StageState[] {
  return STAGE_IDS.map((id) => ({
    id,
    name: STAGE_CATALOG[id].name,
    description: STAGE_CATALOG[id].description,
    status: "pending" as StageStatus,
    startedAt: null,
    endedAt: null,
    durationMs: null,
  }));
}
