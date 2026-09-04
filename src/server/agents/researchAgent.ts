import { z } from "zod";
import { SYSTEM_PREAMBLE, type AgentDeps } from "./types.js";
import { ProviderAbortError } from "../providers/types.js";
import { webSearch } from "../tools/webSearch.js";
import { webFetchTool } from "../tools/webFetch.js";
import { canonicalEvidenceUrlSet, matchingEvidenceUrls } from "../tools/evidenceUrl.js";
import {
  buildCompetitiveDossier,
  MIN_PRODUCT_COMPETITORS,
  type CompetitiveCandidate,
  type CompetitiveDossier,
} from "../tools/competitiveIntelligence.js";
import type { ProductSpec, Architecture } from "../../shared/schemas.js";

const LICENSE_POLICIES = [
  "direct-use",
  "conditional-review",
  "reference-only",
  "not-applicable",
] as const;
const LicensePolicySchema = z.preprocess((value) => {
  if (typeof value !== "string") return "reference-only";
  const normalized = value.trim().toLowerCase().replace(/[ _]+/g, "-");
  const exact = LICENSE_POLICIES.find((policy) => policy === normalized);
  if (exact) return exact;
  // Provider prose such as "compatible" is not evidence of direct-reuse
  // permission. Preserve the recommendation, but require human/legal review.
  if (normalized === "compatible") return "conditional-review";
  // This field belongs to advisory tool research. Unknown provider wording
  // must neither kill mandatory competitor discovery nor grant reuse rights.
  return "reference-only";
}, z.enum(LICENSE_POLICIES));
const ReuseModeSchema = z.enum([
  "dependency",
  "direct-code",
  "clean-room-pattern",
  "api-integration",
  "reference-only",
]);
const ACTIONABLE_REUSE_MODES = [
  "dependency",
  "direct-code",
  "clean-room-pattern",
  "api-integration",
] as const;
const ActionableReuseModeSchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  const exact = ACTIONABLE_REUSE_MODES.find((mode) => mode === normalized);
  if (exact) return exact;
  // Paid reviewers sometimes describe the intended policy instead of
  // returning its enum token. Normalize only recognizable intent, preferring
  // the non-code-reuse option whenever the wording mentions a pattern.
  if (/\b(?:clean[- ]?room|pattern|behaviou?r|design|idea)\b/.test(normalized)) {
    return "clean-room-pattern";
  }
  if (/\bapi\b/.test(normalized)) return "api-integration";
  if (/\b(?:dependency|package)\b/.test(normalized)) return "dependency";
  if (/\bdirect(?:ly)?[- ]+code\b/.test(normalized)) return "direct-code";
  return value;
}, z.enum(ACTIONABLE_REUSE_MODES));
const HttpUrlSchema = z
  .string()
  .trim()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), "expected an http(s) URL");

const RecommendationSchema = z.object({
  name: z.string(),
  why: z.string().default(""),
  sourceUrl: z.string().default(""),
  howToIntegrate: z.string().default(""),
  candidateId: z.string().default(""),
  licenseSpdx: z.string().default("NOASSERTION"),
  licensePolicy: LicensePolicySchema.default("not-applicable"),
  reuseMode: ReuseModeSchema.default("api-integration"),
  evidenceUrls: z.array(z.string()).default([]),
  score: z.number().min(0).max(100).default(0),
  origin: z.enum(["tool-research", "competitive-selection"]).default("tool-research"),
});
export type ResearchRecommendation = z.infer<typeof RecommendationSchema>;

const CandidateComparisonSchema = z.object({
  candidateId: z.string(),
  name: z.string().default(""),
  score: z.number().min(0).max(100).default(0),
  matchedFeatures: z.array(z.string()).default([]),
  strengths: z.array(z.string()).default([]),
  gaps: z.array(z.string()).default([]),
  evidenceUrls: z.array(z.string()).default([]),
  decision: z.enum(["integrate", "adapt", "reference", "reject"]),
  rationale: z.string().default(""),
  origin: z.enum(["tool-research", "competitive-selection"]).default("tool-research"),
});

const CompetitiveAuditSchema = z.object({
  queries: z.array(z.string()).default([]),
  /** Which discovery sources answered, returned empty, failed, or were skipped. */
  sources: z
    .array(
      z.object({
        name: z.string(),
        ok: z.boolean(),
        status: z.enum(["ok", "partial", "empty", "failed", "skipped"]).default("ok"),
        detail: z.string(),
        attempts: z.number().int().nonnegative().default(0),
        succeeded: z.number().int().nonnegative().default(0),
        empty: z.number().int().nonnegative().default(0),
        failed: z.number().int().nonnegative().default(0),
        skipped: z.number().int().nonnegative().default(0),
        resultCount: z.number().int().nonnegative().default(0),
      }),
    )
    .default([]),
  coverage: z
    .object({
      productTarget: z.number().int().positive(),
      productDiscoveredCount: z.number().int().nonnegative(),
      productInspectedCount: z.number().int().nonnegative(),
      productVerifiedCount: z.number().int().nonnegative(),
      productCoverageMet: z.boolean(),
      repositoryDiscoveredCount: z.number().int().nonnegative(),
      repositoryInspectedCount: z.number().int().nonnegative(),
      repositoryVerifiedCount: z.number().int().nonnegative(),
    })
    .default({
      productTarget: MIN_PRODUCT_COMPETITORS,
      productDiscoveredCount: 0,
      productInspectedCount: 0,
      productVerifiedCount: 0,
      productCoverageMet: false,
      repositoryDiscoveredCount: 0,
      repositoryInspectedCount: 0,
      repositoryVerifiedCount: 0,
    }),
  discoveredCount: z.number().int().nonnegative().default(0),
  inspectedCount: z.number().int().nonnegative().default(0),
  generatedAt: z.string().default(""),
  candidates: z
    .array(
      z.object({
        candidateId: z.string(),
        kind: z.enum(["product", "repository"]).default("repository"),
        name: z.string(),
        url: z.string(),
        /** URLs actually fetched while verifying this candidate. */
        evidenceUrls: z.array(z.string()).default([]),
        licenseSpdx: z.string(),
        licensePolicy: z.enum(["direct-use", "conditional-review", "reference-only"]),
        inspectedFiles: z.number().int().nonnegative(),
        inspectionError: z.string().default(""),
      }),
    )
    .default([]),
});

export const ResearchFindingsSchema = z.object({
  summary: z.string().default(""),
  recommendations: z.array(RecommendationSchema).default([]),
  comparisons: z.array(CandidateComparisonSchema).default([]),
  competitiveAudit: CompetitiveAuditSchema.nullable().default(null),
});
export type ResearchFindings = z.infer<typeof ResearchFindingsSchema>;

const ToolResearchFindingsSchema = z.object({
  summary: z.string().default(""),
  recommendations: z.array(RecommendationSchema.omit({ origin: true })).default([]),
});

const ACTIONS = ["web_search", "web_fetch", "conclude"] as const;
const ResearchActionSchema = z.object({
  thought: z.string().default(""),
  action: z.enum(ACTIONS),
  query: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  findings: ToolResearchFindingsSchema.nullable().optional(),
});
type ResearchAction = z.infer<typeof ResearchActionSchema>;

const ProviderSummarySchema = z.preprocess((value) => {
  if (value === undefined || value === null) return "";
  // Models occasionally return a useful structured recap even when the
  // contract asks for prose. Preserve it without relaxing any evidence,
  // comparison, or selection field.
  return typeof value === "string" ? value : JSON.stringify(value);
}, z.string());

const CompetitiveComparisonInputSchema = CandidateComparisonSchema.omit({
  origin: true,
}).extend({
  candidateId: z.string().trim().min(1),
  strengths: z.array(z.string().trim().min(1)).min(1),
  gaps: z.array(z.string().trim().min(1)).min(1),
  evidenceUrls: z.array(HttpUrlSchema).min(1),
});

const CompetitiveSelectedInputSchema = z.object({
  candidateId: z.string().trim().min(1),
  element: z.string().trim().default(""),
  why: z.string().trim().default(""),
  // Preserve otherwise valid evidence when a provider omits this one prose
  // field; mergeCompetitiveResults derives a concrete, tested instruction
  // from the selected element and enforced reuse mode.
  howToIntegrate: z.string().trim().default(""),
  reuseMode: ActionableReuseModeSchema,
  evidenceUrls: z.array(HttpUrlSchema).default([]),
  score: z.number().min(0).max(100).default(0),
});

const CompetitiveSelectionShape = z.object({
  // Keep the gate-bearing arrays first. If a provider response is truncated,
  // JSON salvage may retain a complete prefix; it must never retain only a
  // summary and manufacture empty arrays through defaults.
  comparisons: z.array(CompetitiveComparisonInputSchema),
  selected: z.array(CompetitiveSelectedInputSchema),
  summary: ProviderSummarySchema.default(""),
});
type CompetitiveSelection = z.infer<typeof CompetitiveSelectionShape>;

const TargetedProductReviewSchema = z.object({
  summary: ProviderSummarySchema.default(""),
  matchedFeature: z.string().trim().min(1),
  strength: z.string().trim().min(1),
  gap: z.string().trim().min(1),
  decision: z.enum(["integrate", "adapt", "reference", "reject"]),
  rationale: z.string().trim().min(1),
  element: z.string().trim().min(1),
  why: z.string().trim().default(""),
  howToIntegrate: z.string().trim().default(""),
  reuseMode: ActionableReuseModeSchema,
  evidenceUrls: z.array(HttpUrlSchema).default([]),
  score: z.number().min(0).max(100).default(0),
});
type TargetedProductReview = z.infer<typeof TargetedProductReviewSchema>;

function competitiveSelectionSchema(
  candidates: CompetitiveCandidate[],
  requiredCount: number,
) {
  const evidenceByCandidate = new Map(
    candidates.map((candidate) => [
      candidate.id,
      canonicalEvidenceUrlSet([
        candidate.url,
        ...candidate.sourceEvidence.map((item) => item.url),
      ]),
    ]),
  );
  const schema = CompetitiveSelectionShape.extend({
    comparisons: z.array(CompetitiveComparisonInputSchema).length(requiredCount),
    selected: z.array(CompetitiveSelectedInputSchema).length(requiredCount),
  });

  return schema.superRefine((selection, context) => {
    for (const key of ["comparisons", "selected"] as const) {
      const seen = new Set<string>();
      selection[key].forEach((item, index) => {
        if (seen.has(item.candidateId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key, index, "candidateId"],
            message: `duplicate ${key} candidateId`,
          });
        }
        seen.add(item.candidateId);
      });
    }

    const validComparisonIds = new Set<string>();
    const validComparisonEvidence = new Map<string, string[]>();
    selection.comparisons.forEach((comparison, index) => {
      const allowedEvidence = evidenceByCandidate.get(comparison.candidateId);
      if (!allowedEvidence) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["comparisons", index, "candidateId"],
          message: "candidateId is not one of the supplied verified products",
        });
        return;
      }
      if (comparison.decision === "reject") {
        return;
      }
      const evidenceUrls = matchingEvidenceUrls(
        comparison.evidenceUrls,
        allowedEvidence,
      );
      if (evidenceUrls.length === 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["comparisons", index, "evidenceUrls"],
          message: "comparison must cite inspected evidence for this product",
        });
        return;
      }
      validComparisonIds.add(comparison.candidateId);
      validComparisonEvidence.set(comparison.candidateId, evidenceUrls);
    });
    if (validComparisonIds.size !== requiredCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["comparisons"],
        message: `expected exactly ${requiredCount} distinct actionable verified-product comparisons`,
      });
    }

    const validSelectedIds = new Set<string>();
    selection.selected.forEach((selected, index) => {
      const allowedEvidence = evidenceByCandidate.get(selected.candidateId);
      if (!allowedEvidence) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["selected", index, "candidateId"],
          message: "candidateId is not one of the supplied verified products",
        });
        return;
      }
      if (!validComparisonIds.has(selected.candidateId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["selected", index, "candidateId"],
          message: "selected advantage must have one valid actionable comparison",
        });
        return;
      }
      const selectedEvidence = matchingEvidenceUrls(
        selected.evidenceUrls,
        allowedEvidence,
      );
      if (
        selectedEvidence.length === 0 &&
        (selected.evidenceUrls.length > 0 ||
          !validComparisonEvidence.has(selected.candidateId))
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["selected", index, "evidenceUrls"],
          message:
            "selected advantage must cite inspected evidence or rely on its validated comparison",
        });
        return;
      }
      validSelectedIds.add(selected.candidateId);
    });
    if (validSelectedIds.size !== requiredCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["selected"],
        message: `expected exactly ${requiredCount} distinct comparison-qualified product advantages`,
      });
    }
  });
}

function normalizedCandidateIdentity(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .trim()
    .toLowerCase()
    .replace(/^product:/, "")
    .replace(/[^a-z0-9]+/g, "");
}

function candidateIdentityTokens(candidate: CompetitiveCandidate): Set<string> {
  const tokens = new Set(
    [candidate.id, candidate.name, candidate.url]
      .map(normalizedCandidateIdentity)
      .filter(Boolean),
  );
  try {
    tokens.add(normalizedCandidateIdentity(new URL(candidate.url).hostname));
  } catch {
    // Invalid display URLs cannot participate in identity recovery. The
    // evidence gate still validates every usable URL independently.
  }
  return tokens;
}

/**
 * Recover provider-omitted IDs only from a unique verified-product identity
 * or inspected-evidence match. Ambiguous rows remain untouched and fail the
 * normal schema; no model text can invent or guess a dossier candidate.
 */
function hydrateCompetitiveCandidateIds(
  raw: unknown,
  reviewCandidates: CompetitiveCandidate[],
): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const selection = raw as Record<string, unknown>;
  const candidateIds = new Set(reviewCandidates.map((candidate) => candidate.id));
  const identityTokens = new Map(
    reviewCandidates.map((candidate) => [
      candidate.id,
      candidateIdentityTokens(candidate),
    ]),
  );

  const resolveCandidateId = (value: unknown): string | undefined => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const item = value as Record<string, unknown>;
    const explicitId =
      typeof item.candidateId === "string" ? item.candidateId.trim() : "";
    if (candidateIds.has(explicitId)) return explicitId;

    const hints = [item.candidateId, item.name, item.url, item.sourceUrl]
      .map(normalizedCandidateIdentity)
      .filter(Boolean);
    const textMatches = reviewCandidates.filter((candidate) =>
      hints.some((hint) => identityTokens.get(candidate.id)?.has(hint)),
    );
    if (textMatches.length === 1) return textMatches[0]!.id;

    const evidenceUrls = Array.isArray(item.evidenceUrls)
      ? item.evidenceUrls.filter((url): url is string => typeof url === "string")
      : [];
    const suppliedEvidence = canonicalEvidenceUrlSet(evidenceUrls);
    if (suppliedEvidence.size === 0) return undefined;
    const evidenceMatches = reviewCandidates.filter((candidate) => {
      const allowed = canonicalEvidenceUrlSet([
        candidate.url,
        ...candidate.sourceEvidence.map((evidence) => evidence.url),
      ]);
      return [...suppliedEvidence].some((url) => allowed.has(url));
    });
    return evidenceMatches.length === 1 ? evidenceMatches[0]!.id : undefined;
  };

  const comparisons = Array.isArray(selection.comparisons)
    ? selection.comparisons.map((value) => {
        const candidateId = resolveCandidateId(value);
        return candidateId &&
          value &&
          typeof value === "object" &&
          !Array.isArray(value)
          ? { ...(value as Record<string, unknown>), candidateId }
          : value;
      })
    : selection.comparisons;
  const selectedValues = Array.isArray(selection.selected) ? selection.selected : null;
  const selected = selectedValues
    ? selectedValues.map((value, index) => {
        let candidateId = resolveCandidateId(value);
        if (
          !candidateId &&
          Array.isArray(comparisons) &&
          comparisons.length === selectedValues.length
        ) {
          const comparison = comparisons[index];
          if (
            comparison &&
            typeof comparison === "object" &&
            !Array.isArray(comparison)
          ) {
            const comparisonId = (comparison as Record<string, unknown>).candidateId;
            if (typeof comparisonId === "string" && candidateIds.has(comparisonId)) {
              candidateId = comparisonId;
            }
          }
        }
        return candidateId &&
          value &&
          typeof value === "object" &&
          !Array.isArray(value)
          ? { ...(value as Record<string, unknown>), candidateId }
          : value;
      })
    : selection.selected;

  return { ...selection, comparisons, selected };
}

const ProductDiscoveryPlanSchema = z.object({
  queries: z.array(z.string().trim().min(3).max(180)).min(5).max(8),
});

async function planProductDiscovery(
  deps: AgentDeps,
  spec: ProductSpec,
  arch: Architecture,
): Promise<string[]> {
  const plan = await deps.provider.generateJson<
    z.infer<typeof ProductDiscoveryPlanSchema>
  >({
    system:
      `${SYSTEM_PREAMBLE}\nYou are the PRODUCT DISCOVERY planner. Identify real products that compete with ` +
      `the target app. Return only short web-search queries, one distinct product per query. Each query must name ` +
      `a real competitor and ask for its independent official website. Prefer direct competitors, but every query ` +
      `must be capable of returning a non-GitHub product site. When a narrow niche lacks eight such products, fill ` +
      `the remaining slots with mainstream adjacent products that solve the same user need. Never query for ` +
      `roundups, reviews, comparison sites, source repositories, packages, articles, forums, or implementation tutorials. Do not evaluate or ` +
      `cite products here: downstream search and page inspection provide the evidence.`,
    prompt: [
      `TARGET SPEC:\n${JSON.stringify(spec)}`,
      `TARGET ARCHITECTURE:\n${JSON.stringify(arch)}`,
      `Return 8 distinct official-product website search queries. A niche command-line or open-source app still ` +
        `competes with real products; name those products rather than searching for generic lists.`,
    ].join("\n\n"),
    schema: ProductDiscoveryPlanSchema,
    schemaName: "ProductDiscoveryPlan",
    intent: { role: "judge", needs: ["structured_json"] },
    temperature: 0.1,
    maxTokens: 1200,
  });
  return plan.queries;
}

export interface ResearchOptions {
  /** Preserve the small legacy research loop for tests and constrained callers. */
  competitive?: boolean;
  /**
   * Production competitive discovery has a strict wall-clock and model-call
   * budget: RepoRewards/web inspection plus one bulk judgment. It skips the
   * separate conversational tool loop and query-planning call, and never
   * fans a failed bulk response out into five more local-model calls.
   */
  executionMode?: "standard" | "bounded-production";
}

const MAX_STEPS = 5;

function buildPrompt(spec: ProductSpec, arch: Architecture, toolLog: string[]): string {
  return [
    `You are deciding whether any EXISTING tool, library, or public API would genuinely help build this app, rather than writing everything from scratch.`,
    `SPEC:\n${JSON.stringify(spec)}`,
    `ARCHITECTURE:\n${JSON.stringify(arch)}`,
    toolLog.length
      ? `Tool results so far:\n${toolLog.join("\n\n")}`
      : "(no tool calls yet)",
    `Available actions:`,
    `- web_search: search the web for a candidate tool/library/API (needs "query"). Use this FIRST for anything you're not certain about.`,
    `- web_fetch: read a specific page/doc URL a search turned up, to verify it's real and see how to actually use it (needs "url").`,
    `- conclude: you're done. Provide "findings": { summary, recommendations: [{ name, why, sourceUrl, howToIntegrate }] }. If nothing external genuinely helps, conclude with an EMPTY recommendations array and say so in summary — do not invent a recommendation just to have one.`,
    `Only recommend something you actually found real evidence for via a tool call (or that is extremely well-established, e.g. a standard library) — never invent a plausible-sounding tool name.`,
  ].join("\n\n");
}

async function runToolResearch(
  deps: AgentDeps,
  spec: ProductSpec,
  arch: Architecture,
): Promise<ResearchFindings> {
  const toolLog: string[] = [];
  const observedUrls = new Set<string>();

  for (let step = 0; step < MAX_STEPS; step++) {
    const turn = await deps.provider.generateJson<ResearchAction>({
      system:
        `${SYSTEM_PREAMBLE}\nYou are the RESEARCH agent. Find real, existing tools/APIs/libraries that would ` +
        `genuinely help build this app, using the search and fetch tools described. Be concrete and honest — ` +
        `an empty, honest "nothing needed" beats a fabricated recommendation.`,
      prompt: buildPrompt(spec, arch, toolLog),
      schema: ResearchActionSchema,
      schemaName: "ResearchAction",
      intent: { role: "judge", needs: ["structured_json"] },
      temperature: 0.2,
      maxTokens: 1800,
    });

    if (turn.action === "conclude") {
      const findings = turn.findings ?? {
        summary: "No specific external tool identified.",
        recommendations: [],
      };
      const recommendations = findings.recommendations.flatMap((recommendation) => {
        const matchedSource = matchingEvidenceUrls(
          [recommendation.sourceUrl],
          observedUrls,
        )[0];
        if (!matchedSource) return [];
        return [
          {
            ...recommendation,
            sourceUrl: matchedSource,
            evidenceUrls: matchingEvidenceUrls(
              [recommendation.sourceUrl, ...recommendation.evidenceUrls],
              observedUrls,
            ),
            origin: "tool-research" as const,
          },
        ];
      });
      const dropped = findings.recommendations.length - recommendations.length;
      return ResearchFindingsSchema.parse({
        summary:
          findings.summary +
          (dropped
            ? ` ${dropped} recommendation(s) were removed because their source URL was not observed in search/fetch evidence.`
            : ""),
        recommendations,
      });
    }

    if (turn.action === "web_search") {
      const q = turn.query ?? spec.appName;
      const searched = await webSearch(q);
      for (const result of searched.results) {
        for (const canonical of canonicalEvidenceUrlSet([result.url])) {
          observedUrls.add(canonical);
        }
      }
      toolLog.push(
        `web_search("${q}") -> status=${searched.status} provider=${searched.provider ?? "none"}; ` +
          (searched.results.length
            ? searched.results
                .map((r) => `${r.title} — ${r.url} — ${r.snippet.slice(0, 200)}`)
                .join(" | ")
            : `no results; ${searched.attempts
                .map(
                  (attempt) =>
                    `${attempt.provider}:${attempt.status} (${attempt.detail})`,
                )
                .join("; ")}`),
      );
      continue;
    }

    if (turn.action === "web_fetch") {
      if (!turn.url) {
        toolLog.push("web_fetch requested without a url — nothing to fetch.");
        continue;
      }
      const res = await webFetchTool(turn.url);
      if (res.ok) {
        for (const canonical of canonicalEvidenceUrlSet([turn.url, res.finalUrl])) {
          observedUrls.add(canonical);
        }
      }
      toolLog.push(
        `web_fetch(${turn.url}) -> ok=${res.ok} status=${res.status}\n` +
          (res.error ? `error: ${res.error}` : res.textExcerpt.slice(0, 1200)),
      );
    }
  }

  return ResearchFindingsSchema.parse({
    summary: `Research did not reach a conclusion within ${MAX_STEPS} steps — proceeding without external recommendations.`,
    recommendations: [],
  });
}

const COMPETITIVE_REVIEW_HEADROOM = 2;
const MAX_REVIEW_DESCRIPTION_CHARS = 600;
const MAX_REVIEW_EVIDENCE_ITEMS = 2;
const MAX_REVIEW_EVIDENCE_CHARS = 1_000;

export function reviewableProductCandidates(dossier: CompetitiveDossier) {
  const productTarget = Math.max(
    MIN_PRODUCT_COMPETITORS,
    dossier.coverage?.productTarget ?? MIN_PRODUCT_COMPETITORS,
  );
  const candidates = dossier.candidates.filter(
    (candidate) =>
      candidate.kind === "product" &&
      !candidate.inspectionError &&
      candidate.sourceEvidence.length > 0 &&
      canonicalEvidenceUrlSet([
        candidate.url,
        ...candidate.sourceEvidence.map((item) => item.url),
      ]).size > 0,
  );
  return {
    candidates,
    requiredCount: Math.min(productTarget, candidates.length),
  };
}

function compactProductCandidate(candidate: CompetitiveCandidate) {
  return {
    id: candidate.id,
    kind: candidate.kind,
    name: candidate.name,
    url: candidate.url,
    description: candidate.description.slice(0, MAX_REVIEW_DESCRIPTION_CHARS),
    license: candidate.license,
    sourceEvidence: candidate.sourceEvidence
      .slice(0, MAX_REVIEW_EVIDENCE_ITEMS)
      .map((evidence) => ({
        ...evidence,
        excerpt: evidence.excerpt.slice(0, MAX_REVIEW_EVIDENCE_CHARS),
      })),
  };
}

const EVIDENCE_STOPWORDS = new Set([
  "about",
  "after",
  "also",
  "application",
  "because",
  "before",
  "between",
  "build",
  "data",
  "desktop",
  "durable",
  "from",
  "have",
  "into",
  "local",
  "must",
  "persistent",
  "platform",
  "product",
  "records",
  "service",
  "software",
  "system",
  "task",
  "team",
  "teams",
  "that",
  "their",
  "there",
  "these",
  "this",
  "through",
  "tool",
  "tools",
  "user",
  "users",
  "when",
  "where",
  "which",
  "with",
  "workflow",
]);

function meaningfulTerms(value: string): string[] {
  return [
    ...new Set(
      value
        .toLowerCase()
        .match(/[a-z][a-z0-9-]{3,}/g)
        ?.filter((term) => !EVIDENCE_STOPWORDS.has(term)) ?? [],
    ),
  ];
}

function normalizedPhrase(value: string): string {
  return value
    .toLowerCase()
    .replace(
      /\b(?:ain|aren|can|couldn|didn|doesn|don|hadn|hasn|haven|isn|mustn|shouldn|wasn|weren|won|wouldn)['’]t\b/g,
      " not ",
    )
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const PREDICATE_AUXILIARIES = new Set([
  "am",
  "are",
  "be",
  "been",
  "being",
  "can",
  "could",
  "did",
  "do",
  "does",
  "had",
  "has",
  "have",
  "is",
  "may",
  "might",
  "must",
  "should",
  "was",
  "were",
  "will",
  "would",
]);

function targetPredicateTerms(phrase: string): string[] {
  const tokens = phrase.split(" ").filter(Boolean);
  const meaningful = new Set(meaningfulTerms(phrase));
  const predicates: string[] = [];
  const firstMeaningfulIndex = tokens.findIndex((token) => meaningful.has(token));
  if (firstMeaningfulIndex === 0) predicates.push(tokens[0]!);
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (!PREDICATE_AUXILIARIES.has(tokens[index]!)) continue;
    const predicate = tokens.slice(index + 1).find((token) => meaningful.has(token));
    if (predicate) predicates.push(predicate);
  }
  return [...new Set(predicates)];
}

const POLARITY_OPERATORS = new Set([
  "avoid",
  "avoided",
  "avoids",
  "avoiding",
  "cannot",
  "fail",
  "fails",
  "failed",
  "failing",
  "lack",
  "lacking",
  "lacks",
  "neither",
  "never",
  "no",
  "not",
  "refuse",
  "refused",
  "refuses",
  "refusing",
  "unable",
  "without",
]);

const DENIAL_PREDICATES = new Set([
  "absent",
  "absence",
  "delete",
  "deleted",
  "deletes",
  "deleting",
  "deny",
  "discontinued",
  "discontinue",
  "discontinues",
  "discontinuing",
  "denied",
  "denies",
  "denying",
  "disable",
  "disabled",
  "disables",
  "disabling",
  "drop",
  "dropped",
  "drops",
  "dropping",
  "eliminate",
  "eliminated",
  "eliminates",
  "eliminating",
  "exclude",
  "excluded",
  "excludes",
  "excluding",
  "forbid",
  "forbidden",
  "forbids",
  "forbidding",
  "impossible",
  "missing",
  "omit",
  "omitted",
  "omits",
  "omitting",
  "remove",
  "removed",
  "removes",
  "removing",
  "prohibit",
  "prohibited",
  "prohibits",
  "prohibiting",
  "retire",
  "retired",
  "retires",
  "retiring",
  "unavailable",
  "unsupported",
  "withdrawn",
]);

const POLARITY_SCOPE_BOUNDARIES = new Set([
  "and",
  "although",
  "but",
  "however",
  "nor",
  "or",
  "whereas",
  "yet",
]);

type FeaturePolarity = "affirmed" | "denied" | "ambiguous";

function featureSpanPolarity(
  tokens: string[],
  start: number,
  end: number,
): FeaturePolarity {
  const operatorIndexes: number[] = [];
  const denialIndexes: number[] = [];
  let separatedPolaritySignal = false;
  // `tokens` is already one bounded clause (see coherentEvidenceMatches).
  // Scan the complete clause: a fixed lookaround silently loses valid
  // long-range negation such as "does not under any circumstances ... encrypt".
  const windowStart = 0;
  const windowEnd = tokens.length - 1;
  for (let index = windowStart; index <= windowEnd; index += 1) {
    const token = tokens[index]!;
    const inside = index >= start && index <= end;
    const between =
      index < start
        ? tokens.slice(index + 1, start)
        : index > end
          ? tokens.slice(end + 1, index)
          : [];
    const correlativeNeitherNor =
      token === "neither" && index < start && between.includes("nor");
    if (
      !inside &&
      !correlativeNeitherNor &&
      between.some((item) => POLARITY_SCOPE_BOUNDARIES.has(item))
    ) {
      if (POLARITY_OPERATORS.has(token) || DENIAL_PREDICATES.has(token)) {
        separatedPolaritySignal = true;
      }
      continue;
    }

    if (POLARITY_OPERATORS.has(token)) {
      // `no` is normally a determiner, so it governs the match only when it
      // is inside/directly adjacent to it or forms the postfix `no longer`
      // construction. This prevents an unrelated `No setup; ...` statement
      // from lending negative polarity to a later security predicate.
      if (
        token === "no" &&
        !inside &&
        index !== start - 1 &&
        index !== end + 1 &&
        tokens[index + 1] !== "longer"
      ) {
        continue;
      }
      // `not only` is additive emphasis, not semantic negation.
      if (token === "not" && tokens[index + 1] === "only") continue;
      operatorIndexes.push(index);
    }
    if (DENIAL_PREDICATES.has(token)) denialIndexes.push(index);
  }

  // Multiple different denial predicates describe a compound requirement;
  // a one-bit direction cannot safely establish their individual scopes.
  // Fail closed instead of using parity to turn two denials into affirmation.
  if (new Set(denialIndexes.map((index) => tokens[index])).size > 1) {
    return "ambiguous";
  }
  // A coordinator can either begin a new predicate ("does not collect and
  // does not encrypt") or extend the previous operator's scope ("does not
  // collect or encrypt"). If the matched predicate has no local signal, the
  // direction is not provable without syntax, so fail closed instead of
  // silently treating it as affirmative.
  if (
    operatorIndexes.length === 0 &&
    denialIndexes.length === 0 &&
    separatedPolaritySignal
  ) {
    return "ambiguous";
  }
  const flips = operatorIndexes.length + (denialIndexes.length > 0 ? 1 : 0);
  return flips % 2 === 1 ? "denied" : "affirmed";
}

function containsPhraseWithMatchingPolarity(
  segment: string,
  phrase: string,
  completeSegment = segment,
): boolean {
  const matchableTokens = segment.split(" ").filter(Boolean);
  const completeTokens = completeSegment.split(" ").filter(Boolean);
  const phraseTokens = phrase.split(" ").filter(Boolean);
  if (phraseTokens.length === 0 || phraseTokens.length > matchableTokens.length) {
    return false;
  }
  const targetPolarity = featureSpanPolarity(phraseTokens, 0, phraseTokens.length - 1);
  if (targetPolarity === "ambiguous") return false;
  for (
    let start = 0;
    start <= matchableTokens.length - phraseTokens.length;
    start += 1
  ) {
    if (
      !phraseTokens.every((token, offset) => matchableTokens[start + offset] === token)
    ) {
      continue;
    }
    const completeMatches = phraseMatchStarts(completeTokens, phraseTokens);
    if (
      featureSpanDescribesCandidate(
        matchableTokens,
        start,
        start + phraseTokens.length - 1,
      ) &&
      featureSpanIsCurrent(completeTokens) &&
      featureSpanPolarity(matchableTokens, start, start + phraseTokens.length - 1) ===
        targetPolarity &&
      completeMatches.some((completeStart) =>
        featureSpanDescribesCandidate(
          completeTokens,
          completeStart,
          completeStart + phraseTokens.length - 1,
        ),
      )
    ) {
      return true;
    }
  }
  return false;
}

function phraseMatchStarts(tokens: string[], phraseTokens: string[]): number[] {
  const starts: number[] = [];
  for (let start = 0; start <= tokens.length - phraseTokens.length; start += 1) {
    if (phraseTokens.every((token, offset) => tokens[start + offset] === token)) {
      starts.push(start);
    }
  }
  return starts;
}

function tokenSubsequenceStart(tokens: string[], subsequence: string[]): number {
  for (let start = 0; start <= tokens.length - subsequence.length; start += 1) {
    if (subsequence.every((token, offset) => tokens[start + offset] === token)) {
      return start;
    }
  }
  return -1;
}

const COMPETING_SUBJECTS = new Set([
  "alternative",
  "alternatives",
  "competitor",
  "competitors",
  "others",
  "rival",
  "rivals",
]);

const PRODUCT_SUBJECTS = new Set([
  "application",
  "applications",
  "companies",
  "company",
  "platform",
  "platforms",
  "product",
  "products",
  "provider",
  "providers",
  "service",
  "services",
  "software",
  "solution",
  "solutions",
  "system",
  "systems",
  "tool",
  "tools",
  "vendor",
  "vendors",
]);

const PROSPECTIVE_EVIDENCE_MARKERS = new Set([
  "aim",
  "aimed",
  "aiming",
  "aims",
  "aspiration",
  "aspirational",
  "aspire",
  "aspired",
  "aspires",
  "aspiring",
  "consider",
  "considered",
  "considering",
  "considers",
  "eventual",
  "eventually",
  "explore",
  "explored",
  "explores",
  "exploring",
  "future",
  "hope",
  "hoped",
  "hopes",
  "hoping",
  "intend",
  "intended",
  "intending",
  "intends",
  "plan",
  "planned",
  "planning",
  "plans",
  "promise",
  "promised",
  "promises",
  "proposal",
  "propose",
  "proposed",
  "proposes",
  "roadmap",
  "roadmaps",
  "scheduled",
  "soon",
  "upcoming",
]);

const INSTRUCTIONAL_TRIGGERS = new Set([
  "after",
  "before",
  "once",
  "upon",
  "when",
  "whenever",
]);

const CURRENT_MODAL_SUBJECTS = new Set([
  "app",
  "application",
  "platform",
  "product",
  "service",
  "software",
  "system",
  "tool",
]);

const FUTURE_PERIODS = new Set([
  "day",
  "days",
  "month",
  "months",
  "quarter",
  "quarters",
  "release",
  "releases",
  "week",
  "weeks",
  "year",
  "years",
]);

function featureSpanIsCurrent(tokens: string[]): boolean {
  // Approximate matches span the first through last matched term. A roadmap
  // marker can therefore sit *inside* that range without itself being one of
  // the matched terms ("credentials that we plan to protect using keys").
  // Presence evidence is fail-closed: inspect the complete statement rather
  // than dropping the nominal feature span.
  if (tokens.some((token) => PROSPECTIVE_EVIDENCE_MARKERS.has(token))) {
    return false;
  }
  if (
    tokens.some(
      (token, index) => token === "next" && FUTURE_PERIODS.has(tokens[index + 1] ?? ""),
    )
  ) {
    return false;
  }

  // A bare "we will ..." remains an unfulfilled promise. Product manuals,
  // however, commonly describe current deterministic behavior as "When you
  // save, the application will ...". Accept that narrow instruction shape
  // while continuing to fail closed on unqualified marketing modals.
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] !== "will" && tokens[index] !== "would") continue;
    let triggerIndex = -1;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (!INSTRUCTIONAL_TRIGGERS.has(tokens[cursor]!)) continue;
      triggerIndex = cursor;
      break;
    }
    const subjectWindow = tokens.slice(Math.max(0, triggerIndex + 1), index);
    const hasCurrentProductSubject = subjectWindow.some(
      (token, subjectIndex) =>
        CURRENT_MODAL_SUBJECTS.has(token) ||
        (token === "it" && subjectIndex === subjectWindow.length - 1),
    );
    if (triggerIndex < 0 || !hasCurrentProductSubject) return false;
  }
  return true;
}

/**
 * Competitive pages often describe another product before denying that the
 * page owner's product has the same capability. A lexical feature match is
 * not evidence unless the matched predicate is attributed to the candidate.
 * Fail closed when a competing subject governs the feature span, while still
 * accepting explicit contrasts such as "unlike competitors, our product...".
 */
function featureSpanDescribesCandidate(
  tokens: string[],
  start: number,
  end: number,
): boolean {
  const competingSubjects: number[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const next = tokens[index + 1];
    if (
      COMPETING_SUBJECTS.has(token) ||
      ((token === "other" || token === "competing") &&
        next !== undefined &&
        PRODUCT_SUBJECTS.has(next))
    ) {
      competingSubjects.push(index);
    }
  }
  const attributionSubjects = competingSubjects.filter(
    (index) => index < start || index > end,
  );
  if (attributionSubjects.length === 0) return true;

  // Attribution after the capability governs the predicate just as strongly
  // as a prefix ("... is a feature of our competitors"). Without syntax-tree
  // proof that it is only a contrast, production fallback must fail closed.
  if (attributionSubjects.some((index) => index > end)) {
    return false;
  }

  const competingSubject = Math.max(
    ...attributionSubjects.filter((index) => index < start),
  );

  for (let index = competingSubject + 1; index < start; index += 1) {
    const token = tokens[index]!;
    const next = tokens[index + 1];
    if (token === "we" || token === "ours") return true;
    if (
      (token === "our" || token === "this") &&
      next !== undefined &&
      PRODUCT_SUBJECTS.has(next)
    ) {
      return true;
    }
  }
  return false;
}

function targetEvidencePhrases(spec: ProductSpec): string[] {
  return [
    ...new Set(
      [
        spec.tagline,
        ...spec.coreFeatures,
        ...spec.userFlows,
        ...spec.acceptanceCriteria,
      ]
        .map(normalizedPhrase)
        .filter(
          (phrase) =>
            phrase.length >= 12 && phrase.split(" ").filter(Boolean).length >= 2,
        ),
    ),
  ];
}

type CoherentEvidenceMatch = {
  phrase: string;
  terms: string[];
  exact: boolean;
  statement: string;
  evidenceUrl: string;
};

function compareCoherentEvidenceStrength(
  left: CoherentEvidenceMatch,
  right: CoherentEvidenceMatch,
): number {
  if (left.exact !== right.exact) return left.exact ? -1 : 1;
  if (left.terms.length !== right.terms.length) {
    return right.terms.length - left.terms.length;
  }
  if (left.phrase.length !== right.phrase.length) {
    return right.phrase.length - left.phrase.length;
  }
  return (
    left.evidenceUrl.localeCompare(right.evidenceUrl) ||
    left.statement.localeCompare(right.statement)
  );
}

function coherentEvidenceMatches(
  spec: ProductSpec,
  inspectedText: string,
  evidenceUrl: string,
): CoherentEvidenceMatch[] {
  // Product-page HTML is decoded exactly once by webFetchTool. Re-decoding
  // here would turn double-encoded, visibly literal text into new evidence.
  const unresolvedEntityMarker = "\uE000";
  const segments = inspectedText
    // One-boundary decoding deliberately leaves a second encoded layer
    // visible. Replace unresolved references before splitting so their
    // semicolon cannot manufacture a new affirmative clause, and reject only
    // the affected clause from semantic matching.
    .replace(/&(?:#[0-9]+;?|#x[0-9a-f]+;?|[a-z][a-z0-9]+;?)/gi, unresolvedEntityMarker)
    // HTML block boundaries are independent statements. Keeping them apart
    // prevents an unrelated heading/list item from donating a future marker,
    // competitor name, or missing target terms to the evidence sentence.
    .split(/(?<=[.!?])\s+|[\r\n]+/)
    .filter((raw) => !raw.includes(unresolvedEntityMarker))
    .map((raw) => raw.replace(/\s+/g, " ").trim())
    .flatMap((completeStatement) => {
      // Match within one grammatical clause, but evaluate ownership/current
      // state against its complete sentence. This retains governing postfix
      // qualifiers while forbidding approximate terms from accumulating
      // across semicolons or contrast clauses.
      const completeNormalized = normalizedPhrase(
        completeStatement.replace(/;/g, " however "),
      );
      return completeStatement
        .split(/;+|\b(?:although|but|however|whereas)\b/i)
        .map((clause) => clause.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .map((clause) => {
          const statement = clause.slice(0, 260);
          return {
            statement,
            normalized: normalizedPhrase(statement),
            completeNormalized,
          };
        });
    })
    .filter((segment) => segment.normalized.length > 0);

  return targetEvidencePhrases(spec).flatMap((phrase): CoherentEvidenceMatch[] => {
    const exact = segments.find((segment) =>
      containsPhraseWithMatchingPolarity(
        segment.normalized,
        phrase,
        segment.completeNormalized,
      ),
    );
    if (exact) {
      return [
        {
          phrase,
          terms: meaningfulTerms(phrase),
          exact: true,
          statement: exact.statement,
          evidenceUrl,
        },
      ];
    }

    const featureTerms = meaningfulTerms(phrase);
    // Approximate evidence is only meaningful when at least three uncommon
    // target terms can agree in one clause. Shorter targets must use the exact
    // phrase path above; otherwise two generic words can manufacture support
    // for a materially different capability.
    if (featureTerms.length < 3) return [];
    // Approximate evidence must retain the target predicate wherever grammar
    // places it. Subject-first requirements otherwise let a different action
    // inherit nearly all nouns and pass a high-overlap threshold.
    const predicateTerms = targetPredicateTerms(phrase);
    const phraseTokens = phrase.split(" ").filter(Boolean);
    const targetPolarity = featureSpanPolarity(
      phraseTokens,
      0,
      phraseTokens.length - 1,
    );
    // A failed model review must not turn approximate lexical similarity into
    // a semantic rewrite of a denied/compound requirement. Negative targets
    // remain eligible through the exact-phrase path above; overlap fallback is
    // deliberately limited to unambiguous affirmative targets.
    if (targetPolarity !== "affirmed") return [];
    // This path runs only when semantic model review failed. Require every
    // uncommon target term in one clause; partial lexical similarity is not
    // strong enough to establish a production acceptance fact.
    const required = featureTerms.length;
    const bestOverlap = segments
      .map((segment) => {
        const segmentTokens = segment.normalized.split(" ").filter(Boolean);
        const completeTokens = segment.completeNormalized.split(" ").filter(Boolean);
        const segmentOffset = tokenSubsequenceStart(completeTokens, segmentTokens);
        const segmentTerms = new Set(meaningfulTerms(segment.normalized));
        const terms = featureTerms.filter((term) => segmentTerms.has(term));
        const positions = terms
          .map((term) => segmentTokens.indexOf(term))
          .filter((position) => position >= 0);
        const polarity =
          positions.length > 0 &&
          featureSpanPolarity(
            segmentTokens,
            Math.min(...positions),
            Math.max(...positions),
          );
        return {
          statement: segment.statement,
          terms,
          polarity,
          describesCandidate:
            positions.length > 0 &&
            featureSpanDescribesCandidate(
              segmentTokens,
              Math.min(...positions),
              Math.max(...positions),
            ) &&
            segmentOffset >= 0 &&
            featureSpanDescribesCandidate(
              completeTokens,
              segmentOffset + Math.min(...positions),
              segmentOffset + Math.max(...positions),
            ),
          isCurrent: positions.length > 0 && featureSpanIsCurrent(completeTokens),
        };
      })
      .filter(
        (segment) =>
          segment.describesCandidate &&
          segment.isCurrent &&
          segment.polarity === targetPolarity,
      )
      .sort((left, right) => right.terms.length - left.terms.length)[0];
    return bestOverlap &&
      bestOverlap.terms.length >= required &&
      predicateTerms.length > 0 &&
      predicateTerms.every((term) => bestOverlap.terms.includes(term))
      ? [
          {
            phrase,
            terms: bestOverlap.terms,
            exact: false,
            statement: bestOverlap.statement,
            evidenceUrl,
          },
        ]
      : [];
  });
}

const MAX_BOUNDED_REPOSITORY_RECOMMENDATIONS = 5;

/**
 * Preserve implementation research in the production-bounded path without
 * spending another model call. Every recommendation is derived only from a
 * repository file that the dossier actually fetched, remains license-scoped,
 * and carries the exact inspected source URL into planning.
 */
function boundedRepositoryRecommendations(
  spec: ProductSpec,
  _arch: Architecture,
  dossier: CompetitiveDossier,
): ResearchRecommendation[] {
  return dossier.candidates
    .filter(
      (candidate) =>
        candidate.kind === "repository" &&
        !candidate.archived &&
        !candidate.inspectionError &&
        candidate.sourceEvidence.length > 0,
    )
    .flatMap((candidate) => {
      const strongest = candidate.sourceEvidence
        .flatMap((evidence) =>
          [...canonicalEvidenceUrlSet([evidence.url])].flatMap((evidenceUrl) =>
            coherentEvidenceMatches(spec, evidence.excerpt, evidenceUrl).map(
              (match) => ({ evidence, match }),
            ),
          ),
        )
        .sort(
          (left, right) =>
            compareCoherentEvidenceStrength(left.match, right.match) ||
            left.evidence.path.localeCompare(right.evidence.path),
        )[0];
      if (!strongest || strongest.match.terms.length < 2) return [];

      const path = strongest.evidence.path.replace(/\s+/g, " ").trim().slice(0, 180);
      const evidenceUrls = [strongest.match.evidenceUrl];
      if (!path || evidenceUrls.length === 0) return [];
      const reuseMode =
        candidate.license.policy === "reference-only"
          ? ("reference-only" as const)
          : ("clean-room-pattern" as const);
      const matched = strongest.match.terms.slice(0, 6);
      const targetFeature = strongest.match.phrase;
      const reuseInstruction =
        reuseMode === "reference-only"
          ? "Treat the implementation as reference material only: do not copy source. Reproduce any selected public behavior independently behind a target-owned adapter."
          : "Reproduce the inspected behavior as a clean-room pattern behind a target-owned adapter; do not import code until a separate dependency and license review authorizes it.";

      return [
        {
          recommendation: RecommendationSchema.parse({
            name: `${candidate.name}: ${path}`,
            why: `The inspected file supports the matching target requirement "${targetFeature}" with the same polarity.`,
            sourceUrl: evidenceUrls[0],
            howToIntegrate: `${reuseInstruction} Add an acceptance test for ${matched.join(", ")} before enabling the adapter.`,
            candidateId: candidate.id,
            licenseSpdx: candidate.license.spdxId,
            licensePolicy: candidate.license.policy,
            reuseMode,
            evidenceUrls,
            score: Math.min(95, 45 + matched.length * 8),
            origin: "tool-research",
          }),
          relevance: strongest.match.terms.length + (strongest.match.exact ? 10 : 0),
          stars: candidate.stars,
        },
      ];
    })
    .sort(
      (left, right) =>
        right.relevance - left.relevance ||
        right.stars - left.stars ||
        left.recommendation.candidateId.localeCompare(right.recommendation.candidateId),
    )
    .slice(0, MAX_BOUNDED_REPOSITORY_RECOMMENDATIONS)
    .map((entry) => entry.recommendation);
}

/**
 * A no-invention fallback for a failed bulk reviewer. It can only select a
 * product only when inspected official-page text contains a target feature
 * phrase or a high-coverage term match for one feature inside one sentence.
 * Terms scattered across unrelated page sections can never be accumulated
 * into an advantage. Authoritative output retains only the matched target
 * feature identifier; fetched prose stays behind the evidence URL. If fewer
 * than the required five qualify, the existing strict gate still blocks the
 * run.
 */
export function evidenceGroundedCompetitiveSelection(
  spec: ProductSpec,
  _arch: Architecture,
  dossier: CompetitiveDossier,
): CompetitiveSelection {
  const { candidates, requiredCount } = reviewableProductCandidates(dossier);
  const qualified = candidates
    .map((candidate) => {
      const featureMatches = candidate.sourceEvidence
        .flatMap((item) =>
          [...canonicalEvidenceUrlSet([item.url])].flatMap((evidenceUrl) =>
            coherentEvidenceMatches(spec, item.excerpt, evidenceUrl),
          ),
        )
        .sort(compareCoherentEvidenceStrength);
      const exactMatches = featureMatches.filter((match) => match.exact);
      const overlap = [...new Set(featureMatches.flatMap((match) => match.terms))];
      return { candidate, overlap, featureMatches, exactMatches };
    })
    .filter((item) => item.featureMatches.length > 0)
    .sort(
      (a, b) =>
        b.exactMatches.length - a.exactMatches.length ||
        b.featureMatches.length - a.featureMatches.length ||
        b.overlap.length - a.overlap.length ||
        a.candidate.name.localeCompare(b.candidate.name),
    )
    .slice(0, requiredCount);

  const comparisons: CompetitiveSelection["comparisons"] = [];
  const selected: CompetitiveSelection["selected"] = [];
  for (const { candidate, overlap, featureMatches, exactMatches } of qualified) {
    const strongestMatch = featureMatches[0]!;
    const evidenceUrls = [strongestMatch.evidenceUrl];
    const score = Math.min(90, 55 + overlap.length * 5 + exactMatches.length * 10);
    comparisons.push({
      candidateId: candidate.id,
      name: candidate.name,
      score,
      matchedFeatures: [
        strongestMatch.exact
          ? `Inspected evidence contains target feature phrase: ${strongestMatch.phrase}`
          : `One inspected statement supports target feature "${strongestMatch.phrase}" through coherent concepts: ${strongestMatch.terms.join(", ")}`,
      ],
      strengths: [
        `Official product evidence supports target behavior "${strongestMatch.phrase}".`,
      ],
      gaps: [
        "Evidence verifies public product behavior, not equivalent behavior or acceptance results in the target implementation.",
      ],
      evidenceUrls,
      decision: "adapt",
      rationale: `The inspected official page ${
        strongestMatch.exact
          ? `contains the target feature phrase "${strongestMatch.phrase}"`
          : `contains a single statement with a high-coverage match for "${strongestMatch.phrase}" (${strongestMatch.terms.join(", ")})`
      }; any adoption remains clean-room and test-gated.`,
    });
    selected.push({
      candidateId: candidate.id,
      // This field becomes an authoritative acceptance criterion downstream.
      // Keep it derived solely from the target spec; fetched page prose and
      // candidate-controlled display names remain evidence, never commands.
      element: `Evidence-backed target behavior: ${strongestMatch.phrase}`,
      why: "The behavior is present in inspected official evidence and relevant to explicit target terminology.",
      howToIntegrate:
        "Reproduce only the documented public behavior as a clean-room pattern, then require a direct acceptance test before treating it as an advantage.",
      reuseMode: "clean-room-pattern",
      evidenceUrls,
      score,
    });
  }

  const selection = {
    comparisons,
    selected,
    summary:
      `The bulk model review was unavailable. Deterministic evidence analysis produced ${selected.length}/${requiredCount} ` +
      "target-term-aligned clean-room candidate(s); the unchanged production gate decides whether that is sufficient.",
  };
  return selected.length === requiredCount
    ? competitiveSelectionSchema(candidates, requiredCount).parse(selection)
    : CompetitiveSelectionShape.parse(selection);
}

/**
 * A paid reviewer may rank candidates, but model prose is not proof that the
 * cited page currently attributes a capability to that product. Re-evaluate
 * every chosen candidate against the same deterministic statement predicates
 * used by the outage fallback, then replace model-authored factual claims with
 * target-owned, evidence-derived wording. Rows without a current,
 * candidate-attributed match disappear and the unchanged five-product gate
 * fails closed.
 */
function truthGatedCompetitiveSelection(
  spec: ProductSpec,
  dossier: CompetitiveDossier,
  selection: CompetitiveSelection,
): CompetitiveSelection {
  const candidates = new Map(
    dossier.candidates.map((candidate) => [candidate.id, candidate]),
  );
  const selectedByCandidate = new Map(
    selection.selected.map((selected) => [selected.candidateId, selected]),
  );
  const comparisons: CompetitiveSelection["comparisons"] = [];
  const selected: CompetitiveSelection["selected"] = [];

  for (const comparison of selection.comparisons) {
    if (comparison.decision === "reject") continue;
    const candidate = candidates.get(comparison.candidateId);
    const selectedItem = selectedByCandidate.get(comparison.candidateId);
    if (!candidate || !selectedItem) continue;

    const featureMatches = candidate.sourceEvidence
      .flatMap((evidence, evidenceIndex) => {
        // A product fetch may canonically redirect (HTTP->HTTPS, www, or a
        // canonical path). The selection contract permits the discovered
        // candidate URL as a citation, so bind that alias to the primary
        // inspected response while always emitting the response's final URL.
        const evidenceAliases = canonicalEvidenceUrlSet([
          evidence.url,
          ...(evidenceIndex === 0 ? [candidate.url] : []),
        ]);
        const citedEvidenceUrls = matchingEvidenceUrls(
          comparison.evidenceUrls,
          evidenceAliases,
        );
        if (citedEvidenceUrls.length === 0) return [];
        return [...canonicalEvidenceUrlSet([evidence.url])].flatMap((evidenceUrl) =>
          coherentEvidenceMatches(spec, evidence.excerpt, evidenceUrl),
        );
      })
      .sort(compareCoherentEvidenceStrength);
    const strongestMatch = featureMatches[0];
    if (!strongestMatch) continue;

    const evidenceUrls = [strongestMatch.evidenceUrl];
    const support = strongestMatch.exact
      ? `Inspected evidence contains target feature phrase: ${strongestMatch.phrase}`
      : `One inspected statement supports target feature "${strongestMatch.phrase}" through coherent concepts: ${strongestMatch.terms.join(", ")}`;
    comparisons.push({
      candidateId: candidate.id,
      name: candidate.name,
      score: comparison.score,
      matchedFeatures: [support],
      strengths: [
        `Official product evidence supports target behavior "${strongestMatch.phrase}".`,
      ],
      gaps: [
        "Evidence verifies public product behavior, not equivalent behavior or acceptance results in the target implementation.",
      ],
      evidenceUrls,
      decision: comparison.decision,
      rationale:
        `The cited inspected statement passes current-state, candidate-attribution, and polarity gates for ` +
        `target behavior "${strongestMatch.phrase}"; adoption remains clean-room and test-gated.`,
    });
    selected.push({
      candidateId: candidate.id,
      element: `Evidence-backed target behavior: ${strongestMatch.phrase}`,
      why: "The behavior is present in inspected official evidence and relevant to explicit target terminology.",
      howToIntegrate:
        "Reproduce only the documented public behavior as a clean-room pattern, then require a direct acceptance test before treating it as an advantage.",
      reuseMode: selectedItem.reuseMode,
      evidenceUrls,
      score: selectedItem.score,
    });
  }

  return CompetitiveSelectionShape.parse({
    comparisons,
    selected,
    summary:
      `${selection.summary}\n\nDeterministic evidence truth gates retained ${selected.length}/` +
      `${selection.selected.length} model-selected advantage(s).`,
  });
}

function auditFrom(dossier: CompetitiveDossier) {
  const fallbackProducts = dossier.candidates.filter(
    (candidate) => candidate.kind === "product",
  );
  const fallbackRepositories = dossier.candidates.filter(
    (candidate) => candidate.kind === "repository",
  );
  return {
    queries: dossier.queries,
    sources: dossier.sources ?? [],
    coverage: dossier.coverage ?? {
      productTarget: MIN_PRODUCT_COMPETITORS,
      productDiscoveredCount: fallbackProducts.length,
      productInspectedCount: fallbackProducts.length,
      productVerifiedCount: fallbackProducts.filter(
        (candidate) => candidate.sourceEvidence.length > 0,
      ).length,
      productCoverageMet:
        fallbackProducts.filter((candidate) => candidate.sourceEvidence.length > 0)
          .length >= MIN_PRODUCT_COMPETITORS,
      repositoryDiscoveredCount: fallbackRepositories.length,
      repositoryInspectedCount: fallbackRepositories.length,
      repositoryVerifiedCount: fallbackRepositories.filter(
        (candidate) => candidate.sourceEvidence.length > 0,
      ).length,
    },
    discoveredCount: dossier.discoveredCount,
    inspectedCount: dossier.inspectedCount,
    generatedAt: dossier.generatedAt,
    candidates: dossier.candidates.map((candidate) => ({
      candidateId: candidate.id,
      kind: candidate.kind,
      name: candidate.name,
      url: candidate.url,
      evidenceUrls:
        candidate.sourceEvidence.length > 0
          ? [
              ...new Set([
                candidate.url,
                ...candidate.sourceEvidence.map((item) => item.url),
              ]),
            ]
          : [],
      licenseSpdx: candidate.license.spdxId,
      licensePolicy: candidate.license.policy,
      inspectedFiles: candidate.sourceEvidence.length,
      inspectionError: candidate.inspectionError,
    })),
  };
}

export function enforceReuseMode(
  requested: z.infer<typeof ReuseModeSchema>,
  candidate: CompetitiveCandidate,
): z.infer<typeof ReuseModeSchema> {
  if (candidate.kind === "product" && requested !== "reference-only") {
    // A product homepage proves neither source-code permission nor a supported
    // API/contract. Product ideas are therefore clean-room behavior references
    // unless separate API-specific evidence exists (not represented here).
    return "clean-room-pattern";
  }
  if (
    candidate.license.policy !== "direct-use" &&
    (requested === "direct-code" || requested === "dependency")
  ) {
    return "clean-room-pattern";
  }
  return requested;
}

async function evaluateCompetitiveDossier(
  deps: AgentDeps,
  spec: ProductSpec,
  arch: Architecture,
  dossier: CompetitiveDossier,
): Promise<CompetitiveSelection> {
  // Repository source trees are useful to deterministic discovery and the
  // ordinary implementation recommendations, but they made the production
  // product-review prompt exceed 43k input tokens. The two paid responses then
  // hit their output limits, and truncation salvage retained only a summary.
  // Review only verified market products here, with two spares so the judge
  // can reject weak candidates while still satisfying the five-product gate.
  const { candidates, requiredCount } = reviewableProductCandidates(dossier);
  const reviewCandidates = candidates.slice(
    0,
    requiredCount + COMPETITIVE_REVIEW_HEADROOM,
  );
  if (requiredCount === 0) {
    return {
      comparisons: [],
      selected: [],
      summary: "Competitive review found no verified product evidence to evaluate.",
    };
  }

  return deps.provider.generateJson<CompetitiveSelection>({
    system:
      `${SYSTEM_PREAMBLE}\nYou are the COMPETITIVE INTELLIGENCE reviewer. Compare only the supplied, ` +
      `evidence-backed product candidates. Score feature fit, implementation quality, maintenance, and integration cost. ` +
      `Never invent a candidate, file, feature, or license. License policy is authoritative: direct code reuse is ` +
      `allowed only when policy=direct-use; otherwise choose clean-room-pattern for an adoptable behavior or design ` +
      `idea. The selected list is implementation work and therefore cannot be reference-only; use decision=reject ` +
      `when a candidate has nothing safely adoptable.`,
    prompt: [
      `TARGET SPEC:\n${JSON.stringify(spec)}`,
      `TARGET ARCHITECTURE:\n${JSON.stringify(arch)}`,
      `REQUIRED PRODUCT COUNT: ${requiredCount}`,
      `VERIFIED PRODUCT DOSSIER:\n${JSON.stringify(reviewCandidates.map(compactProductCandidate))}`,
      `Return comparisons and selected FIRST, followed by a short summary. Keep every string concise. Return exactly ` +
        `${requiredCount} distinct evidence-linked comparisons and exactly ${requiredCount} matching selected advantages. ` +
        `When more candidates are supplied, omit the weaker candidates rather than returning surplus entries. ` +
        `For each compared product name the single most valuable idea worth adopting - ` +
        `the thing it does better than this app - respecting its license policy. Every selected candidateId must ` +
        `exactly match the dossier and a non-rejected comparison. Cite only supplied page URLs in evidenceUrls. ` +
        `A selected item may omit element or evidenceUrls only when they are redundant with that item\'s ` +
        `validated comparison; the engine will derive the first stated strength and its inspected evidence. ` +
        `Reject stale, irrelevant, unverifiable, or legally unusable candidates. Do not select something merely because it is popular.`,
    ].join("\n\n"),
    schema: z.preprocess(
      (raw) => hydrateCompetitiveCandidateIds(raw, reviewCandidates),
      competitiveSelectionSchema(reviewCandidates, requiredCount),
    ),
    schemaName: "CompetitiveSelection",
    intent: { role: "judge", needs: ["structured_json"] },
    temperature: 0.1,
    maxTokens: 8000,
  });
}

async function evaluateProductsIndividually(
  deps: AgentDeps,
  spec: ProductSpec,
  arch: Architecture,
  dossier: CompetitiveDossier,
): Promise<CompetitiveSelection> {
  const { candidates, requiredCount } = reviewableProductCandidates(dossier);
  if (requiredCount === 0) {
    return {
      comparisons: [],
      selected: [],
      summary: "Targeted product review found no verified evidence to evaluate.",
    };
  }

  const comparisons: CompetitiveSelection["comparisons"] = [];
  const selected: CompetitiveSelection["selected"] = [];
  const failures: string[] = [];

  for (const candidate of candidates) {
    if (selected.length >= requiredCount) break;
    try {
      const review = await deps.provider.generateJson<TargetedProductReview>({
        system:
          `${SYSTEM_PREAMBLE}\nYou are the TARGETED COMPETITIVE INTELLIGENCE reviewer. Review only the one supplied, ` +
          `evidence-verified product. Identify one concrete behavior it does better than the target app and one ` +
          `target-app gap it exposes. Do not invent facts, products, URLs, source code, or licenses. Product behavior ` +
          `may be adopted only as a clean-room pattern. Reject the product when its supplied evidence supports no relevant advantage.`,
        prompt: [
          `TARGET SPEC:\n${JSON.stringify(spec)}`,
          `TARGET ARCHITECTURE:\n${JSON.stringify(arch)}`,
          `VERIFIED PRODUCT AND INSPECTED EVIDENCE:\n${JSON.stringify(compactProductCandidate(candidate))}`,
          `Return the single-product review. The orchestrator owns candidate identity and evidence attachment; do not ` +
            `return a candidateId. Every strength, gap, element, and rationale must be specific to the supplied evidence.`,
        ].join("\n\n"),
        schema: TargetedProductReviewSchema,
        schemaName: "TargetedProductReview",
        intent: { role: "judge", needs: ["structured_json"] },
        temperature: 0.1,
        maxTokens: 1800,
      });
      if (review.decision === "reject") continue;

      const allowedEvidence = canonicalEvidenceUrlSet([
        candidate.url,
        ...candidate.sourceEvidence.map((evidence) => evidence.url),
      ]);
      const suppliedEvidence = matchingEvidenceUrls(
        review.evidenceUrls,
        allowedEvidence,
      );
      const evidenceUrls =
        suppliedEvidence.length > 0
          ? suppliedEvidence
          : matchingEvidenceUrls(
              [
                candidate.url,
                ...candidate.sourceEvidence.map((evidence) => evidence.url),
              ],
              allowedEvidence,
            );
      if (evidenceUrls.length === 0) continue;

      comparisons.push({
        candidateId: candidate.id,
        name: candidate.name,
        score: review.score,
        matchedFeatures: [review.matchedFeature],
        strengths: [review.strength],
        gaps: [review.gap],
        evidenceUrls,
        decision: review.decision,
        rationale: review.rationale,
      });
      selected.push({
        candidateId: candidate.id,
        element: review.element,
        why: review.why,
        howToIntegrate: review.howToIntegrate,
        reuseMode: review.reuseMode,
        evidenceUrls,
        score: review.score,
      });
    } catch (err) {
      if (err instanceof ProviderAbortError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${candidate.name}: ${message.slice(0, 120)}`);
    }
  }

  return competitiveSelectionSchema(candidates, requiredCount).parse({
    comparisons,
    selected,
    summary:
      `Targeted paid product review produced ${selected.length} evidence-linked advantage(s).` +
      (failures.length
        ? ` ${failures.length} candidate review(s) failed validation: ${failures
            .slice(0, 3)
            .join("; ")}.`
        : ""),
  });
}

function mergeCompetitiveResults(
  base: ResearchFindings,
  dossier: CompetitiveDossier,
  selection: CompetitiveSelection,
): ResearchFindings {
  const candidates = new Map(
    dossier.candidates.map((candidate) => [candidate.id, candidate]),
  );
  const inspectedEvidence = (candidate: CompetitiveCandidate): Set<string> =>
    canonicalEvidenceUrlSet(
      candidate.sourceEvidence.length > 0
        ? [candidate.url, ...candidate.sourceEvidence.map((item) => item.url)]
        : [],
    );
  const validComparisons = selection.comparisons.flatMap((item) => {
    const candidate = candidates.get(item.candidateId);
    if (!candidate) return [];
    const allowed = inspectedEvidence(candidate);
    const evidenceUrls = matchingEvidenceUrls(item.evidenceUrls, allowed);
    return evidenceUrls.length && item.strengths.length && item.gaps.length
      ? [{ ...item, evidenceUrls, origin: "competitive-selection" as const }]
      : [];
  });
  const comparisonGroups = new Map<string, typeof validComparisons>();
  for (const comparison of validComparisons) {
    const group = comparisonGroups.get(comparison.candidateId) ?? [];
    group.push(comparison);
    comparisonGroups.set(comparison.candidateId, group);
  }
  const actionableComparisonIds = new Set(
    [...comparisonGroups.entries()].flatMap(([candidateId, group]) =>
      group.length === 1 && group[0]?.decision !== "reject" ? [candidateId] : [],
    ),
  );
  const competitiveRecommendations: ResearchRecommendation[] = [];

  for (const selected of selection.selected) {
    const candidate = candidates.get(selected.candidateId);
    if (!candidate) continue;
    if (!actionableComparisonIds.has(candidate.id)) continue;
    const comparison = comparisonGroups.get(candidate.id)?.[0];
    if (!comparison) continue;
    const allowedEvidence = inspectedEvidence(candidate);
    const selectedEvidence = matchingEvidenceUrls(
      selected.evidenceUrls,
      allowedEvidence,
    );
    const evidenceUrls =
      selectedEvidence.length > 0
        ? selectedEvidence
        : selected.evidenceUrls.length === 0
          ? comparison.evidenceUrls
          : [];
    if (evidenceUrls.length === 0) continue;
    const element =
      selected.element ||
      comparison.strengths[0] ||
      comparison.matchedFeatures[0] ||
      "";
    if (!element) continue;
    const reuseMode = enforceReuseMode(selected.reuseMode, candidate);
    if (candidate.kind === "product" && reuseMode === "reference-only") continue;
    const legalPrefix =
      reuseMode !== selected.reuseMode
        ? `License gate changed requested ${selected.reuseMode} to ${reuseMode}. `
        : "";
    const integrationInstruction =
      selected.howToIntegrate ||
      `Integrate ${element} using the enforced ${reuseMode} reuse mode in the target architecture, and add direct acceptance tests tied to the cited evidence.`;
    competitiveRecommendations.push({
      name: `${candidate.name}: ${element}`,
      why:
        selected.why ||
        `Adopt ${element} as an evidence-backed advantage over the reviewed product.`,
      sourceUrl: candidate.url,
      howToIntegrate: `${legalPrefix}${integrationInstruction}`.trim(),
      candidateId: candidate.id,
      licenseSpdx: candidate.license.spdxId,
      licensePolicy: candidate.license.policy,
      reuseMode,
      evidenceUrls: [...new Set([...evidenceUrls].filter(Boolean))],
      score: selected.score,
      origin: "competitive-selection",
    });
  }

  return ResearchFindingsSchema.parse({
    summary: [base.summary, selection.summary].filter(Boolean).join("\n\n"),
    recommendations: [...base.recommendations, ...competitiveRecommendations],
    comparisons: validComparisons,
    competitiveAudit: auditFrom(dossier),
  });
}

function qualifyingProductAdvantageCount(
  findings: ResearchFindings,
  dossier: CompetitiveDossier,
): number {
  const productIds = new Set(
    dossier.candidates
      .filter(
        (candidate) =>
          candidate.kind === "product" && candidate.sourceEvidence.length > 0,
      )
      .map((candidate) => candidate.id),
  );
  const comparedIds = new Set(
    findings.comparisons
      .filter(
        (comparison) =>
          productIds.has(comparison.candidateId) &&
          comparison.origin === "competitive-selection" &&
          comparison.decision !== "reject",
      )
      .map((comparison) => comparison.candidateId),
  );
  return new Set(
    findings.recommendations
      .filter(
        (recommendation) =>
          recommendation.origin === "competitive-selection" &&
          recommendation.reuseMode !== "reference-only" &&
          comparedIds.has(recommendation.candidateId),
      )
      .map((recommendation) => recommendation.candidateId),
  ).size;
}

/**
 * Research existing tools plus, when requested by the production pipeline,
 * autonomously discover and compare competing open-source implementations.
 */
export async function researchAgent(
  deps: AgentDeps,
  spec: ProductSpec,
  arch: Architecture,
  options: ResearchOptions = {},
): Promise<ResearchFindings> {
  const boundedProduction = options.executionMode === "bounded-production";
  let base = boundedProduction
    ? ResearchFindingsSchema.parse({
        summary:
          "Production research used the bounded RepoRewards and verified-product evidence path.",
        recommendations: [],
      })
    : await runToolResearch(deps, spec, arch);
  if (!options.competitive) return base;

  // The run-scoped orchestrator names plausible competitors; deterministic
  // search, URL classification, page inspection, and the five-product gate
  // decide whether any of them count. Planning failure falls back to the
  // deterministic generic queries and remains advisory.
  let productQueries: string[] = [];
  if (!boundedProduction) {
    try {
      productQueries = await planProductDiscovery(deps, spec, arch);
    } catch (err) {
      if (err instanceof ProviderAbortError) throw err;
    }
  }

  const dossier = await buildCompetitiveDossier(spec, arch, { productQueries });
  if (boundedProduction) {
    const repositoryRecommendations = boundedRepositoryRecommendations(
      spec,
      arch,
      dossier,
    );
    base = ResearchFindingsSchema.parse({
      ...base,
      summary:
        `${base.summary} Preserved ${repositoryRecommendations.length} bounded, inspected ` +
        "repository implementation recommendation(s).",
      recommendations: repositoryRecommendations,
    });
  }
  if (!dossier.candidates.length) {
    return ResearchFindingsSchema.parse({
      ...base,
      summary: `${base.summary}\n\nCompetitive discovery found no inspectable candidates.`,
      competitiveAudit: auditFrom(dossier),
    });
  }

  const coverage = dossier.coverage ?? auditFrom(dossier).coverage;

  // RESEARCH IS ADVISORY — IT MUST NEVER KILL THE RUN (2026-08-16, live
  // GrantFlow slice: the competitive-selection call failed schema validation
  // after ~$10 of billed retries and the whole slice died before the builder
  // ever ran). A failed selection is a NAMED SKIP: the run continues on the
  // base findings, the discovered candidates stay in the audit, and the
  // summary says out loud what was skipped and why. A deliberate cancel
  // (abort) still propagates — swallowing that would be worse.
  let selection: CompetitiveSelection;
  try {
    selection = await evaluateCompetitiveDossier(deps, spec, arch, dossier);
  } catch (err) {
    if (err instanceof ProviderAbortError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (!coverage.productCoverageMet) {
      return ResearchFindingsSchema.parse({
        ...base,
        summary:
          `${base.summary}\n\nCompetitive selection FAILED and was SKIPPED — ` +
          `continuing without competitor recommendations (${msg.slice(0, 300)}). ` +
          `${dossier.candidates.length} discovered candidate(s) are recorded in the audit.`,
        competitiveAudit: auditFrom(dossier),
      });
    }
    selection = boundedProduction
      ? evidenceGroundedCompetitiveSelection(spec, arch, dossier)
      : CompetitiveSelectionShape.parse({
          comparisons: [],
          selected: [],
          summary:
            `Bulk competitive review failed validation (${msg.slice(0, 240)}). ` +
            `Continuing with evidence-scoped single-product paid reviews.`,
        });
  }
  if (boundedProduction) {
    selection = truthGatedCompetitiveSelection(spec, dossier, selection);
  }
  let merged = mergeCompetitiveResults(base, dossier, selection);
  if (
    !boundedProduction &&
    coverage.productCoverageMet &&
    qualifyingProductAdvantageCount(merged, dossier) < MIN_PRODUCT_COMPETITORS
  ) {
    // A malformed bulk row must not discard every otherwise useful product.
    // Review one verified product per paid call so identity and inspected
    // evidence remain attached by the orchestrator rather than model prose.
    try {
      const targetedSelection = await evaluateProductsIndividually(
        deps,
        spec,
        arch,
        dossier,
      );
      const targeted = mergeCompetitiveResults(base, dossier, targetedSelection);
      if (
        qualifyingProductAdvantageCount(targeted, dossier) >
        qualifyingProductAdvantageCount(merged, dossier)
      ) {
        merged = targeted;
      }
    } catch (err) {
      if (err instanceof ProviderAbortError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      merged = ResearchFindingsSchema.parse({
        ...merged,
        summary:
          `${merged.summary}\n\nCompetitive selection FAILED and was SKIPPED after ` +
          `the evidence-scoped product correction also failed (${msg.slice(0, 300)}).`,
      });
    }
  }
  const deadSources = (dossier.sources ?? []).filter(
    (source) => !source.ok || source.status === "failed",
  );
  if (deadSources.length) {
    merged = ResearchFindingsSchema.parse({
      ...merged,
      summary: `${merged.summary}

Discovery source unavailable: ${deadSources
        .map((s) => `${s.name} (${s.detail})`)
        .join("; ")}.`,
    });
  }
  const emptySources = (dossier.sources ?? []).filter(
    (source) => source.status === "empty",
  );
  if (emptySources.length) {
    merged = ResearchFindingsSchema.parse({
      ...merged,
      summary: `${merged.summary}

Discovery source returned an honest empty result: ${emptySources
        .map((source) => `${source.name} (${source.detail})`)
        .join("; ")}.`,
    });
  }
  if (!coverage.productCoverageMet) {
    // No silent substitution: repositories cannot satisfy the owner's floor
    // of five distinct, evidence-verified PRODUCT competitors.
    return ResearchFindingsSchema.parse({
      ...merged,
      summary: `${merged.summary}

Product competitor coverage below the owner's floor: ${coverage.productVerifiedCount} verified / ${coverage.productInspectedCount} inspected / ${coverage.productDiscoveredCount} distinct product candidate(s) discovered (target: ${coverage.productTarget}). Repository coverage is reported separately: ${coverage.repositoryVerifiedCount} verified / ${coverage.repositoryInspectedCount} inspected / ${coverage.repositoryDiscoveredCount} discovered, and does not satisfy the product floor.`,
    });
  }
  return merged;
}
