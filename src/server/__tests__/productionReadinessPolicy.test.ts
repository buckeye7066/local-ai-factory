import { describe, expect, it } from "vitest";
import {
  PRODUCTION_READINESS_POLICY,
  evaluateProductionReadiness,
  type ProductionReadinessEvidence,
  type ReadinessBrainReview,
} from "../orchestrator/productionReadinessPolicy.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const STALE_DIGEST = `sha256:${"b".repeat(64)}`;

const sol = (over: Partial<ReadinessBrainReview> = {}): ReadinessBrainReview => ({
  identity: "sol",
  provider: "openai",
  model: "gpt-5.6-pro",
  evidenceDigest: DIGEST,
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
  evidenceDigest: DIGEST,
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
  evidenceDigest: DIGEST,
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
    highOrCriticalSecurityIssues: 0,
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
    expect(onlySol.blockers.join(" ")).toMatch(/Fable\/Opus|independent/);

    const disguised = evaluateProductionReadiness(
      evidence({
        reviews: [sol(), opus({ provider: "openai" })],
      }),
    );
    expect(disguised.ready).toBe(false);
    expect(disguised.brainFloor.fableOrOpus).toBe(false);
  });

  it("refuses weak, unknown, and cleverly renamed Anthropic models", () => {
    for (const model of [
      "claude-haiku",
      "not-opus",
      "claude-haiku-opus-proxy",
      "some-fable-wrapper",
    ]) {
      const receipt = evaluateProductionReadiness(
        evidence({ reviews: [sol(), opus({ model })] }),
      );
      expect(receipt.ready, model).toBe(false);
      expect(receipt.brainFloor.fableOrOpus, model).toBe(false);
    }
  });

  it("requires a nonempty canonical SHA-256 evidence digest", () => {
    for (const badDigest of ["", "sha256:exact", "sha256:ABC", "md5:deadbeef"]) {
      const receipt = evaluateProductionReadiness(
        evidence({
          evidenceDigest: badDigest,
          reviews: [
            sol({ evidenceDigest: badDigest }),
            opus({ evidenceDigest: badDigest }),
          ],
        }),
      );
      expect(receipt.ready, badDigest).toBe(false);
      expect(receipt.blockers.join(" "), badDigest).toMatch(/digest.*malformed/i);
    }
  });

  it("requires every eligible brain decision to agree on the same evidence", () => {
    const stale = evaluateProductionReadiness(
      evidence({ reviews: [sol(), opus({ evidenceDigest: STALE_DIGEST })] }),
    );
    expect(stale.ready).toBe(false);
    expect(stale.brainFloor.sameEvidence).toBe(false);

    const conflict = evaluateProductionReadiness(
      evidence({
        reviews: [
          sol(),
          sol({ decision: "not_ready", technicallyReady: false }),
          opus(),
        ],
      }),
    );
    expect(conflict.ready).toBe(false);
    expect(conflict.brainFloor.sol).toBe(false);
    expect(conflict.blockers.join(" ")).toMatch(/Sol did not unanimously approve/);
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

  it("blocks either high or critical technical security findings", () => {
    const receipt = evaluateProductionReadiness(
      evidence({
        technical: {
          ...evidence().technical,
          highOrCriticalSecurityIssues: 1,
        },
      }),
    );
    expect(receipt.ready).toBe(false);
    expect(receipt.blockers.join(" ")).toMatch(/High or critical/);
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

  it("requires a hosted new-repository app to answer live", () => {
    const localOnly = evaluateProductionReadiness(
      evidence({
        delivery: {
          kind: "new-repo",
          delivered: true,
          releasedToTrunk: false,
          liveVerified: false,
          localArtifactVerified: true,
        },
      }),
    );
    expect(localOnly.ready).toBe(false);
    expect(localOnly.blockers.join(" ")).toMatch(/not verified live/i);

    const live = evaluateProductionReadiness(
      evidence({
        delivery: {
          kind: "new-repo",
          delivered: true,
          releasedToTrunk: false,
          liveVerified: true,
          localArtifactVerified: false,
        },
      }),
    );
    expect(live.ready).toBe(true);
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
