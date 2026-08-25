export const PRODUCTION_READINESS_POLICY = Object.freeze({
  version: "factory.production-readiness.v1",
  mandatory: true,
  purposeBound: true,
  ownerExternalMatters: "owner-managed-outside-cyberland",
  leadBrain: Object.freeze({ identity: "sol", provider: "openai" }),
  independentBrains: Object.freeze([
    Object.freeze({ identity: "fable", provider: "anthropic" }),
    Object.freeze({ identity: "opus", provider: "anthropic" }),
  ]),
});

export type ReadinessBrainIdentity = "sol" | "fable" | "opus";
export type ReadinessBlockerCategory =
  | "purpose"
  | "implementation"
  | "verification"
  | "security"
  | "operations"
  | "delivery"
  | "usability"
  | "performance";

export type ReadinessBrainReview = {
  identity: ReadinessBrainIdentity;
  provider: "openai" | "anthropic";
  model: string;
  evidenceDigest: string;
  decision: "ready" | "not_ready";
  purposeAligned: boolean;
  implementationComplete: boolean;
  technicallyReady: boolean;
  blockers: Array<{
    category: ReadinessBlockerCategory;
    detail: string;
  }>;
};

export type ProductionReadinessEvidence = {
  evidenceDigest: string;
  appName: string;
  purpose: {
    stated: boolean;
    grounded: boolean;
    goalsCovered: boolean;
    acceptanceCriteria: number;
    acceptanceCriteriaExecuted: number;
  };
  technical: {
    qaPassed: boolean;
    testsPassed: boolean;
    verificationComplete: boolean;
    digestReceiptValid: boolean;
    blockingWriteRefusals: number;
    wiringComplete: boolean;
    criticalSecurityIssues: number;
    operationallyRunnable: boolean;
  };
  delivery: {
    kind: "existing-repo" | "new-repo" | "workspace-only";
    delivered: boolean;
    releasedToTrunk: boolean;
    liveVerified: boolean;
    localArtifactVerified: boolean;
  };
  reviews: ReadinessBrainReview[];
  /**
   * Legal, regulatory, contractual, licensing-policy, and similar owner work is
   * deliberately not evaluated by this software gate. It may be recorded for
   * the owner, but it can neither satisfy nor block the cyberland receipt.
   */
  ownerExternalNotes?: string[];
};

export type ProductionReadinessReceipt = {
  schema: typeof PRODUCTION_READINESS_POLICY.version;
  mandatory: true;
  ready: boolean;
  appName: string;
  evidenceDigest: string;
  brainFloor: {
    sol: boolean;
    fableOrOpus: boolean;
    independentFamilies: boolean;
    sameEvidence: boolean;
  };
  blockers: string[];
  ownerExternalMatters: typeof PRODUCTION_READINESS_POLICY.ownerExternalMatters;
};

function reviewReady(review: ReadinessBrainReview): boolean {
  return (
    review.decision === "ready" &&
    review.purposeAligned &&
    review.implementationComplete &&
    review.technicallyReady &&
    review.blockers.length === 0
  );
}

/**
 * A Fable-or-Opus reviewer is identified both by its declared role and by the
 * configured Anthropic model name. A cheap or unknown model cannot gain the
 * stronger label merely by returning JSON that says "opus".
 */
export function isFableOrOpusReview(review: ReadinessBrainReview): boolean {
  return (
    review.provider === "anthropic" &&
    (review.identity === "fable" || review.identity === "opus") &&
    /(fable|opus)/i.test(review.model)
  );
}

/**
 * Sol is the OpenAI lead brain. The concrete model is configuration-owned and
 * must be non-empty; model prose cannot rename a different provider into Sol.
 */
export function isSolReview(review: ReadinessBrainReview): boolean {
  return (
    review.provider === "openai" &&
    review.identity === "sol" &&
    review.model.trim().length > 0
  );
}

export function evaluateProductionReadiness(
  evidence: ProductionReadinessEvidence,
): ProductionReadinessReceipt {
  const blockers: string[] = [];
  const add = (condition: boolean, detail: string) => {
    if (!condition) blockers.push(detail);
  };

  add(evidence.purpose.stated, "Purpose is not stated.");
  add(
    evidence.purpose.grounded,
    "Purpose is not grounded in product or repository evidence.",
  );
  add(evidence.purpose.goalsCovered, "The requested goals are not fully covered.");
  add(
    evidence.purpose.acceptanceCriteria > 0,
    "No executable acceptance criteria define completion.",
  );
  add(
    evidence.purpose.acceptanceCriteriaExecuted === evidence.purpose.acceptanceCriteria,
    "Not every acceptance criterion executed successfully.",
  );

  add(evidence.technical.qaPassed, "Grounded QA did not pass.");
  add(evidence.technical.testsPassed, "Executable tests did not pass.");
  add(evidence.technical.verificationComplete, "Verification is incomplete.");
  add(
    evidence.technical.digestReceiptValid,
    "The exact delivered bytes lack a valid receipt.",
  );
  add(
    evidence.technical.blockingWriteRefusals === 0,
    "One or more required writes were refused.",
  );
  add(
    evidence.technical.wiringComplete,
    "The implementation is not fully wired into the product.",
  );
  add(
    evidence.technical.criticalSecurityIssues === 0,
    "Critical or high-severity technical security blockers remain.",
  );
  add(
    evidence.technical.operationallyRunnable,
    "The app is not operationally runnable.",
  );

  add(
    evidence.delivery.delivered,
    "The verified work was not delivered to its intended destination.",
  );
  if (evidence.delivery.kind === "existing-repo") {
    add(
      evidence.delivery.releasedToTrunk,
      "The verified revision is not on the repository trunk.",
    );
  } else if (evidence.delivery.kind === "new-repo") {
    add(
      evidence.delivery.liveVerified || evidence.delivery.localArtifactVerified,
      "The new app has neither a live verified deployment nor a verified local production artifact.",
    );
  } else {
    add(
      evidence.delivery.localArtifactVerified,
      "The workspace-only app lacks a verified runnable production artifact.",
    );
  }

  const solReviews = evidence.reviews.filter(isSolReview);
  const secondReviews = evidence.reviews.filter(isFableOrOpusReview);
  const sol = solReviews.some(reviewReady);
  const fableOrOpus = secondReviews.some(reviewReady);
  const independentFamilies = solReviews.length > 0 && secondReviews.length > 0;
  const sameEvidence = [...solReviews, ...secondReviews]
    .filter(reviewReady)
    .every((review) => review.evidenceDigest === evidence.evidenceDigest);

  add(sol, "Sol did not approve the exact readiness evidence.");
  add(fableOrOpus, "Neither Fable nor Opus approved the exact readiness evidence.");
  add(
    independentFamilies,
    "The readiness review did not use independent OpenAI and Anthropic families.",
  );
  add(
    sameEvidence,
    "The required brains did not review the same exact evidence digest.",
  );

  for (const review of evidence.reviews) {
    if (review.evidenceDigest !== evidence.evidenceDigest) continue;
    for (const blocker of review.blockers) {
      const detail = `${review.identity}/${blocker.category}: ${blocker.detail}`;
      if (!blockers.includes(detail)) blockers.push(detail);
    }
  }

  return {
    schema: PRODUCTION_READINESS_POLICY.version,
    mandatory: true,
    ready: blockers.length === 0,
    appName: evidence.appName,
    evidenceDigest: evidence.evidenceDigest,
    brainFloor: {
      sol,
      fableOrOpus,
      independentFamilies,
      sameEvidence,
    },
    blockers,
    ownerExternalMatters: PRODUCTION_READINESS_POLICY.ownerExternalMatters,
  };
}
