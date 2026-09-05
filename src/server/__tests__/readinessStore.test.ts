import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(process.cwd(), ".test-factory-readiness-store");
process.env.FACTORY_DATA_DIR = root;
await mkdir(root, { recursive: true });

const {
  assertReadyReceipt,
  initialReadinessState,
  loadReadinessState,
  markReadinessEvaluating,
  recordReadinessEvaluation,
  saveReadinessState,
} = await import("../storage/readinessStore.js");
const { evaluateProductionReadiness } =
  await import("../orchestrator/productionReadinessPolicy.js");

beforeAll(async () => {
  await rm(resolve(root, "readiness"), { recursive: true, force: true });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  delete process.env.FACTORY_DATA_DIR;
});

const DIGEST = `sha256:${"1".repeat(64)}`;

const review = (identity: "lead" | "challenger") => ({
  identity,
  provider: "openai" as const,
  model: "gpt-5.6-pro",
  evidenceDigest: DIGEST,
  decision: "ready" as const,
  purposeAligned: true,
  implementationComplete: true,
  technicallyReady: true,
  blockers: [],
});

function receipt() {
  return evaluateProductionReadiness({
    evidenceDigest: DIGEST,
    appName: "Ready App",
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
    reviews: [review("lead"), review("challenger")],
  });
}

describe("durable readiness state", () => {
  it("defaults legacy or new subjects to not evaluated and not ready", async () => {
    const id = randomUUID();
    const state = initialReadinessState("run", id);
    expect(state.status).toBe("not_evaluated");
    expect(state.receipt).toBeNull();
    await saveReadinessState(state);
    await expect(assertReadyReceipt(id)).rejects.toThrow(/not satisfied/);
  });

  it("persists an evaluating state before either brain decides", async () => {
    const id = randomUUID();
    await markReadinessEvaluating({
      subjectType: "run",
      subjectId: id,
      evidenceDigest: DIGEST,
    });
    const stored = await loadReadinessState(id);
    expect(stored).toMatchObject({
      status: "evaluating",
      evidenceDigest: DIGEST,
      ownerExternalMatters: "owner-managed-outside-cyberland",
    });
  });

  it("records and reloads the exact ready receipt", async () => {
    const id = randomUUID();
    const ready = receipt();
    await recordReadinessEvaluation({
      subjectType: "run",
      subjectId: id,
      evidenceDigest: DIGEST,
      reviews: [review("lead"), review("challenger")],
      receipt: ready,
    });
    expect((await assertReadyReceipt(id, DIGEST)).ready).toBe(true);
    await expect(assertReadyReceipt(id, "sha256:changed")).rejects.toThrow(/stale/);
  });

  it("refuses a forged ready status without a ready receipt", async () => {
    const id = randomUUID();
    await expect(
      saveReadinessState({
        ...initialReadinessState("run", id),
        status: "ready",
      }),
    ).rejects.toThrow(/ready receipt/);
  });

  it("refuses unsafe subject identifiers", () => {
    expect(() => initialReadinessState("foundry-project", "../escape")).toThrow(
      /invalid readiness subject id/,
    );
  });
});
