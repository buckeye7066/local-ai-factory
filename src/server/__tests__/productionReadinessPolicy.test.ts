import { describe, expect, it } from "vitest";
import {
  PRODUCTION_READINESS_POLICY,
  evaluateProductionReadiness,
  type ProductionReadinessEvidence,
  type ReadinessBrainReview,
} from "../orchestrator/productionReadinessPolicy.js";

const sol = (over: Partial<ReadinessBrainReview> = {}): ReadinessBrainReview => ({
  identity: "sol",
  provider: "openai",
  model: "gpt-5.6-pro",
  evidenceDigest: "sha256:exact",
  decision: "ready",
  purposeAligned: true,
  implementationComplete: true,
  technicallyReady: true,
  blockers: [],
  ...over,
});

const opus = (over: Partial<ReadinessBrainReview> = {}): ReadinessBrainReview => ({
  identity: "opus",
  provider: "anthropic",
  model: "claude-opus-4-8",
  evidenceDigest: "sha256:exact",
  decision: "ready",
  purposeAligned: true,
  implementationComplete: true,
  technicallyReady: true,
  blockers: [],
  ...over,
});

const evidence = (
  over: Partial<ProductionReadinessEvidence> = {},
): ProductionReadinessEvidence => ({
  evidenceDigest: "sha256:exact",
  appName: "Purposeful App",
  purpose: {
    stated: true,
    grounded: true,
    goalsCovered: true,
    acceptanceCriteria: 4,
    acceptanceCriteriaExecuted: 4,
  },
  technical: {
    qaPassed: true,
    testsPassed: true,
    verificationComplete: true,
    digestReceiptValid: true,
    blockingWriteRefusals: 0,
    wiringComplete: true,
    criticalSecurityIssues: 0,
    operationallyRunnable: true,
  },
  delivery: {
    kind: "existing-repo",
    delivered: true,
    releasedToTrunk: true,
    liveVerified: false,
    localArtifactVerified: false,
  },
  reviews: [sol(), opus()],
  ...over,
});

describe("mandatory production-readiness policy", () => {
  it("issues a receipt only for purpose-aligned, executed, delivered work approved by Sol and Opus/Fable", () => {
    const receipt = evaluateProductionReadiness(evidence());
    expect(receipt.ready).toBe(true);
    expect(receipt.mandatory).toBe(true);
    expect(receipt.schema).toBe(PRODUCTION_READINESS_POLICY.version);
    expect(receipt.brainFloor).toEqual({
      sol: true,
      fableOrOpus: true,
      independentFamilies: true,
      sameEvidence: true,
    });
  });

  it("refuses a single-brain or same-family self-review", () => {
    const onlySol = evaluateProductionReadiness(evidence({ reviews: [sol()] }));
    expect(onlySol.ready).toBe(false);
    expect(onlySol.blockers.join(" ")).toMatch(/Fable nor Opus|independent/);

    const disguised = evaluateProductionReadiness(
      evidence({
        reviews: [sol(), opus({ provider: "openai", model: "claude-opus-4-8" })],
      }),
    );
    expect(disguised.ready).toBe(false);
    expect(disguised.brainFloor.fableOrOpus).toBe(false);
  });

  it("refuses an Anthropic reviewer below the Fable-or-Opus floor", () => {
    const receipt = evaluateProductionReadiness(
      evidence({ reviews: [sol(), opus({ model: "claude-haiku" })] }),
    );
    expect(receipt.ready).toBe(false);
    expect(receipt.blockers.join(" ")).toMatch(/Fable nor Opus/);
  });

  it("requires both brains to review the same exact evidence digest", () => {
    const receipt = evaluateProductionReadiness(
      evidence({ reviews: [sol(), opus({ evidenceDigest: "sha256:stale" })] }),
    );
    expect(receipt.ready).toBe(false);
    expect(receipt.brainFloor.sameEvidence).toBe(false);
  });

  it("does not confuse a green pipeline with purpose completion", () => {
    const receipt = evaluateProductionReadiness(
      evidence({
        purpose: {
          stated: true,
          grounded: true,
          goalsCovered: false,
          acceptanceCriteria: 4,
          acceptanceCriteriaExecuted: 3,
        },
      }),
    );
    expect(receipt.ready).toBe(false);
    expect(receipt.blockers.join(" ")).toMatch(/goals|acceptance criterion/i);
  });

  it("requires an existing-repo revision to reach the trunk", () => {
    const receipt = evaluateProductionReadiness(
      evidence({
        delivery: {
          kind: "existing-repo",
          delivered: true,
          releasedToTrunk: false,
          liveVerified: false,
          localArtifactVerified: false,
        },
      }),
    );
    expect(receipt.ready).toBe(false);
    expect(receipt.blockers.join(" ")).toMatch(/trunk/);
  });

  it("supports truly private/local apps through verified runnable artifacts rather than public listing", () => {
    const receipt = evaluateProductionReadiness(
      evidence({
        delivery: {
          kind: "workspace-only",
          delivered: true,
          releasedToTrunk: false,
          liveVerified: false,
          localArtifactVerified: true,
        },
      }),
    );
    expect(receipt.ready).toBe(true);
  });

  it("keeps owner-handled external matters outside the cyberland blocker list", () => {
    const receipt = evaluateProductionReadiness(
      evidence({
        ownerExternalNotes: [
          "Owner will handle legal review outside cyberland.",
          "Owner will decide store-policy and licensing submissions.",
        ],
      }),
    );
    expect(receipt.ready).toBe(true);
    expect(receipt.blockers.join(" ")).not.toMatch(/legal|licens|regulat/i);
    expect(receipt.ownerExternalMatters).toBe("owner-managed-outside-cyberland");
  });
});
