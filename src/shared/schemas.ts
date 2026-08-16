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
  free: z.object({ calls: z.number() }).default({ calls: 0 }),
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

/** Coerce LLM list items that arrive as objects into readable strings. */
function coerceStringList(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (item && typeof item === "object") {
        const o = item as Record<string, unknown>;
        const parts = [
          o.name,
          o.title,
          o.feature,
          o.flow,
          o.label,
          o.id,
          o.criterion,
          o.description,
          o.summary,
          o.detail,
        ].filter((x): x is string => typeof x === "string" && x.trim().length > 0);
        if (parts.length) return [...new Set(parts)].join(" — ");
        try {
          return JSON.stringify(item);
        } catch {
          return String(item);
        }
      }
      if (item == null) return "";
      return String(item);
    })
    .filter((s) => s.length > 0);
}

/** Accept either [{entity,fields}] or {EntityName: fields|fieldMap}. */
function coerceDataModel(val: unknown): { entity: string; fields: string[] }[] {
  if (Array.isArray(val)) {
    return val
      .map((row) => {
        if (!row || typeof row !== "object") return null;
        const o = row as Record<string, unknown>;
        const entity = String(o.entity ?? o.name ?? o.table ?? "").trim();
        const rawFields = o.fields ?? o.columns ?? o.properties ?? [];
        const fields = Array.isArray(rawFields)
          ? coerceStringList(rawFields)
          : rawFields && typeof rawFields === "object"
            ? Object.keys(rawFields as object)
            : [];
        if (!entity) return null;
        return { entity, fields };
      })
      .filter((x): x is { entity: string; fields: string[] } => x !== null);
  }
  if (val && typeof val === "object") {
    return Object.entries(val as Record<string, unknown>).map(([entity, fields]) => ({
      entity,
      fields: Array.isArray(fields)
        ? coerceStringList(fields)
        : fields && typeof fields === "object"
          ? Object.keys(fields as object)
          : [String(fields)],
    }));
  }
  return [];
}

const StringListSchema = z.preprocess(coerceStringList, z.array(z.string()));
const NonEmptyStringListSchema = z.preprocess(
  coerceStringList,
  z.array(z.string()).min(1),
);
const DataModelSchema = z.preprocess(
  coerceDataModel,
  z
    .array(
      z.object({
        entity: z.string(),
        fields: z.array(z.string()),
      }),
    )
    .default([]),
);

/** Flatten object/array LLM blobs into a single readable string field. */
function coerceToReadableString(val: unknown): string {
  if (typeof val === "string") return val;
  if (val == null) return "";
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  if (Array.isArray(val)) return coerceStringList(val).join("; ");
  if (typeof val === "object") {
    const o = val as Record<string, unknown>;
    const preferred = [
      o.summary,
      o.description,
      o.overview,
      o.text,
      o.detail,
      o.name,
    ].filter((x): x is string => typeof x === "string" && x.trim().length > 0);
    if (preferred.length) return preferred.join(" — ");
    try {
      return JSON.stringify(val);
    } catch {
      return String(val);
    }
  }
  return String(val);
}

const ReadableStringSchema = z.preprocess(coerceToReadableString, z.string());

export const ProductSpecSchema = z.object({
  appName: z.string(),
  tagline: z.string().default(""),
  targetUser: z.string(),
  coreFeatures: NonEmptyStringListSchema,
  dataModel: DataModelSchema,
  userFlows: StringListSchema.default([]),
  acceptanceCriteria: NonEmptyStringListSchema,
});
export type ProductSpec = z.infer<typeof ProductSpecSchema>;

export const ArchitectureSchema = z.object({
  overview: ReadableStringSchema,
  frontend: ReadableStringSchema,
  backend: ReadableStringSchema,
  dataModel: ReadableStringSchema,
  risks: StringListSchema.default([]),
});
export type Architecture = z.infer<typeof ArchitectureSchema>;

const TaskCategorySchema = z.preprocess(
  (val) => {
    const s = String(val ?? "")
      .toLowerCase()
      .trim();
    if (["frontend", "backend", "database", "tests", "docs"].includes(s)) return s;
    if (s.includes("front") || s.includes("ui")) return "frontend";
    if (s.includes("back") || s.includes("api") || s.includes("server"))
      return "backend";
    if (s.includes("data") || s.includes("db") || s.includes("sql")) return "database";
    if (s.includes("test")) return "tests";
    return "docs";
  },
  z.enum(["frontend", "backend", "database", "tests", "docs"]),
);

function coerceTaskPlan(val: unknown): unknown {
  if (Array.isArray(val)) return { tasks: val };
  if (!val || typeof val !== "object") return val;
  const o = val as Record<string, unknown>;
  if (Array.isArray(o.tasks)) return o;
  // Nested wrappers some models emit.
  for (const nestKey of ["taskPlan", "result", "data", "output"]) {
    const nested = o[nestKey];
    if (nested && typeof nested === "object") {
      const coerced = coerceTaskPlan(nested);
      if (
        coerced &&
        typeof coerced === "object" &&
        Array.isArray((coerced as { tasks?: unknown }).tasks)
      ) {
        return coerced;
      }
    }
  }
  for (const key of [
    "items",
    "plan",
    "steps",
    "taskList",
    "buildTasks",
    "todos",
    "todo",
  ]) {
    if (Array.isArray(o[key])) return { ...o, tasks: o[key] };
  }
  for (const v of Object.values(o)) {
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object") {
      return { ...o, tasks: v };
    }
  }
  return o;
}

export const TaskPlanSchema = z.preprocess(
  coerceTaskPlan,
  z.object({
    tasks: z
      .array(
        z.object({
          order: z.coerce.number().default(0),
          category: TaskCategorySchema,
          title: ReadableStringSchema,
          detail: ReadableStringSchema.default(""),
        }),
      )
      .min(1),
  }),
);
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
  summary: ReadableStringSchema,
  whatWasBuilt: StringListSchema.default([]),
  howToRun: ReadableStringSchema,
  testStatus: z.enum(["passing", "failing", "skipped", "unknown"]),
  repairLoops: z.coerce.number().default(0),
  caveats: StringListSchema.default([]),
  nextImprovements: StringListSchema.default([]),
  workspacePath: z.string(),
  providerUsage: ProviderUsageSchema,
});
export type FinalReport = z.infer<typeof FinalReportSchema>;

/* ------------------------------------------------------------------ */
/* Run options + run record (the object the UI polls)                  */
/* ------------------------------------------------------------------ */

/**
 * "free" is the local FCC/Ollama route and is the DEFAULT primary. It is a
 * live provider (it really builds software), it just costs nothing — so unlike
 * mock/stub it is never treated as an offline demo.
 */
export const ProviderNameSchema = z.enum([
  "free",
  "anthropic",
  "openai",
  "stub",
  "mock",
]);
export type ProviderName = z.infer<typeof ProviderNameSchema>;

/**
 * Where an EXISTING codebase to extend comes from. "path" is a local directory
 * on this machine; "git" is a clonable URL. `inPlace` is an explicit, narrow
 * opt-in to operate directly on that local path instead of Factory Deck's
 * default (always copy/clone into an isolated workspace first) — it must never
 * default to true, since it is the one setting that lets a run write into a
 * real project tree the owner did not hand Factory Deck a throwaway copy of.
 */
export const RepoSourceSchema = z.object({
  type: z.enum(["path", "git"]),
  location: z.string().min(1),
  /** Operate directly on `location` instead of an isolated copy. Default false. */
  inPlace: z.boolean().optional(),
});
export type RepoSource = z.infer<typeof RepoSourceSchema>;

/**
 * A NEW app's repo identity. The owner names the app/repo up front (Factory
 * Deck never invents a name and never buries a from-scratch build in an
 * anonymous workspace folder); the run then git-inits that workspace and, when
 * `createRemote` is not explicitly false, creates `owner/name` on GitHub and
 * pushes the finished work there.
 */
export const NewRepoSchema = z.object({
  name: z.string().min(1).max(100),
  /** GitHub owner (user or org). Defaults to FACTORY_GITHUB_OWNER / gh's user. */
  owner: z.string().min(1).max(39).optional(),
  /** Create the repo private. Default true. */
  private: z.boolean().optional(),
  /** Create the GitHub repo at all. Default true; false = local git only. */
  createRemote: z.boolean().optional(),
});
export type NewRepo = z.infer<typeof NewRepoSchema>;

/**
 * GitHub's own repo-name rule: letters, digits, `.`, `-`, `_`. Anything else is
 * silently rewritten by GitHub (which would hand the owner a repo they did not
 * ask for), so it is refused here instead — up front, in the UI and again on
 * the server.
 */
export function repoNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Name is required.";
  if (trimmed.length > 100) return "Name must be 100 characters or fewer.";
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    return "Use only letters, digits, dots, dashes and underscores.";
  }
  if (trimmed === "." || trimmed === "..") return "Name cannot be '.' or '..'.";
  if (trimmed.startsWith("-") || trimmed.startsWith(".")) {
    return "Name cannot start with '-' or '.'.";
  }
  if (trimmed.endsWith(".git")) return "Name cannot end with '.git'.";
  return null;
}

export function isValidRepoName(name: string): boolean {
  return repoNameProblem(name) === null;
}

/**
 * WHERE THE FINISHED WORK IS SAVED. The owner's rule: "whichever git repo I add
 * prior to the prompt is the one that the work should be saved in." This is set
 * on the run BEFORE any building happens (so the UI can show the destination up
 * front) and updated once delivery has actually been attempted — `status` is
 * the honest record of whether the push/creation really happened.
 */
export const RunDestinationSchema = z.object({
  kind: z.enum(["existing-repo", "new-repo", "workspace-only"]),
  /** Git URL, local repo path, or `owner/name` for a repo to be created. */
  target: z.string(),
  /** Branch the work is committed onto (null for a brand-new repo's default). */
  branch: z.string().nullable().default(null),
  status: z.enum(["planned", "delivered", "failed", "skipped"]).default("planned"),
  /** Human-readable outcome or the exact git/gh failure. */
  detail: z.string().nullable().default(null),
  /** Browsable URL once known (repo page, or a compare/PR link). */
  url: z.string().nullable().default(null),
  deliveredAt: z.number().nullable().default(null),
});
export type RunDestination = z.infer<typeof RunDestinationSchema>;

export const RunOptionsSchema = z.object({
  codeProvider: ProviderNameSchema.optional(),
  reviewProvider: ProviderNameSchema.optional(),
  demo: z.boolean().optional(),
  /**
   * Publish the finished app to the owner's app store (axiombiolabs.org
   * registry, which PromoPilot promotes from). Default true. Owner order
   * 2026-08-15: "some things I work on are just for me" - unchecked, the app
   * is still built, saved to GitHub, and hosted, but never listed or promoted.
   */
  publish: z.boolean().optional(),
  maxRepairLoops: z.number().optional(),
  /** Client-supplied idempotency key (also accepted via Idempotency-Key header). */
  idempotencyKey: z.string().min(1).max(200).optional(),
  /** Optional overall run timeout in ms (overrides FACTORY_RUN_TIMEOUT_MS). */
  timeoutMs: z.number().int().positive().max(3_600_000).optional(),
  /**
   * "new" (default) builds a fresh app from `idea`, exactly as before.
   * "extend" ingests an existing codebase (from `repoSource`, or resolved
   * automatically from free text in `idea` when `repoSource` is omitted) and
   * implements `goals` (or, if empty, `idea` itself) against it in
   * read-modify-write mode through the same pipeline + quality gates.
   */
  mode: z.enum(["new", "extend"]).optional(),
  /** The TARGET repo — where output is written. */
  repoSource: RepoSourceSchema.optional(),
  /**
   * ADDITIONAL, read-only SOURCE repos referenced alongside the target — e.g.
   * "take the auth system from A and put it into B" (B = repoSource, A = one
   * of these). Never written to; only read, understood, and ported from.
   */
  additionalRepoSources: z.array(RepoSourceSchema).max(5).optional(),
  /** Finalized goal list (e.g. from the yes/no clarification loop). */
  goals: z.array(z.string().min(1)).max(50).optional(),
  /**
   * For mode "new": the app/repo name the owner chose, and whether to create
   * it on GitHub. Required by the UI for a from-scratch app.
   */
  newRepo: NewRepoSchema.optional(),
  /**
   * For mode "extend": push the run's `factory-deck/<id>` branch back to the
   * attached repo's origin when the run completes. Default TRUE — the whole
   * point of attaching a repo is that the work lands in it. Never a
   * force-push, and never onto main/master: only the run's own branch.
   */
  pushToOrigin: z.boolean().optional(),
})
  // Unknown option keys FAIL LOUD instead of being silently stripped. A
  // misplaced or misspelled field (the FutureU `destination` class) used to
  // vanish here, silently turning an extend-a-repo run into a from-scratch
  // app whose report then fabricated pass counts (run c72fdb26).
  .strict();
export type RunOptions = z.infer<typeof RunOptionsSchema>;

/** Per-job attribution so every generated change is traceable (acceptance #244). */
export const RunAttributionSchema = z.object({
  jobId: z.string().uuid(),
  worktreePath: z.string().nullable().default(null),
  approval: z.object({
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
  /** True only when a private durable checkpoint can continue this run. */
  resumable: z.boolean().optional(),
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
  /**
   * Where the finished work is (or was) saved. Set before building starts.
   * Optional as well as nullable so run records written before this field
   * existed still load instead of failing validation and vanishing from
   * history.
   */
  destination: RunDestinationSchema.nullable().optional(),
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
  resumable: true,
  demo: true,
  codeProvider: true,
  reviewProvider: true,
  appName: true,
  workspacePath: true,
  destination: true,
  repairLoops: true,
  createdAt: true,
  updatedAt: true,
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

/* ------------------------------------------------------------------ */
/* Health (no secrets — only "configured" booleans)                    */
/* ------------------------------------------------------------------ */

/**
 * The live routing picture. This exists so a silent demotion to a PAID
 * provider is impossible: the deck always shows who is serving right now, why
 * it failed over, how many times it nearly paid but waited instead, and what
 * the rescue has cost today.
 */
export const RouteEventSchema = z.object({
  ts: z.number(),
  kind: z.string(),
  from: ProviderNameSchema.nullable(),
  to: ProviderNameSchema.nullable(),
  reason: z.string(),
});

export const RouteStatusSchema = z.object({
  primary: ProviderNameSchema,
  serving: ProviderNameSchema.nullable(),
  holdActive: z.boolean(),
  holdUntil: z.number().nullable(),
  lastFailoverAt: z.number().nullable(),
  lastFailoverReason: z.string().nullable(),
  lastRecoveryAt: z.number().nullable(),
  proxyUp: z.boolean().nullable(),
  proxyLastProbeAt: z.number().nullable(),
  proxyRestarts: z.number(),
  counts: z.object({
    free: z.number(),
    anthropic: z.number(),
    openai: z.number(),
  }),
  /** Times the deck came within one grant of paying, waited, and was right. */
  wouldHaveFailedOver: z.number(),
  backpressureRetries: z.number(),
  inFlightFree: z.number(),
  events: z.array(RouteEventSchema),
  thresholds: z.object({
    firstTokenWindowMs: z.number(),
    idleGapWindowMs: z.number(),
    backstopMs: z.number(),
    maxPatienceGrants: z.number(),
    source: z.enum(["measured", "defaults"]),
    basis: z.object({
      firstTokenMaxMs: z.number(),
      gapMaxMs: z.number(),
      samples: z.number(),
    }),
  }),
  paidBudget: z.object({
    lastHour: z.number(),
    lastDay: z.number(),
    usdLastDay: z.number(),
    exhausted: z.boolean(),
    reason: z.string().nullable(),
    limits: z.object({
      perHour: z.number(),
      perDay: z.number(),
      usdPerDay: z.number(),
    }),
  }),
});
export type RouteStatus = z.infer<typeof RouteStatusSchema>;

export const HealthSchema = z.object({
  ok: z.literal(true),
  /** Always true when this process answers — independent of paid providers (#237). */
  controlPlaneOk: z.boolean(),
  service: z.literal("factory-deck").optional(),
  /** Deterministic offline provider is always available. */
  mockConfigured: z.boolean(),
  /** The FREE local route (FCC proxy / Ollama). The default primary. */
  freeConfigured: z.boolean(),
  freeBaseUrl: z.string(),
  freeModel: z.string(),
  anthropicConfigured: z.boolean(),
  openaiConfigured: z.boolean(),
  providersAvailable: z.array(ProviderNameSchema),
  anthropicModel: z.string(),
  openaiModel: z.string(),
  /** Live routing + cost picture. Optional so older clients still parse. */
  route: RouteStatusSchema.optional(),
  defaultCodeProvider: ProviderNameSchema,
  defaultReviewProvider: ProviderNameSchema,
  maxRepairLoops: z.number(),
  maxModelCallsPerRun: z.number(),
  runTimeoutMs: z.number(),
  workspaceRoot: z.string(),
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
