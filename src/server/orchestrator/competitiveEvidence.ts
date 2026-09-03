import type { CompetitiveResearchSummary, ProductSpec } from "../../shared/schemas.js";
import type { ResearchFindings } from "../agents/researchAgent.js";
import {
  canonicalEvidenceUrlSet,
  canonicalHttpEvidenceUrl,
  matchingEvidenceUrls,
} from "../tools/evidenceUrl.js";

const COMPARATIVE_INTENT_PATTERNS = [
  /\bcompetitors?\b/i,
  /\bcompetitive(?:ly|\s+advantage)?\b/i,
  /\b(?:beat|beating|outdo|surpass)\s+(?:the\s+)?competition\b/i,
  /\boutperform\b/i,
  /\b(?:better\s+than|superior\s+to)\b/i,
  /\bmatch\s+or\s+exceed\b/i,
  /\b(?:industry|market)[- ]lead(?:er|ing)\b/i,
  /\bbest[- ]in[- ]class\b/i,
  /(?:\b(?:best|number\s+one)|#\s*1)\s+(?:[a-z0-9-]+\s+){0,3}(?:app|application|crm|platform|product|service|software|solution|tool)\b/i,
  /\bworld[- ]class\s+(?:[a-z0-9-]+\s+){0,3}(?:app|application|crm|platform|product|service|software|solution|tool)\b/i,
  /\bcategory[- ]lead(?:er|ing)\b/i,
  /\b(?:top\s+(?:five|5)|leading)\s+(?:products?|tools?|alternatives?|competitors?)\b/i,
];

/** Comparative market evidence is re-collected at least weekly. */
export const MAX_COMPETITIVE_EVIDENCE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Comparative language opts a run into the strict five-product evidence gate. */
export function requiresCompetitiveEvidence(texts: Iterable<string>): boolean {
  return [...texts].some((text) =>
    COMPARATIVE_INTENT_PATTERNS.some((pattern) => pattern.test(text)),
  );
}

/**
 * Every real production run must collect current competitive evidence. Vitest
 * integration fixtures remain hermetic; explicit comparative test cases still
 * opt into the strict gate through requiresCompetitiveEvidence.
 */
export function requiresProductionCompetitiveEvidence(
  demo: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return !demo && env.VITEST !== "true";
}

function intersectsEvidence(rawUrls: string[], allowed: ReadonlySet<string>): boolean {
  return matchingEvidenceUrls(rawUrls, allowed).length > 0;
}

function uniquelyActionableComparisonIds<
  T extends {
    candidateId: string;
    decision: "integrate" | "adapt" | "reference" | "reject";
  },
>(comparisons: Iterable<T>, hasValidEvidence: (comparison: T) => boolean): Set<string> {
  const grouped = new Map<string, T[]>();
  for (const comparison of comparisons) {
    const group = grouped.get(comparison.candidateId) ?? [];
    group.push(comparison);
    grouped.set(comparison.candidateId, group);
  }
  return new Set(
    [...grouped.entries()].flatMap(([candidateId, group]) => {
      const comparison = group[0];
      return group.length === 1 &&
        comparison?.decision !== "reject" &&
        hasValidEvidence(comparison)
        ? [candidateId]
        : [];
    }),
  );
}

export interface CompetitiveEvidenceGate {
  ok: boolean;
  reasons: string[];
  productTarget: number;
  productVerifiedCount: number;
  productComparedCount: number;
  productSelectedCount: number;
}

/**
 * A comparative claim needs three independent facts: five successfully
 * inspected products, five evidence-linked comparisons, and one selected
 * advantage for each. Repository candidates never satisfy these counts.
 */
export function assessRequiredCompetitiveEvidence(
  research: ResearchFindings | undefined,
  nowMs = Date.now(),
): CompetitiveEvidenceGate {
  const audit = research?.competitiveAudit;
  const target = Math.max(5, audit?.coverage.productTarget ?? 5);
  const verifiedProducts = new Map(
    (audit?.candidates ?? [])
      .filter(
        (candidate) =>
          candidate.kind === "product" &&
          candidate.inspectedFiles > 0 &&
          !candidate.inspectionError &&
          candidate.evidenceUrls.some((url) => canonicalHttpEvidenceUrl(url) !== null),
      )
      .map((candidate) => [
        candidate.candidateId,
        {
          url: canonicalHttpEvidenceUrl(candidate.url),
          evidence: canonicalEvidenceUrlSet(candidate.evidenceUrls),
        },
      ]),
  );
  const competitiveComparisons = (research?.comparisons ?? []).filter(
    (comparison) => comparison.origin === "competitive-selection",
  );
  const productComparisons = competitiveComparisons.filter((comparison) =>
    verifiedProducts.has(comparison.candidateId),
  );
  const comparedProductIds = uniquelyActionableComparisonIds(
    productComparisons,
    (comparison) =>
      intersectsEvidence(
        comparison.evidenceUrls,
        verifiedProducts.get(comparison.candidateId)!.evidence,
      ),
  );
  const competitiveRecommendations = (research?.recommendations ?? []).filter(
    (recommendation) => recommendation.origin === "competitive-selection",
  );
  const selectedProductIds = new Set(
    competitiveRecommendations
      .filter((recommendation) => {
        const candidate = verifiedProducts.get(recommendation.candidateId);
        const sourceUrl = canonicalHttpEvidenceUrl(recommendation.sourceUrl);
        return (
          Boolean(candidate) &&
          recommendation.reuseMode !== "reference-only" &&
          sourceUrl !== null &&
          sourceUrl === candidate!.url &&
          recommendation.howToIntegrate.trim().length > 0 &&
          intersectsEvidence(recommendation.evidenceUrls, candidate!.evidence)
        );
      })
      .map((recommendation) => recommendation.candidateId),
  );
  const qualifiedSelectedProductIds = new Set(
    [...selectedProductIds].filter((candidateId) =>
      comparedProductIds.has(candidateId),
    ),
  );
  const productVerifiedCount = verifiedProducts.size;
  const reasons: string[] = [];
  if (!audit) reasons.push("competitive audit is missing");
  const repoRewards = audit?.sources.find((source) => source.name === "repo-rewards");
  if (!repoRewards) {
    reasons.push("RepoRewards discovery evidence is missing");
  } else if (
    repoRewards.attempts < 1 ||
    repoRewards.status === "failed" ||
    repoRewards.status === "skipped"
  ) {
    reasons.push(
      `RepoRewards was not successfully queried (status=${repoRewards.status}, attempts=${repoRewards.attempts})`,
    );
  }
  const generatedAt = Date.parse(audit?.generatedAt ?? "");
  if (!Number.isFinite(generatedAt)) {
    reasons.push("competitive evidence timestamp is missing or invalid");
  } else if (generatedAt > nowMs + MAX_FUTURE_CLOCK_SKEW_MS) {
    reasons.push("competitive evidence timestamp is implausibly in the future");
  } else if (nowMs - generatedAt > MAX_COMPETITIVE_EVIDENCE_AGE_MS) {
    reasons.push("competitive evidence is older than seven days");
  }
  if (productVerifiedCount < target) {
    reasons.push(`verified product coverage is ${productVerifiedCount}/${target}`);
  }
  if (competitiveComparisons.length !== target) {
    reasons.push(
      `competitive comparison entries are ${competitiveComparisons.length}/${target}; exactly ${target} required`,
    );
  }
  if (comparedProductIds.size !== target) {
    reasons.push(
      `evidence-linked product comparisons are ${comparedProductIds.size}/${target}`,
    );
  }
  if (competitiveRecommendations.length !== target) {
    reasons.push(
      `competitive selected-advantage entries are ${competitiveRecommendations.length}/${target}; exactly ${target} required`,
    );
  }
  if (qualifiedSelectedProductIds.size !== target) {
    reasons.push(
      `comparison-qualified selected product advantages are ${qualifiedSelectedProductIds.size}/${target}`,
    );
  }
  return {
    ok: reasons.length === 0,
    reasons,
    productTarget: target,
    productVerifiedCount,
    productComparedCount: comparedProductIds.size,
    productSelectedCount: qualifiedSelectedProductIds.size,
  };
}

/**
 * Decide whether research must execute at the architecture boundary.
 *
 * Ordinary advisory research is checkpoint-idempotent: once architecture is
 * complete, a missing result remains an honest skip. Comparative research is
 * different because its deterministic gate blocks the run; an explicit
 * resume must be able to retry a transient source/model shortfall instead of
 * replaying the same failed gate forever.
 */
export function shouldAttemptResearch(
  architectureComplete: boolean,
  comparativeRequired: boolean,
  research: ResearchFindings | undefined,
  nowMs = Date.now(),
): boolean {
  if (comparativeRequired) {
    return !assessRequiredCompetitiveEvidence(research, nowMs).ok;
  }
  return !architectureComplete && !research;
}

/** Add traceable competitor advantages to the normal executable test contract. */
export function withCompetitiveAcceptanceCriteria(
  spec: ProductSpec,
  research: ResearchFindings,
): ProductSpec {
  const products = new Map(
    (research.competitiveAudit?.candidates ?? [])
      .filter(
        (candidate) =>
          candidate.kind === "product" &&
          candidate.inspectedFiles > 0 &&
          !candidate.inspectionError &&
          canonicalEvidenceUrlSet(candidate.evidenceUrls).size > 0,
      )
      .map((candidate) => [candidate.candidateId, candidate]),
  );
  const productComparisons = research.comparisons.filter(
    (comparison) =>
      comparison.origin === "competitive-selection" &&
      products.has(comparison.candidateId),
  );
  const evidenceValidComparisonIds = uniquelyActionableComparisonIds(
    productComparisons,
    (comparison) =>
      matchingEvidenceUrls(
        comparison.evidenceUrls,
        canonicalEvidenceUrlSet(products.get(comparison.candidateId)!.evidenceUrls),
      ).length > 0,
  );
  const uniqueRecommendations = new Map(
    research.recommendations
      .filter((recommendation) => {
        const candidate = products.get(recommendation.candidateId);
        if (!candidate) return false;
        const evidence = canonicalEvidenceUrlSet(candidate.evidenceUrls);
        return (
          recommendation.origin === "competitive-selection" &&
          recommendation.reuseMode !== "reference-only" &&
          evidenceValidComparisonIds.has(recommendation.candidateId) &&
          canonicalHttpEvidenceUrl(recommendation.sourceUrl) ===
            canonicalHttpEvidenceUrl(candidate.url) &&
          recommendation.howToIntegrate.trim().length > 0 &&
          matchingEvidenceUrls(recommendation.evidenceUrls, evidence).length > 0
        );
      })
      .map((recommendation) => [recommendation.candidateId, recommendation]),
  );
  const additions = [...uniqueRecommendations.values()]
    .slice(0, Math.max(5, research.competitiveAudit?.coverage.productTarget ?? 5))
    .map(
      (recommendation, index) =>
        `[COMP-${index + 1}] The delivered application implements and verifies ` +
        `${recommendation.name}: ${recommendation.howToIntegrate.trim()}`,
    );
  const acceptanceCriteria = [...spec.acceptanceCriteria];
  for (const criterion of additions) {
    if (!acceptanceCriteria.includes(criterion)) acceptanceCriteria.push(criterion);
  }
  return { ...spec, acceptanceCriteria };
}

/** Convert private checkpoint research into a bounded, durable final-report bundle. */
export function summarizeCompetitiveEvidence(
  research: ResearchFindings,
  required: boolean,
): CompetitiveResearchSummary {
  const audit = research.competitiveAudit;
  const gate = assessRequiredCompetitiveEvidence(research);
  const products = new Map(
    (audit?.candidates ?? [])
      .filter(
        (candidate) =>
          candidate.kind === "product" &&
          candidate.inspectedFiles > 0 &&
          !candidate.inspectionError &&
          canonicalEvidenceUrlSet(candidate.evidenceUrls).size > 0,
      )
      .map((candidate) => [candidate.candidateId, candidate]),
  );
  const validComparisons = research.comparisons.filter((comparison) => {
    const candidate = products.get(comparison.candidateId);
    return (
      comparison.origin === "competitive-selection" &&
      Boolean(candidate) &&
      matchingEvidenceUrls(
        comparison.evidenceUrls,
        canonicalEvidenceUrlSet(candidate!.evidenceUrls),
      ).length > 0
    );
  });
  const productComparisons = research.comparisons.filter(
    (comparison) =>
      comparison.origin === "competitive-selection" &&
      products.has(comparison.candidateId),
  );
  const qualifyingComparisonIds = uniquelyActionableComparisonIds(
    productComparisons,
    (comparison) =>
      matchingEvidenceUrls(
        comparison.evidenceUrls,
        canonicalEvidenceUrlSet(products.get(comparison.candidateId)!.evidenceUrls),
      ).length > 0,
  );
  const competitors = [
    ...new Map(
      validComparisons.map((comparison) => [comparison.candidateId, comparison]),
    ).values(),
  ].map((comparison) => {
    const candidate = products.get(comparison.candidateId)!;
    return {
      candidateId: comparison.candidateId,
      name: comparison.name || candidate.name,
      url: candidate.url,
      score: comparison.score,
      decision: comparison.decision,
      strengths: comparison.strengths,
      gaps: comparison.gaps,
      evidenceUrls: [...new Set([candidate.url, ...comparison.evidenceUrls])],
    };
  });
  const validRecommendations = research.recommendations.filter((recommendation) => {
    const candidate = products.get(recommendation.candidateId);
    return (
      recommendation.origin === "competitive-selection" &&
      Boolean(candidate) &&
      recommendation.reuseMode !== "reference-only" &&
      qualifyingComparisonIds.has(recommendation.candidateId) &&
      canonicalHttpEvidenceUrl(recommendation.sourceUrl) ===
        canonicalHttpEvidenceUrl(candidate!.url) &&
      recommendation.howToIntegrate.trim().length > 0 &&
      matchingEvidenceUrls(
        recommendation.evidenceUrls,
        canonicalEvidenceUrlSet(candidate!.evidenceUrls),
      ).length > 0
    );
  });
  const recommendations = [
    ...new Map(
      validRecommendations.map((recommendation) => [
        recommendation.candidateId,
        recommendation,
      ]),
    ).values(),
  ].map((recommendation) => ({
    candidateId: recommendation.candidateId,
    name: recommendation.name,
    sourceUrl: recommendation.sourceUrl,
    why: recommendation.why,
    howToIntegrate: recommendation.howToIntegrate,
    reuseMode: recommendation.reuseMode,
    evidenceUrls: [
      ...new Set(
        [recommendation.sourceUrl, ...recommendation.evidenceUrls].filter(Boolean),
      ),
    ],
    score: recommendation.score,
  }));
  return {
    required,
    coverageMet: gate.ok,
    productTarget: gate.productTarget,
    productVerifiedCount: gate.productVerifiedCount,
    productComparedCount: gate.productComparedCount,
    productSelectedCount: gate.productSelectedCount,
    repositoryVerifiedCount: audit?.coverage.repositoryVerifiedCount ?? 0,
    generatedAt: audit?.generatedAt ?? "",
    queries: audit?.queries ?? [],
    sources: (audit?.sources ?? []).map((source) => ({
      name: source.name,
      status: source.status,
      detail: source.detail,
    })),
    competitors,
    recommendations,
  };
}
