import { createHash } from "node:crypto";
import type { LLMProvider } from "../../shared/types.js";
import { independentProductionReadinessReviews } from "../agents/productionReadinessAgent.js";
import {
  evaluateProductionReadiness,
  type ProductionReadinessEvidence,
  type ProductionReadinessReceipt,
  type ReadinessBrainReview,
} from "./productionReadinessPolicy.js";
import {
  markReadinessEvaluating,
  recordReadinessEvaluation,
  type ReadinessState,
} from "../storage/readinessStore.js";

export type ProductionReadinessFacts = Omit<
  ProductionReadinessEvidence,
  "evidenceDigest" | "reviews"
>;

export type ProductionReadinessCompletion = {
  evidence: ProductionReadinessEvidence;
  reviews: ReadinessBrainReview[];
  receipt: ProductionReadinessReceipt;
  state: ReadinessState;
};

/** Stable JSON form so object key order can never create a different receipt. */
export function canonicalReadinessJson(value: unknown): string {
  const stable = (input: unknown): unknown => {
    if (input === null || typeof input === "string" || typeof input === "boolean") {
      return input;
    }
    if (typeof input === "number") {
      if (!Number.isFinite(input)) {
        throw new Error("Readiness evidence contains a non-finite number.");
      }
      return input;
    }
    if (Array.isArray(input)) return input.map(stable);
    if (input && typeof input === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(input as Record<string, unknown>).sort()) {
        const child = (input as Record<string, unknown>)[key];
        if (child !== undefined && typeof child !== "function") {
          out[key] = stable(child);
        }
      }
      return out;
    }
    if (input === undefined) return null;
    throw new Error(`Unsupported readiness evidence value: ${typeof input}`);
  };
  return JSON.stringify(stable(value));
}

export function productionReadinessDigest(facts: ProductionReadinessFacts): string {
  return `sha256:${createHash("sha256")
    .update(canonicalReadinessJson(facts), "utf8")
    .digest("hex")}`;
}

/** Bind readiness semantics to the exact sorted path -> byte-digest receipt. */
export function artifactTreeDigest(fileDigests: Record<string, string>): string {
  const sorted = Object.fromEntries(
    Object.entries(fileDigests).sort(([left], [right]) => left.localeCompare(right)),
  );
  return `sha256:${createHash("sha256")
    .update(canonicalReadinessJson(sorted), "utf8")
    .digest("hex")}`;
}

/** Truthful candidate facts: intended destination kind is known; delivery is not. */
export function candidateReadinessFacts(
  facts: ProductionReadinessFacts,
): ProductionReadinessFacts {
  return {
    ...facts,
    delivery: {
      kind: facts.delivery.kind,
      delivered: false,
      releasedToTrunk: false,
      liveVerified: false,
      localArtifactVerified: false,
    },
  };
}

export type PreReleaseReadinessApproval = {
  schema: "factory.pre-release-readiness.v1";
  evidenceDigest: string;
  approved: boolean;
  reviews: ReadinessBrainReview[];
  blockers: string[];
};

/**
 * Two independent semantic decisions over the exact candidate bytes, before
 * any branch push, trunk advance, release, or deploy is allowed.
 */
export async function completePreReleaseReadiness(input: {
  facts: ProductionReadinessFacts;
  leadProvider: LLMProvider;
  leadProviderName: "openai" | "anthropic" | (() => "openai" | "anthropic");
  leadModel: string | (() => string);
  challengerProvider: LLMProvider;
  challengerProviderName: "openai" | "anthropic" | (() => "openai" | "anthropic");
  challengerModel: string | (() => string);
}): Promise<PreReleaseReadinessApproval> {
  const facts = candidateReadinessFacts(input.facts);
  const evidenceDigest = productionReadinessDigest(facts);
  const evidence = Object.freeze({ ...facts, evidenceDigest });
  let reviews: ReadinessBrainReview[] = [];
  try {
    reviews = await independentProductionReadinessReviews({
      leadProvider: input.leadProvider,
      leadProviderName: input.leadProviderName,
      leadModel: input.leadModel,
      challengerProvider: input.challengerProvider,
      challengerProviderName: input.challengerProviderName,
      challengerModel: input.challengerModel,
      evidence,
      phase: "pre-release",
    });
  } catch {
    return {
      schema: "factory.pre-release-readiness.v1",
      evidenceDigest,
      approved: false,
      reviews: [],
      blockers: [
        "Mandatory paid-ladder pre-release review failed before both independent decisions completed.",
      ],
    };
  }
  const receipt = evaluateProductionReadiness(
    { ...evidence, reviews },
    { requireDelivery: false },
  );
  return {
    schema: "factory.pre-release-readiness.v1",
    evidenceDigest,
    approved: receipt.ready,
    reviews,
    blockers: receipt.blockers,
  };
}

export function validatePreReleaseApproval(
  approval: PreReleaseReadinessApproval | undefined,
  currentFacts: ProductionReadinessFacts,
): { ok: boolean; blockers: string[] } {
  const facts = candidateReadinessFacts(currentFacts);
  const currentDigest = productionReadinessDigest(facts);
  if (!approval) {
    return { ok: false, blockers: ["Pre-release readiness approval is missing."] };
  }
  if (approval.evidenceDigest !== currentDigest) {
    return {
      ok: false,
      blockers: [
        `Pre-release readiness approval is stale: reviewed ${approval.evidenceDigest}, current candidate is ${currentDigest}.`,
      ],
    };
  }
  const receipt = evaluateProductionReadiness(
    {
      ...facts,
      evidenceDigest: currentDigest,
      reviews: approval.reviews,
    },
    { requireDelivery: false },
  );
  return {
    ok: approval.approved && receipt.ready,
    blockers: approval.approved ? receipt.blockers : approval.blockers,
  };
}

/** Testable side-effect boundary; callback is never invoked on rejection/staleness. */
export async function runWithPreReleaseApproval<T>(
  approval: PreReleaseReadinessApproval | undefined,
  currentFacts: ProductionReadinessFacts,
  effect: () => Promise<T>,
): Promise<{ executed: boolean; value?: T; blockers: string[] }> {
  const validation = validatePreReleaseApproval(approval, currentFacts);
  if (!validation.ok) return { executed: false, blockers: validation.blockers };
  return { executed: true, value: await effect(), blockers: [] };
}

/**
 * Bind actual post-delivery evidence to the exact already-approved candidate.
 * Brains are not relabelled as having reviewed delivery: their review digests
 * remain the candidate digest, while delivery is evaluated deterministically.
 */
export function finalizeProductionReadinessFromApproval(
  facts: ProductionReadinessFacts,
  approval: PreReleaseReadinessApproval | undefined,
): Omit<ProductionReadinessCompletion, "state"> {
  const candidate = candidateReadinessFacts(facts);
  const candidateDigest = productionReadinessDigest(candidate);
  const evidenceDigest = productionReadinessDigest(facts);
  const reviews = approval?.reviews ?? [];
  const evidence: ProductionReadinessEvidence = {
    ...facts,
    evidenceDigest,
    reviews,
  };
  const receipt = evaluateProductionReadiness(evidence, {
    expectedReviewDigest: candidateDigest,
  });
  const validation = validatePreReleaseApproval(approval, candidate);
  if (!validation.ok) {
    receipt.ready = false;
    receipt.brainFloor.sameEvidence = false;
    receipt.blockers = [...validation.blockers, ...receipt.blockers];
  }
  return { evidence, reviews, receipt };
}

/**
 * The single mandatory readiness transaction used by Factory Deck runs and
 * Purpose Foundry projects. Both brains start from the same immutable facts and
 * neither sees the other's answer. Any call failure leaves the durable state in
 * `evaluating`/blocked territory; no receipt or one-brain fallback is minted.
 */
export async function completeProductionReadiness(input: {
  subjectType: "run" | "foundry-project";
  subjectId: string;
  facts: ProductionReadinessFacts;
  leadProvider: LLMProvider;
  leadProviderName: "openai" | "anthropic" | (() => "openai" | "anthropic");
  leadModel: string | (() => string);
  challengerProvider: LLMProvider;
  challengerProviderName: "openai" | "anthropic" | (() => "openai" | "anthropic");
  challengerModel: string | (() => string);
}): Promise<ProductionReadinessCompletion> {
  const evidenceDigest = productionReadinessDigest(input.facts);
  await markReadinessEvaluating({
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    evidenceDigest,
  });

  const immutableEvidence = Object.freeze({
    ...input.facts,
    evidenceDigest,
  });
  let reviews: ReadinessBrainReview[] = [];
  try {
    reviews = await independentProductionReadinessReviews({
      leadProvider: input.leadProvider,
      leadProviderName: input.leadProviderName,
      leadModel: input.leadModel,
      challengerProvider: input.challengerProvider,
      challengerProviderName: input.challengerProviderName,
      challengerModel: input.challengerModel,
      evidence: immutableEvidence,
    });
  } catch {
    const evidence: ProductionReadinessEvidence = {
      ...immutableEvidence,
      reviews: [],
    };
    const receipt = evaluateProductionReadiness(evidence);
    receipt.blockers = [
      "Mandatory paid-ladder review failed before both independent decisions completed.",
      ...receipt.blockers,
    ];
    const state = await recordReadinessEvaluation({
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      evidenceDigest,
      reviews: [],
      receipt,
    });
    return { evidence, reviews: [], receipt, state };
  }
  const evidence: ProductionReadinessEvidence = {
    ...immutableEvidence,
    reviews,
  };
  const receipt = evaluateProductionReadiness(evidence);
  const state = await recordReadinessEvaluation({
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    evidenceDigest,
    reviews,
    receipt,
  });
  return { evidence, reviews, receipt, state };
}
