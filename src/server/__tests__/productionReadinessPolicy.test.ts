import { describe, expect, it } from "vitest";
import {
  PRODUCTION_READINESS_POLICY,
  evaluateProductionReadiness,
  readinessDeliveryKind,
  type ProductionReadinessEvidence,
  type ReadinessBrainReview,
} from "../orchestrator/productionReadinessPolicy.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const STALE_DIGEST = `sha256:${"b".repeat(64)}`;

const lead = (over: Partial<ReadinessBrainReview> = {}): ReadinessBrainReview => ({
  identity: "lead",
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

const challenger = (
  over: Partial<ReadinessBrainReview> = {},
): ReadinessBrainReview => ({
  identity: "challenger",
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
    kind: "existing-repo",
    delivered: true,
    releasedToTrunk: true,
    liveVerified: false,
    localArtifactVerified: false,
  },
  reviews: [lead(), challenger()],
  ...over,
});

describe("mandatory production-readiness policy", () => {
  it("treats an explicitly local new repo as a verified workspace artifact", () => {
    expect(
      readinessDeliveryKind(
        { kind: "new-repo" },
        { newRepo: { name: "local-app", createRemote: false } },
      ),
    ).toBe("workspace-only");
    expect(
      readinessDeliveryKind(
        { kind: "new-repo" },
        { newRepo: { name: "hosted-app", createRemote: true } },
      ),
    ).toBe("new-repo");
  });

  it("issues a receipt only for purpose-aligned, executed, delivered work approved by both automatic-ladder reviewers", () => {
    const receipt = evaluateProductionReadiness(evidence());
    expect(receipt.ready).toBe(true);
    expect(receipt.mandatory).toBe(true);
    expect(receipt.schema).toBe(PRODUCTION_READINESS_POLICY.version);
    expect(receipt.brainFloor).toEqual({
      lead: true,
      challenger: true,
      independentReviews: true,
      liveModels: true,
      paidModels: true,
      sameEvidence: true,
      sol: false,
      fableOrOpus: false,
      independentFamilies: true,
    });
  });

  it("requires both reviewer slots but permits both to land on one live family", () => {
    const onlyLead = evaluateProductionReadiness(evidence({ reviews: [lead()] }));
    expect(onlyLead.ready).toBe(false);
    expect(onlyLead.blockers.join(" ")).toMatch(/challenger|exactly two/i);

    const sameFamily = evaluateProductionReadiness(
      evidence({
        reviews: [lead(), challenger({ provider: "openai", model: "gpt-5.6-pro" })],
      }),
    );
    expect(sameFamily.ready).toBe(true);
    expect(sameFamily.brainFloor.independentFamilies).toBe(false);
  });

  it("accepts independent judgments served by the terminal AI Time free rung", () => {
    const receipt = evaluateProductionReadiness(
      evidence({
        reviews: [
          lead({ provider: "free", model: "qwen2.5-coder:14b" }),
          challenger({ provider: "free", model: "qwen2.5-coder:14b" }),
        ],
      }),
    );
    expect(receipt.ready).toBe(true);
    expect(receipt.brainFloor.liveModels).toBe(true);
    expect(receipt.brainFloor.paidModels).toBe(false);
  });

  it("refuses a reviewer record without the actual model identity", () => {
    const receipt = evaluateProductionReadiness(
      evidence({ reviews: [lead(), challenger({ model: "" })] }),
    );
    expect(receipt.ready).toBe(false);
    expect(receipt.brainFloor.liveModels).toBe(false);
  });

  it("requires a nonempty canonical SHA-256 evidence digest", () => {
    for (const badDigest of ["", "sha256:exact", "sha256:ABC", "md5:deadbeef"]) {
      const receipt = evaluateProductionReadiness(
        evidence({
          evidenceDigest: badDigest,
          reviews: [
            lead({ evidenceDigest: badDigest }),
            challenger({ evidenceDigest: badDigest }),
          ],
        }),
      );
      expect(receipt.ready, badDigest).toBe(false);
      expect(receipt.blockers.join(" "), badDigest).toMatch(/digest.*malformed/i);
    }
  });

  it("requires every eligible brain decision to agree on the same evidence", () => {
    const stale = evaluateProductionReadiness(
      evidence({ reviews: [lead(), challenger({ evidenceDigest: STALE_DIGEST })] }),
    );
    expect(stale.ready).toBe(false);
    expect(stale.brainFloor.sameEvidence).toBe(false);

    const conflict = evaluateProductionReadiness(
      evidence({
        reviews: [
          lead(),
          lead({ decision: "not_ready", technicallyReady: false }),
          challenger(),
        ],
      }),
    );
    expect(conflict.ready).toBe(false);
    expect(conflict.brainFloor.lead).toBe(false);
    expect(conflict.blockers.join(" ")).toMatch(/lead reviewer|exactly two/i);
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

  it("blocks placeholders, unfinished code, and missing applicable platform evidence", () => {
    const gaps = evaluateProductionReadiness(
      evidence({
        technical: { ...evidence().technical, completionGaps: 2 },
      }),
    );
    expect(gaps.ready).toBe(false);
    expect(gaps.blockers.join(" ")).toMatch(/unfinished production path/i);

    const platform = evaluateProductionReadiness(
      evidence({
        technical: {
          ...evidence().technical,
          platformCompatibility: {
            ...evidence().technical.platformCompatibility,
            webkit: { applicable: true, verified: false, evidence: [] },
          },
        },
      }),
    );
    expect(platform.ready).toBe(false);
    expect(platform.blockers.join(" ")).toMatch(/webkit compatibility/i);
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

  it("allows truthful pre-release delivery=false only in candidate-review mode", () => {
    const candidate = evidence({
      delivery: {
        kind: "existing-repo",
        delivered: false,
        releasedToTrunk: false,
        liveVerified: false,
        localArtifactVerified: false,
      },
    });
    expect(evaluateProductionReadiness(candidate).ready).toBe(false);
    expect(
      evaluateProductionReadiness(candidate, { requireDelivery: false }).ready,
    ).toBe(true);
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
