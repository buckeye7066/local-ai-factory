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

const review = (identity: "sol" | "opus") => ({
  identity,
  provider: identity === "sol" ? ("openai" as const) : ("anthropic" as const),
  model: identity === "sol" ? "gpt-5.6-pro" : "claude-opus-4-8",
  evidenceDigest: "sha256:one",
  decision: "ready" as const,
  purposeAligned: true,
  implementationComplete: true,
  technicallyReady: true,
  blockers: [],
});

function receipt() {
  return evaluateProductionReadiness({
    evidenceDigest: "sha256:one",
    appName: "Ready App",
    purpose: {
      stated: true,
      grounded: true,
      goalsCovered: true,
      acceptanceCriteria: 1,
      acceptanceCriteriaExecuted: 1,
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
      kind: "workspace-only",
      delivered: true,
      releasedToTrunk: false,
      liveVerified: false,
      localArtifactVerified: true,
    },
    reviews: [review("sol"), review("opus")],
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
      evidenceDigest: "sha256:one",
    });
    const stored = await loadReadinessState(id);
    expect(stored).toMatchObject({
      status: "evaluating",
      evidenceDigest: "sha256:one",
      ownerExternalMatters: "owner-managed-outside-cyberland",
    });
  });

  it("records and reloads the exact ready receipt", async () => {
    const id = randomUUID();
    const ready = receipt();
    await recordReadinessEvaluation({
      subjectType: "run",
      subjectId: id,
      evidenceDigest: "sha256:one",
      reviews: [review("sol"), review("opus")],
      receipt: ready,
    });
    expect((await assertReadyReceipt(id, "sha256:one")).ready).toBe(true);
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
