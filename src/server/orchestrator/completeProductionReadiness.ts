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
  solProvider: LLMProvider;
  solModel: string;
  secondProvider: LLMProvider;
  secondIdentity: "fable" | "opus";
  secondModel: string;
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
      solProvider: input.solProvider,
      solModel: input.solModel,
      secondProvider: input.secondProvider,
      secondIdentity: input.secondIdentity,
      secondModel: input.secondModel,
      evidence: immutableEvidence,
    });
  } catch {
    const evidence: ProductionReadinessEvidence = {
      ...immutableEvidence,
      reviews: [],
    };
    const receipt = evaluateProductionReadiness(evidence);
    receipt.blockers = [
      "Mandatory Sol and Fable/Opus review failed before both independent decisions completed.",
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
