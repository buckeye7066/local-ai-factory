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

type ReviewInput = {
  provider: LLMProvider;
  identity: ReadinessBrainIdentity;
  model: string;
  evidence: Omit<ProductionReadinessEvidence, "reviews">;
  phase?: "pre-release" | "final";
};

/**
 * Ask one readiness brain to decide independently. Identity, provider family,
 * model, and evidence digest are stamped by the orchestrator after generation;
 * model output cannot promote itself into Sol/Fable/Opus or review stale bytes.
 */
export async function productionReadinessAgent(
  input: ReviewInput,
): Promise<ReadinessBrainReview> {
  const expectedProvider = input.identity === "sol" ? "openai" : "anthropic";
  if (input.provider.name !== expectedProvider) {
    throw new Error(
      `${input.identity} readiness review requires ${expectedProvider}, not ${input.provider.name}.`,
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

  return {
    identity: input.identity,
    provider: expectedProvider,
    model: input.model,
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
  solProvider: LLMProvider;
  solModel: string;
  secondProvider: LLMProvider;
  secondIdentity: "fable" | "opus";
  secondModel: string;
  evidence: Omit<ProductionReadinessEvidence, "reviews">;
  phase?: "pre-release" | "final";
}): Promise<[ReadinessBrainReview, ReadinessBrainReview]> {
  return Promise.all([
    productionReadinessAgent({
      provider: input.solProvider,
      identity: "sol",
      model: input.solModel,
      evidence: input.evidence,
      phase: input.phase,
    }),
    productionReadinessAgent({
      provider: input.secondProvider,
      identity: input.secondIdentity,
      model: input.secondModel,
      evidence: input.evidence,
      phase: input.phase,
    }),
  ]);
}
