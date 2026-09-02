import { describe, expect, it } from "vitest";
import {
  evaluateProductionReadiness,
  type ProductionReadinessEvidence,
  type ReadinessBrainReview,
} from "../orchestrator/productionReadinessPolicy.js";

const DIGEST = `sha256:${"1".repeat(64)}`;

function review(
  identity: "lead" | "challenger",
  provider: "openai" | "anthropic" = "openai",
): ReadinessBrainReview {
  return {
    identity,
    provider,
    model: provider === "openai" ? "gpt-5.5" : "claude-opus-5",
    evidenceDigest: DIGEST,
    decision: "ready",
    purposeAligned: true,
    implementationComplete: true,
    technicallyReady: true,
    blockers: [],
  };
}

function evidence(reviews: ReadinessBrainReview[]): ProductionReadinessEvidence {
  return {
    evidenceDigest: DIGEST,
    appName: "Paid Ladder App",
    purpose: {
      stated: true,
      grounded: true,
      goalsCovered: true,
      acceptanceCriteria: 1,
      acceptanceCriteriaExecuted: 1,
    },
    technical: {
      artifactDigest: `sha256:${"a".repeat(64)}`,
      qaPassed: true,
      testsPassed: true,
      verificationComplete: true,
      digestReceiptValid: true,
      blockingWriteRefusals: 0,
      wiringComplete: true,
      highOrCriticalSecurityIssues: 0,
      operationallyRunnable: true,
      completionGaps: 0,
      platformCompatibility: {
        windows: { applicable: false, verified: true, evidence: ["not applicable"] },
        webkit: { applicable: false, verified: true, evidence: ["not applicable"] },
        macos: { applicable: false, verified: true, evidence: ["not applicable"] },
        ios: { applicable: false, verified: true, evidence: ["not applicable"] },
        android: { applicable: false, verified: true, evidence: ["not applicable"] },
      },
    },
    delivery: {
      kind: "workspace-only",
      delivered: true,
      releasedToTrunk: false,
      liveVerified: false,
      localArtifactVerified: true,
    },
    reviews,
  };
}

describe("unified paid-ladder readiness policy", () => {
  it("accepts two independent approvals after both routes land on one paid family", () => {
    const receipt = evaluateProductionReadiness(
      evidence([review("lead"), review("challenger")]),
    );

    expect(receipt.ready).toBe(true);
    expect(receipt.brainFloor).toMatchObject({
      lead: true,
      challenger: true,
      independentReviews: true,
      paidModels: true,
      sameEvidence: true,
      independentFamilies: false,
    });
  });

  it("still requires exactly one lead and one challenger decision", () => {
    const receipt = evaluateProductionReadiness(evidence([review("lead")]));

    expect(receipt.ready).toBe(false);
    expect(receipt.blockers.join(" ")).toMatch(/challenger|exactly two/i);
  });

  it("refuses approvals bound to stale evidence", () => {
    const stale = {
      ...review("challenger", "anthropic"),
      evidenceDigest: `sha256:${"2".repeat(64)}`,
    };
    const receipt = evaluateProductionReadiness(evidence([review("lead"), stale]));

    expect(receipt.ready).toBe(false);
    expect(receipt.brainFloor.sameEvidence).toBe(false);
  });
});
