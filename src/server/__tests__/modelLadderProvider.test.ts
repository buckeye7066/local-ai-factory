import { describe, expect, it } from "vitest";
import type { LLMProvider } from "../../shared/types.js";
import { productionReadinessAgent } from "../agents/productionReadinessAgent.js";
import { ModelLadderProvider } from "../providers/modelLadderProvider.js";

function fake(
  behavior: "ok" | "exhausted" | "badRequest",
): LLMProvider & { calls: number } {
  const provider = {
    name: "anthropic" as const,
    paidBudgetManaged: true,
    calls: 0,
    isConfigured: () => true,
    async generateText() {
      provider.calls += 1;
      if (behavior === "exhausted") {
        throw new Error("model does not exist or you do not have access");
      }
      if (behavior === "badRequest") throw new Error("400 invalid prompt shape");
      return { text: "ok", provider: "anthropic" as const };
    },
    async generateJson<T>() {
      provider.calls += 1;
      if (behavior === "exhausted") {
        throw new Error("model does not exist or you do not have access");
      }
      if (behavior === "badRequest") throw new Error("400 invalid prompt shape");
      return {
        decision: "ready",
        purposeAligned: true,
        implementationComplete: true,
        technicallyReady: true,
        blockers: [],
      } as T;
    },
  };
  return provider;
}

describe("ModelLadderProvider", () => {
  it("falls through same-family models once and stays on the working rung", async () => {
    const fable = fake("exhausted");
    const opus = fake("ok");
    const events: string[] = [];
    const provider = new ModelLadderProvider(
      [
        { model: "claude-fable-5-1", provider: fable },
        { model: "claude-opus-5", provider: opus },
      ],
      (from, to) => events.push(`${from}->${to}`),
    );

    await provider.generateText({} as never);
    await provider.generateText({} as never);

    expect(events).toEqual(["claude-fable-5-1->claude-opus-5"]);
    expect(fable.calls).toBe(1);
    expect(opus.calls).toBe(2);
    expect(provider.currentModel()).toBe("claude-opus-5");
  });

  it("keeps real bad requests loud instead of hiding them with fallback", async () => {
    const bad = fake("badRequest");
    const fallback = fake("ok");
    const provider = new ModelLadderProvider([
      { model: "claude-fable-5-1", provider: bad },
      { model: "claude-opus-5", provider: fallback },
    ]);

    await expect(provider.generateJson({} as never)).rejects.toThrow(
      /invalid prompt shape/,
    );
    expect(fallback.calls).toBe(0);
  });

  it("stamps the model and Fable/Opus identity that actually reviewed", async () => {
    const provider = new ModelLadderProvider([
      { model: "claude-fable-5-1", provider: fake("exhausted") },
      { model: "claude-opus-5", provider: fake("ok") },
    ]);
    const review = await productionReadinessAgent({
      provider,
      identity: () => (/fable/i.test(provider.currentModel()) ? "fable" : "opus"),
      model: () => provider.currentModel(),
      evidence: {
        evidenceDigest: `sha256:${"a".repeat(64)}`,
      } as never,
      phase: "pre-release",
    });

    expect(review).toMatchObject({
      identity: "opus",
      provider: "anthropic",
      model: "claude-opus-5",
      decision: "ready",
    });
  });
});
