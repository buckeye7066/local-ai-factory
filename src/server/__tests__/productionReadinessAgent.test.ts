import { describe, expect, it } from "vitest";
import type {
  GenerateJsonInput,
  GenerateTextInput,
  LLMProvider,
} from "../../shared/types.js";
import {
  independentProductionReadinessReviews,
  productionReadinessAgent,
} from "../agents/productionReadinessAgent.js";
import {
  completePreReleaseReadiness,
  finalizeProductionReadinessFromApproval,
  runWithPreReleaseApproval,
  type ProductionReadinessFacts,
} from "../orchestrator/completeProductionReadiness.js";

class ReviewProvider implements LLMProvider {
  readonly name: "openai" | "anthropic";
  readonly seen: Array<{ system: string; prompt: string }> = [];

  constructor(
    name: "openai" | "anthropic",
    private readonly response: unknown,
    private readonly barrier?: {
      arrivals: number;
      release: () => void;
      wait: Promise<void>;
    },
  ) {
    this.name = name;
  }

  isConfigured(): boolean {
    return true;
  }

  async generateText(_input: GenerateTextInput) {
    return { text: "unused", provider: this.name };
  }

  async generateJson<T>(input: GenerateJsonInput<T>): Promise<T> {
    this.seen.push({ system: input.system, prompt: input.prompt });
    if (this.barrier) {
      this.barrier.arrivals += 1;
      if (this.barrier.arrivals === 2) this.barrier.release();
      await this.barrier.wait;
    }
    return input.schema.parse(this.response);
  }
}

const facts: ProductionReadinessFacts = {
  appName: "Purpose App",
  purpose: {
    stated: true,
    grounded: true,
    goalsCovered: true,
    acceptanceCriteria: 2,
    acceptanceCriteriaExecuted: 2,
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
  ownerExternalNotes: ["Owner handles legal review outside cyberland."],
};

const readyResponse = {
  decision: "ready",
  purposeAligned: true,
  implementationComplete: true,
  technicallyReady: true,
  blockers: [],
};

describe("production readiness brain agents", () => {
  it("stamps brain identity, provider family, model, and digest outside model control", async () => {
    const provider = new ReviewProvider("openai", readyResponse);
    const review = await productionReadinessAgent({
      provider,
      identity: "sol",
      model: "gpt-5.6-pro",
      evidence: { ...facts, evidenceDigest: "sha256:exact" },
    });
    expect(review).toMatchObject({
      identity: "sol",
      provider: "openai",
      model: "gpt-5.6-pro",
      evidenceDigest: "sha256:exact",
      decision: "ready",
    });
  });

  it("rejects a provider-family disguise before making a model call", async () => {
    const wrong = new ReviewProvider("openai", readyResponse);
    await expect(
      productionReadinessAgent({
        provider: wrong,
        identity: "opus",
        model: "claude-opus-4-8",
        evidence: { ...facts, evidenceDigest: "sha256:exact" },
      }),
    ).rejects.toThrow(/requires anthropic/);
    expect(wrong.seen).toHaveLength(0);
  });

  it("normalizes contradictory READY prose into not_ready", async () => {
    const provider = new ReviewProvider("anthropic", {
      ...readyResponse,
      blockers: [{ category: "verification", detail: "One test never ran." }],
    });
    const review = await productionReadinessAgent({
      provider,
      identity: "opus",
      model: "claude-opus-4-8",
      evidence: { ...facts, evidenceDigest: "sha256:exact" },
    });
    expect(review.decision).toBe("not_ready");
  });

  it("starts both independent reviews before either verdict is released", async () => {
    let release!: () => void;
    const barrier = {
      arrivals: 0,
      release: () => release(),
      wait: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    const sol = new ReviewProvider("openai", readyResponse, barrier);
    const opus = new ReviewProvider("anthropic", readyResponse, barrier);
    const reviews = await independentProductionReadinessReviews({
      solProvider: sol,
      solModel: "gpt-5.6-pro",
      secondProvider: opus,
      secondIdentity: "opus",
      secondModel: "claude-opus-4-8",
      evidence: { ...facts, evidenceDigest: "sha256:exact" },
    });
    expect(barrier.arrivals).toBe(2);
    expect(reviews.map((review) => review.identity)).toEqual(["sol", "opus"]);
    expect(sol.seen[0].prompt).not.toMatch(/opus.*decision|anthropic.*decision/i);
    expect(opus.seen[0].prompt).not.toMatch(/sol.*decision|openai.*decision/i);
  });

  it("excludes owner-handled legal matters from the reviewer's blocker mandate", async () => {
    const provider = new ReviewProvider("openai", readyResponse);
    await productionReadinessAgent({
      provider,
      identity: "sol",
      model: "gpt-5.6-pro",
      evidence: { ...facts, evidenceDigest: "sha256:exact" },
    });
    expect(provider.seen[0].system).toMatch(/Do not evaluate or invent legal/);
    expect(provider.seen[0].system).toMatch(/privacy leaks.*technical blockers/i);
  });

  it("runs both semantic decisions before side effects and never calls the effect on rejection or call failure", async () => {
    const rejection = await completePreReleaseReadiness({
      facts,
      solProvider: new ReviewProvider("openai", {
        ...readyResponse,
        decision: "not_ready",
        technicallyReady: false,
        blockers: [{ category: "verification", detail: "One flow is incomplete." }],
      }),
      solModel: "gpt-5.6-pro",
      secondProvider: new ReviewProvider("anthropic", readyResponse),
      secondIdentity: "opus",
      secondModel: "claude-opus-4-8",
    });
    expect(rejection.approved).toBe(false);
    const sideEffects = { deliver: 0, release: 0, deploy: 0 };
    for (const name of ["deliver", "release", "deploy"] as const) {
      const rejectedBoundary = await runWithPreReleaseApproval(
        rejection,
        facts,
        async () => ++sideEffects[name],
      );
      expect(rejectedBoundary.executed, name).toBe(false);
    }
    expect(sideEffects).toEqual({ deliver: 0, release: 0, deploy: 0 });

    const failed = await completePreReleaseReadiness({
      facts,
      solProvider: new ReviewProvider("openai", { invalid: true }),
      solModel: "gpt-5.6-pro",
      secondProvider: new ReviewProvider("anthropic", readyResponse),
      secondIdentity: "opus",
      secondModel: "claude-opus-4-8",
    });
    expect(failed.approved).toBe(false);
    for (const name of ["deliver", "release", "deploy"] as const) {
      const failedBoundary = await runWithPreReleaseApproval(
        failed,
        facts,
        async () => ++sideEffects[name],
      );
      expect(failedBoundary.executed, name).toBe(false);
    }
    expect(sideEffects).toEqual({ deliver: 0, release: 0, deploy: 0 });
  });

  it("never reuses approval after candidate bytes change and finalizes actual delivery separately", async () => {
    const sol = new ReviewProvider("openai", readyResponse);
    const opus = new ReviewProvider("anthropic", readyResponse);
    const approval = await completePreReleaseReadiness({
      facts,
      solProvider: sol,
      solModel: "gpt-5.6-pro",
      secondProvider: opus,
      secondIdentity: "opus",
      secondModel: "claude-opus-4-8",
    });
    expect(approval.approved).toBe(true);
    expect(sol.seen[0].system).toMatch(/PRE-RELEASE CANDIDATE/);
    expect(sol.seen[0].system).toMatch(/delivery fields are truthfully false/);

    const final = finalizeProductionReadinessFromApproval(facts, approval);
    expect(final.receipt.ready).toBe(true);
    expect(final.evidence.delivery.delivered).toBe(true);
    expect(final.reviews[0]!.evidenceDigest).toBe(approval.evidenceDigest);
    expect(final.receipt.evidenceDigest).not.toBe(approval.evidenceDigest);

    const changed: ProductionReadinessFacts = {
      ...facts,
      technical: {
        ...facts.technical,
        artifactDigest: `sha256:${"b".repeat(64)}`,
      },
    };
    const sideEffects = { deliver: 0, release: 0, deploy: 0 };
    for (const name of ["deliver", "release", "deploy"] as const) {
      const stale = await runWithPreReleaseApproval(
        approval,
        changed,
        async () => ++sideEffects[name],
      );
      expect(stale.executed, name).toBe(false);
      expect(stale.blockers.join(" "), name).toMatch(/stale/);
    }
    expect(sideEffects).toEqual({ deliver: 0, release: 0, deploy: 0 });
    expect(
      finalizeProductionReadinessFromApproval(changed, approval).receipt.ready,
    ).toBe(false);
  });
});
