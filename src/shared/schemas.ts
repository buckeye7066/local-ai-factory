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
/* Citation-linked purpose constitution                               */
/* ------------------------------------------------------------------ */

/**
 * One bounded, immutable observation collected from an existing repository.
 * Models may cite these records, but may not mint new evidence identifiers.
 */
export const PurposeEvidenceSchema = z.object({
  id: z.string().regex(/^PE-\d{3}$/),
  kind: z.enum(["readme", "manifest", "route", "source", "test"]),
  path: z.string().min(1),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  /** SHA-256 of the complete source file at analysis time. */
  sourceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  signal: z.string().min(1),
  excerpt: z.string().min(1),
});
export type PurposeEvidence = z.infer<typeof PurposeEvidenceSchema>;

/** A purpose claim is retained only when it cites a repository snapshot. */
export const EvidenceBackedClaimSchema = z.object({
  text: z.string().min(1),
  evidenceIds: z.array(z.string()).min(1),
});
export type EvidenceBackedClaim = z.infer<typeof EvidenceBackedClaimSchema>;

export const PurposeWorkflowSchema = z.object({
  name: z.string().min(1),
  outcome: z.string().min(1),
  actors: z.array(z.string()).default([]),
  evidenceIds: z.array(z.string()).min(1),
});
export type PurposeWorkflow = z.infer<typeof PurposeWorkflowSchema>;

/**
 * The typed constitution carried through every extend-run planning stage.
 * `grounding` is produced by deterministic code after model generation. It
 * validates citation identity/linkage, not semantic entailment of model prose.
 */
export const PurposeProfileSchema = z.object({
  profileVersion: z.literal(1),
  appName: z.string().min(1),
  purpose: EvidenceBackedClaimSchema,
  intendedUsers: z.array(EvidenceBackedClaimSchema).default([]),
  coreWorkflows: z.array(PurposeWorkflowSchema).default([]),
  invariants: z.array(EvidenceBackedClaimSchema).default([]),
  currentCapabilities: z.array(EvidenceBackedClaimSchema).default([]),
  currentGaps: z.array(EvidenceBackedClaimSchema).default([]),
  integrations: z.array(EvidenceBackedClaimSchema).default([]),
  dataOwnership: z.array(EvidenceBackedClaimSchema).default([]),
  uncertainties: z.array(z.string()).default([]),
  evidence: z.array(PurposeEvidenceSchema),
  grounding: z.object({
    /** Legacy name: true means every retained claim has a valid citation. */
    grounded: z.boolean(),
    /** Claim↔excerpt meaning remains model-inferred, not independently proven. */
    semanticVerification: z.literal("not-performed").default("not-performed"),
    evidenceCoverage: z.number().min(0).max(1),
    rejectedEvidenceIds: z.array(z.string()).default([]),
    droppedClaims: z.array(z.string()).default([]),
  }),
});
export type PurposeProfile = z.infer<typeof PurposeProfileSchema>;

/**
 * Orchestrator-owned mission carried through every model call. Unlike a prompt,
 * this is a typed, digest-bound contract: the current request, repository
 * purpose, and prior successful work are reconciled once and then reused.
 */
export const GoalContractSchema = z.object({
  schema: z.literal("factory.goal-contract.v1"),
  projectKey: z.string().min(1).max(500),
  purpose: z.string().trim().min(1).max(20_000),
  purposeSource: z.enum([
    "repository",
    "project-memory",
    "current-request",
    "current-spec",
  ]),
  targetUsers: z.array(z.string().trim().min(1)).max(50).default([]),
  activeGoals: z.array(z.string().trim().min(1)).min(1).max(50),
  constraints: z.array(z.string().trim().min(1)).max(100).default([]),
  nonGoals: z.array(z.string().trim().min(1)).max(100).default([]),
  continuity: z.object({
    previousRunIds: z.array(z.string().uuid()).max(12).default([]),
    carriedForwardDecisions: z.array(z.string().trim().min(1)).max(30).default([]),
    priorResearch: z.array(z.string().trim().min(1)).max(30).default([]),
  }),
  createdFromRunId: z.string().uuid(),
  createdAt: z.number().int().nonnegative(),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});
export type GoalContract = z.infer<typeof GoalContractSchema>;

/** Durable, operator-visible competitive evidence retained after checkpoints expire. */
export const CompetitiveResearchSummarySchema = z.object({
  required: z.boolean(),
  coverageMet: z.boolean(),
  productTarget: z.number().int().positive(),
  productVerifiedCount: z.number().int().nonnegative(),
  productComparedCount: z.number().int().nonnegative(),
  productSelectedCount: z.number().int().nonnegative(),
  repositoryVerifiedCount: z.number().int().nonnegative(),
  generatedAt: z.string().default(""),
  queries: z.array(z.string()).default([]),
  sources: z
    .array(
      z.object({
        name: z.string(),
        status: z.enum(["ok", "partial", "empty", "failed", "skipped"]),
        detail: z.string(),
      }),
    )
    .default([]),
  competitors: z
    .array(
      z.object({
        candidateId: z.string(),
        name: z.string(),
        url: z.string(),
        score: z.number().min(0).max(100),
        decision: z.enum(["integrate", "adapt", "reference", "reject"]),
        strengths: z.array(z.string()).default([]),
        gaps: z.array(z.string()).default([]),
        evidenceUrls: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  recommendations: z
    .array(
      z.object({
        candidateId: z.string(),
        name: z.string(),
        sourceUrl: z.string(),
        why: z.string(),
        howToIntegrate: z.string(),
        reuseMode: z.enum([
          "dependency",
          "direct-code",
          "clean-room-pattern",
          "api-integration",
          "reference-only",
        ]),
        evidenceUrls: z.array(z.string()).default([]),
        score: z.number().min(0).max(100),
      }),
    )
    .default([]),
});
export type CompetitiveResearchSummary = z.infer<
  typeof CompetitiveResearchSummarySchema
>;

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
  /** Present on extend runs so every downstream agent receives the constitution. */
  purposeProfile: PurposeProfileSchema.optional(),
  /** Present on every orchestrated run; stamped by code, never trusted from a model. */
  goalContract: GoalContractSchema.optional(),
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

/**
 * ANCHORED EDIT — how an EXISTING file is changed.
 *
 * The builder never saw the files it was "modifying": it received a list of
 * PATHS and reconstructed whole files from the filename alone. That is how
 * services/api/.../auth.js came back as CommonJS with every export gone, how
 * App.jsx lost its auth route gating, and how react-router-dom appeared in a
 * repo that uses react-router v8. An edit quotes the exact text it replaces,
 * so anything the model did not think about survives untouched.
 */
export const FileEditSchema = z.object({
  /** Exact existing text to replace. Must appear EXACTLY ONCE in the file. */
  find: z.string().min(1),
  /** Replacement text. Empty string deletes the matched block. */
  replace: z.string(),
});
export type FileEdit = z.infer<typeof FileEditSchema>;

export const FileBuildSchema = z.object({
  files: z
    .array(
      z.object({
        path: z.string(),
        purpose: z.string().default(""),
        /** Full contents — ONLY for files that do not exist yet. */
        contents: z.string().default(""),
        /** Anchored edits — REQUIRED for a file that already exists. */
        edits: z.array(FileEditSchema).default([]),
      }),
    )
    .min(1),
});
export type FileBuild = z.infer<typeof FileBuildSchema>;

export const TestCoverageSchema = z.object({
  /** Stable engine-assigned user-flow or acceptance-criterion id (UF-n / AC-n). */
  requirementId: z.string(),
  /** Exact generated test path selected by a direct runner command. */
  testPath: z.string(),
  /** Exact active test title that the structured runner must report passed. */
  testName: z.string(),
  kind: z.enum(["unit", "integration", "browser"]),
});
export type TestCoverage = z.infer<typeof TestCoverageSchema>;

export const TestPlanSchema = z.object({
  testPlan: z.string(),
  /** Prose is diagnostic only; this mapping is the executable acceptance contract. */
  coverage: z.array(TestCoverageSchema).optional(),
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
        /** Full contents are valid only for a genuinely new file. */
        contents: z.string().default(""),
        /** Existing files must be changed through exact, grounded anchors. */
        edits: z.array(FileEditSchema).default([]),
      }),
    )
    .default([]),
});
export type RepairResult = z.infer<typeof RepairResultSchema>;

/* ------------------------------------------------------------------ */
/* Error ledger (owner requirement 2026-08-23)                         */
/* ------------------------------------------------------------------ */

export const ErrorClassificationSchema = z.enum([
  "deck-defect",
  "program-defect",
  "environment",
  "provider",
  "budget",
]);
export type ErrorClassification = z.infer<typeof ErrorClassificationSchema>;

/**
 * One error the run hit: when (stage), what (message), which code (deck
 * file:line + source line, program file, or route id), how it is classified,
 * and the suggested fix with its provenance. `suggestionSource: "model"`
 * entries carry the "model suggestion, unverified" label in the text itself.
 */
export const ErrorLedgerEntrySchema = z.object({
  id: z.string(),
  ts: z.number(),
  stage: StageIdSchema.nullable().default(null),
  message: z.string(),
  code: z.object({
    kind: z.enum(["deck", "program", "route", "unknown"]).default("unknown"),
    file: z.string().nullable().default(null),
    line: z.number().nullable().default(null),
    sourceLine: z.string().nullable().default(null),
    route: z.string().nullable().default(null),
    command: z.string().nullable().default(null),
    exitCode: z.number().nullable().default(null),
  }),
  classification: ErrorClassificationSchema,
  signature: z.string().nullable().default(null),
  suggestion: z.string().default(""),
  suggestionSource: z.enum(["signature", "model", "none"]).default("none"),
  occurrences: z.number().default(1),
});
export type ErrorLedgerEntry = z.infer<typeof ErrorLedgerEntrySchema>;

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
  /** Durable evidence bundle explaining the standing purpose of an extended app. */
  purposeProfile: PurposeProfileSchema.optional(),
  /** Durable mission, active goals, and cross-run continuity for every app. */
  goalContract: GoalContractSchema.optional(),
  /** Durable evidence for comparative claims; retained after checkpoint cleanup. */
  competitiveResearch: CompetitiveResearchSummarySchema.optional(),
  /** Rendered error ledger — one readable line per recorded error. */
  errors: StringListSchema.optional(),
});
export type FinalReport = z.infer<typeof FinalReportSchema>;

/* ------------------------------------------------------------------ */
/* Run options + run record (the object the UI polls)                  */
/* ------------------------------------------------------------------ */

/**
 * "free" is the live FCC/Ollama rung appended to the end of the automatic
 * ladder. It really builds software and, unlike mock/stub, is never treated as
 * an offline demo.
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
 * One orchestrated provider ladder. "free" and "paid" remain accepted only so
 * stored records and older API clients still load; live routing normalizes both
 * legacy values to "auto" and never creates separate economic paths.
 */
export const RoutingModeSchema = z.enum(["auto", "free", "paid"]);
export type RoutingMode = z.infer<typeof RoutingModeSchema>;

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
  /** Exact commit whose bytes were covered by the verification receipt. */
  commitSha: z.string().nullable().optional(),
  /**
   * True once the run's own branch has actually been published to origin.
   * Distinguishes "nothing reached the repo at all" from "the branch is
   * there, only the trunk did not move" — the second is recoverable through
   * the repo's own PR gate and must not be reported as a dead end.
   */
  branchPushed: z.boolean().optional(),
  /**
   * True when the trunk itself was fast-forwarded onto the branch, i.e. the
   * work is on main. When this is true the branch and the trunk are the same
   * commit, so opening a PR from that branch would be an EMPTY PR — the
   * gated release step must be skipped rather than attempted and reported as
   * a failure. Absent/false means the trunk did not move.
   *
   * Since the 2026-08-20 trunk-protection reversal this is true only on the
   * NAMED FALLBACK path (see `trunkAdvancePath`); the ordinary run leaves the
   * trunk to the host repo's PR gate.
   */
  releasedToTrunk: z.boolean().optional(),
  /**
   * WHICH TRUNK POLICY THIS DELIVERY TOOK — so the report says it rather than
   * leaving the owner to infer it:
   *   "pr-gate"            → the host repo's CI gates the trunk (the default);
   *   "direct-fast-forward"→ the named fallback (no host CI, or an explicit
   *                          owner opt-in for a local/offline destination).
   * Optional so run records written before the policy existed still load.
   */
  trunkAdvancePath: z.enum(["pr-gate", "direct-fast-forward"]).optional(),
  deliveredAt: z.number().nullable().default(null),
});
export type RunDestination = z.infer<typeof RunDestinationSchema>;

export const RunOptionsSchema = z
  .object({
    /**
     * Live work always uses one orchestrated strongest-to-weakest model
     * ladder. "free"/"paid" and explicit provider fields are accepted only for
     * backward compatibility; the server normalizes them to the same "auto"
     * route and does not expose a second execution path.
     */
    routingMode: RoutingModeSchema.optional(),
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
    /**
     * Large evolution: plan the request into ordered slices and run them one at
     * a time, each fully released before the next (client routes to /api/epics).
     */
    epic: z.boolean().optional(),
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
     * For mode "extend": publish the run's work back to the attached repo when
     * the run completes — push the `factory-deck/<id>` branch AND land it on the
     * repo's default branch. Default TRUE — the whole point of attaching a repo
     * is that the work lands in it, in production, not on a branch waiting for
     * someone to remember it (owner order 2026-08-19).
     *
     * HOW it lands changed on 2026-08-20 ("protect factory deck's trunk"): the
     * host repository's own CI gates the trunk through a pull request with
     * auto-merge armed. The commit is always authored on the run's own branch,
     * never directly on the trunk. Never a force-push.
     */
    pushToOrigin: z.boolean().optional(),
    /**
     * ESCAPE HATCH, off by default: let this run fast-forward the trunk itself
     * instead of going through the host repo's PR gate. Exists for a
     * local/offline destination that will never have CI or pull requests.
     *
     * This is the ONLY way to bypass CI on a repo that HAS CI, and it is a
     * deliberate, named choice recorded in the run's report
     * (`destination.trunkAdvancePath === "direct-fast-forward"`). A repo with no
     * CI at all already takes the fallback without this flag.
     */
    directTrunkAdvance: z.boolean().optional(),
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
  /** "auto" for current runs; legacy "free"/"paid" records remain readable. */
  routingMode: RoutingModeSchema.optional(),
  codeProvider: ProviderNameSchema,
  reviewProvider: ProviderNameSchema,
  currentStage: StageIdSchema.nullable().default(null),
  stages: z.array(StageStateSchema),
  logs: z.array(LogLineSchema),
  files: z.array(FileSummarySchema),
  repairLoops: z.number().default(0),
  providerUsage: ProviderUsageSchema,
  finalReport: FinalReportSchema.nullable().default(null),
  /** Every error the run hit, readable without the logs (see errorLedger.ts). */
  errorLedger: z.array(ErrorLedgerEntrySchema).optional(),
  appName: z.string().nullable().default(null),
  workspacePath: z.string().nullable().default(null),
  /**
   * Where the finished work is (or was) saved. Set before building starts.
   * Optional as well as nullable so run records written before this field
   * existed still load instead of failing validation and vanishing from
   * history.
   */
  destination: RunDestinationSchema.nullable().optional(),
  /** Release outcome for extend runs (auto-merge to main). Null until delivery. */
  release: z
    .object({
      released: z.boolean(),
      prUrl: z.string().nullable(),
      mergedSha: z.string().nullable(),
      reason: z.string(),
      /**
       * THREE OUTCOMES, NOT TWO. `released` alone cannot tell an open PR that
       * is still going green apart from one that is blocked, and reporting the
       * first as a failure is exactly the false FAILED this policy exists to
       * avoid:
       *   "merged"  → the work is on the trunk (`released: true`);
       *   "pending" → the PR is open with auto-merge armed and the host repo's
       *               checks are still running; it lands with no human, but it
       *               is NOT in production yet and must never be described as
       *               if it were;
       *   "held"    → genuinely blocked (checks failed, evidence gate not met,
       *               merge refused) — the run fails.
       * Optional so records written before this field existed still load.
       */
      state: z.enum(["merged", "pending", "held"]).optional(),
    })
    .nullable()
    .optional(),
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
  routingMode: true,
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
 * The live routing picture. The deck always shows the current ladder rung,
 * demotion reason, provider call counts, and locally estimated paid usage.
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
  /** The final free/local ladder rung (FCC proxy / Ollama). */
  freeConfigured: z.boolean(),
  freeBaseUrl: z.string(),
  freeModel: z.string(),
  anthropicConfigured: z.boolean(),
  openaiConfigured: z.boolean(),
  /** Production admission requires a configured paid rung for both reviewer calls. */
  mandatoryProductionReadiness: z.literal(true).optional(),
  readinessBrainFloorConfigured: z.boolean().optional(),
  readinessPaidProviders: z.array(z.enum(["anthropic", "openai"])).optional(),
  solConfigured: z.boolean().optional(),
  fableOrOpusConfigured: z.boolean().optional(),
  solModel: z.string().optional(),
  fableOrOpusModel: z.string().optional(),
  ownerExternalMatters: z.literal("owner-managed-outside-cyberland").optional(),
  providersAvailable: z.array(ProviderNameSchema),
  /** Current strongest-to-weakest execution order. */
  modelLadder: z.array(ProviderNameSchema).optional(),
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
