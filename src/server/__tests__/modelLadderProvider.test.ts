import { describe, expect, it } from "vitest";
import type { LLMProvider } from "../../shared/types.js";
import {
  independentProductionReadinessReviews,
  productionReadinessAgent,
} from "../agents/productionReadinessAgent.js";
import { ModelLadderProvider } from "../providers/modelLadderProvider.js";
import { ProviderModelUnavailableError, withRetry } from "../providers/types.js";

function fake(
  behavior: "ok" | "exhausted" | "badRequest",
  name: "anthropic" | "openai" = "anthropic",
  exhaustionMessage = "model does not exist or you do not have access",
  actualModel?: string,
): LLMProvider & { calls: number } {
  const provider = {
    name,
    paidBudgetManaged: true,
    calls: 0,
    isConfigured: () => true,
    currentModel: actualModel ? () => actualModel : undefined,
    async generateText() {
      provider.calls += 1;
      if (behavior === "exhausted") {
        throw new Error(exhaustionMessage);
      }
      if (behavior === "badRequest") throw new Error("400 invalid prompt shape");
      return { text: "ok", provider: name };
    },
    async generateJson<T>() {
      provider.calls += 1;
      if (behavior === "exhausted") {
        throw new Error(exhaustionMessage);
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

  it("reports the final exhausted rung instead of hiding it behind the first error", async () => {
    const provider = new ModelLadderProvider([
      { model: "claude-fable-5-1", provider: fake("exhausted") },
      {
        model: "gpt-5.5",
        provider: fake("exhausted", "openai", "quota exceeded on OpenAI credits"),
      },
    ]);

    await expect(provider.generateText({} as never)).rejects.toThrow(
      /quota exceeded on OpenAI credits/,
    );
  });

  it("skips the rest of one paid family after an account-wide credit refusal", async () => {
    const noCredits = fake(
      "exhausted",
      "anthropic",
      "429 You have no credits remaining.",
    );
    const redundantAnthropic = fake("ok", "anthropic");
    const openai = fake("ok", "openai");
    const provider = new ModelLadderProvider([
      { model: "claude-fable-5-1", provider: noCredits },
      { model: "claude-opus-5", provider: redundantAnthropic },
      { model: "gpt-5.6-sol", provider: openai },
    ]);

    await provider.generateText({} as never);

    expect(noCredits.calls).toBe(1);
    expect(redundantAnthropic.calls).toBe(0);
    expect(openai.calls).toBe(1);
    expect(provider.currentProvider()).toBe("openai");
  });

  it("crosses provider families when catalog suppression passes through retry", async () => {
    let blockedCalls = 0;
    const blocked = {
      name: "anthropic" as const,
      paidBudgetManaged: true,
      isConfigured: () => true,
      async generateText() {
        blockedCalls += 1;
        return withRetry("anthropic.generateText", async () => {
          throw new ProviderModelUnavailableError(
            "anthropic model unavailable: suppressed unverified model probe",
          );
        });
      },
      async generateJson<T>() {
        throw new Error("unused") as T;
      },
    } satisfies LLMProvider;
    const openai = fake("ok", "openai");
    const provider = new ModelLadderProvider([
      { model: "claude-opus-5", provider: blocked },
      { model: "gpt-6-astra", provider: openai },
    ]);

    await provider.generateText({} as never);

    expect(blockedCalls).toBe(1);
    expect(openai.calls).toBe(1);
    expect(provider.currentProvider()).toBe("openai");
  });

  it("reports the catalog-resolved model from the active provider", async () => {
    const resolved = fake("ok", "openai", undefined, "gpt-6-astra");
    const provider = new ModelLadderProvider([
      { model: "gpt-configured-alias", provider: resolved },
    ]);

    await provider.generateText({} as never);

    expect(provider.currentModel()).toBe("gpt-6-astra");
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

  it("stamps the actual paid provider and model after cross-family fallback", async () => {
    const provider = new ModelLadderProvider([
      { model: "claude-fable-5-1", provider: fake("exhausted") },
      { model: "gpt-5.5", provider: fake("ok", "openai") },
    ]);
    const review = await productionReadinessAgent({
      provider,
      identity: "challenger",
      providerName: () => provider.currentProvider() as "anthropic" | "openai",
      model: () => provider.currentModel(),
      evidence: {
        evidenceDigest: `sha256:${"a".repeat(64)}`,
      } as never,
      phase: "pre-release",
    });

    expect(review).toMatchObject({
      identity: "challenger",
      provider: "openai",
      model: "gpt-5.5",
      decision: "ready",
    });
  });

  it("executes lead and challenger separately even when both land on OpenAI", async () => {
    const lead = fake("ok", "openai");
    const challenger = fake("ok", "openai");
    const reviews = await independentProductionReadinessReviews({
      leadProvider: lead,
      leadProviderName: "openai",
      leadModel: "gpt-5.5",
      challengerProvider: challenger,
      challengerProviderName: "openai",
      challengerModel: "gpt-5.5",
      evidence: {
        evidenceDigest: `sha256:${"b".repeat(64)}`,
      } as never,
      phase: "pre-release",
    });

    expect(lead.calls).toBe(1);
    expect(challenger.calls).toBe(1);
    expect(reviews.map((review) => review.identity)).toEqual(["lead", "challenger"]);
  });
});
