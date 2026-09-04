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

function reviewableProductCandidates(dossier: CompetitiveDossier) {
  const productTarget = Math.max(
    MIN_PRODUCT_COMPETITORS,
    dossier.coverage?.productTarget ?? MIN_PRODUCT_COMPETITORS,
  );
  const candidates = dossier.candidates
    .filter(
      (candidate) =>
        candidate.kind === "product" &&
        !candidate.inspectionError &&
        candidate.sourceEvidence.length > 0 &&
        canonicalEvidenceUrlSet([
          candidate.url,
          ...candidate.sourceEvidence.map((item) => item.url),
        ]).size > 0,
    )
    .slice(0, productTarget + COMPETITIVE_REVIEW_HEADROOM);
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
      `VERIFIED PRODUCT DOSSIER:\n${JSON.stringify(candidates.map(compactProductCandidate))}`,
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
      (raw) => hydrateCompetitiveCandidateIds(raw, candidates),
      competitiveSelectionSchema(candidates, requiredCount),
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
  const base = await runToolResearch(deps, spec, arch);
  if (!options.competitive) return base;

  // The run-scoped orchestrator names plausible competitors; deterministic
  // search, URL classification, page inspection, and the five-product gate
  // decide whether any of them count. Planning failure falls back to the
  // deterministic generic queries and remains advisory.
  let productQueries: string[] = [];
  try {
    productQueries = await planProductDiscovery(deps, spec, arch);
  } catch (err) {
    if (err instanceof ProviderAbortError) throw err;
  }

  const dossier = await buildCompetitiveDossier(spec, arch, { productQueries });
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
    selection = CompetitiveSelectionShape.parse({
      comparisons: [],
      selected: [],
      summary:
        `Bulk competitive review failed validation (${msg.slice(0, 240)}). ` +
        `Continuing with evidence-scoped single-product paid reviews.`,
    });
  }
  let merged = mergeCompetitiveResults(base, dossier, selection);
  if (
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
