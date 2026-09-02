import { z } from "zod";
import type { LLMProvider } from "../../shared/types.js";
import { SYSTEM_PREAMBLE } from "./types.js";
import type {
  ProductionReadinessEvidence,
  ReadinessBlockerCategory,
  ReadinessBrainIdentity,
  ReadinessBrainReview,
} from "../orchestrator/productionReadinessPolicy.js";

const ReviewDraftSchema = z.object({
  decision: z.enum(["ready", "not_ready"]),
  purposeAligned: z.boolean(),
  implementationComplete: z.boolean(),
  technicallyReady: z.boolean(),
  blockers: z
    .array(
      z.object({
        category: z.enum([
          "purpose",
          "implementation",
          "verification",
          "security",
          "operations",
          "delivery",
          "usability",
          "performance",
        ] satisfies [ReadinessBlockerCategory, ...ReadinessBlockerCategory[]]),
        detail: z.string().trim().min(1).max(2_000),
      }),
    )
    .max(100),
});

type ReviewDraft = z.infer<typeof ReviewDraftSchema>;

type Deferred<T> = T | (() => T);

type ReviewInput = {
  provider: LLMProvider;
  identity: Deferred<ReadinessBrainIdentity>;
  providerName?: Deferred<"openai" | "anthropic">;
  model: Deferred<string>;
  evidence: Omit<ProductionReadinessEvidence, "reviews">;
  phase?: "pre-release" | "final";
};

function resolveDeferred<T>(value: Deferred<T>): T {
  return typeof value === "function" ? (value as () => T)() : value;
}

/**
 * Ask one readiness brain to decide independently. Reviewer slot, actual paid
 * provider, model, and evidence digest are stamped by the orchestrator after
 * generation; model output cannot promote itself or review stale bytes.
 */
export async function productionReadinessAgent(
  input: ReviewInput,
): Promise<ReadinessBrainReview> {
  const initialProvider = resolveDeferred(input.providerName ?? input.provider.name);
  if (initialProvider !== "openai" && initialProvider !== "anthropic") {
    throw new Error(
      `Production readiness review requires a paid provider, not ${initialProvider}.`,
    );
  }
  const preReleaseContract =
    input.phase === "pre-release"
      ? " This is a PRE-RELEASE CANDIDATE review: delivery fields are truthfully false because no push, trunk, release, or deploy side effect is allowed before you decide. Do not reject solely because delivery has not happened, and never claim it has happened. Judge the exact candidate bytes, purpose, implementation, verification, security, operations, and platform evidence."
      : " Require truthful completed delivery in addition to the technical and purpose evidence.";

  const draft = await input.provider.generateJson<ReviewDraft>({
    system:
      `${SYSTEM_PREAMBLE}\nYou are an independent production-readiness reviewer. Decide from the supplied immutable technical evidence only. ` +
      "The app's stated purpose, intended users, essential workflows, goals, and executable acceptance criteria are authoritative. " +
      "A pipeline reaching its last stage is not completion. Require working implementation, zero placeholder/TODO/stub paths, direct executed acceptance evidence, grounded QA, exact-byte verification, secure and operational behavior, truthful delivery, and executed compatibility evidence for every applicable Windows, Safari/WebKit, macOS, iOS, and Android target. " +
      "Do not evaluate or invent legal, regulatory, contractual, store-policy, or licensing clearance. Those are owner-managed outside this software gate and must not appear as blockers. " +
      "Technical privacy leaks, authorization defects, insecure storage, unsafe clinical claims implemented in software, destructive financial behavior, and missing security controls remain technical blockers. " +
      `Return READY only when every supplied technical and purpose criterion is satisfied. Never rely on another model's opinion; none is provided.${preReleaseContract}`,
    prompt:
      `Review this exact production-readiness evidence digest: ${input.evidence.evidenceDigest}.\n\n` +
      `${JSON.stringify(input.evidence, null, 2)}\n\n` +
      "Return decision, purposeAligned, implementationComplete, technicallyReady, and categorized technical blockers. A READY response must have zero blockers and all three booleans true.",
    schema: ReviewDraftSchema,
    schemaName: "ProductionReadinessReview",
    intent: {
      role: "judge",
      needs: ["code_review", "structured_json", "honest"],
      purpose: "mandatory-production-readiness",
    },
    temperature: 0,
  });

  const ready =
    draft.decision === "ready" &&
    draft.purposeAligned &&
    draft.implementationComplete &&
    draft.technicallyReady &&
    draft.blockers.length === 0;
  const identity = resolveDeferred(input.identity);
  const model = resolveDeferred(input.model);
  const resolvedProvider = resolveDeferred(input.providerName ?? input.provider.name);
  if (resolvedProvider !== "openai" && resolvedProvider !== "anthropic") {
    throw new Error(
      `Production readiness review requires a paid provider, not ${resolvedProvider}.`,
    );
  }
  if (!model.trim()) throw new Error("Production readiness review model is missing.");

  return {
    identity,
    provider: resolvedProvider,
    model,
    evidenceDigest: input.evidence.evidenceDigest,
    decision: ready ? "ready" : "not_ready",
    purposeAligned: draft.purposeAligned,
    implementationComplete: draft.implementationComplete,
    technicallyReady: draft.technicallyReady,
    blockers: draft.blockers,
  };
}

/**
 * Launch both mandatory reviews from the same immutable evidence before either
 * result is available. There is no sequential opinion-sharing or one-brain
 * fallback: one rejection/failure leaves the caller without a ready receipt.
 */
export async function independentProductionReadinessReviews(input: {
  leadProvider: LLMProvider;
  leadProviderName: Deferred<"openai" | "anthropic">;
  leadModel: Deferred<string>;
  challengerProvider: LLMProvider;
  challengerProviderName: Deferred<"openai" | "anthropic">;
  challengerModel: Deferred<string>;
  evidence: Omit<ProductionReadinessEvidence, "reviews">;
  phase?: "pre-release" | "final";
}): Promise<[ReadinessBrainReview, ReadinessBrainReview]> {
  return Promise.all([
    productionReadinessAgent({
      provider: input.leadProvider,
      identity: "lead",
      providerName: input.leadProviderName,
      model: input.leadModel,
      evidence: input.evidence,
      phase: input.phase,
    }),
    productionReadinessAgent({
      provider: input.challengerProvider,
      identity: "challenger",
      providerName: input.challengerProviderName,
      model: input.challengerModel,
      evidence: input.evidence,
      phase: input.phase,
    }),
  ]);
}
