import { describe, expect, it } from "vitest";
import type { LLMProvider } from "../../shared/types.js";
import { loadConfig, loadSecrets, readinessBrainFloor, toHealth } from "../config.js";
import { createReadinessBrainProviders } from "../providers/readinessBrains.js";
import { QuotaFailoverProvider } from "../providers/quotaFailover.js";

const keys = {
  OPENAI_API_KEY: "openai-test-key",
  ANTHROPIC_API_KEY: "anthropic-test-key",
} as NodeJS.ProcessEnv;

function provider(
  name: LLMProvider["name"],
  model: string,
  outcome: "ok" | "exhausted",
): LLMProvider {
  return {
    name,
    isConfigured: () => true,
    currentProvider: () => name,
    currentModel: () => model,
    async generateText() {
      if (outcome === "exhausted") throw new Error("429 no credits remaining");
      return { text: "ok", provider: name };
    },
    async generateJson<T>() {
      if (outcome === "exhausted") throw new Error("429 no credits remaining");
      return { ok: true } as T;
    },
  };
}

describe("mandatory readiness brain configuration", () => {
  it("retains truthful paid-capacity diagnostics without making them admission gates", () => {
    const config = loadConfig({
      ...keys,
      FACTORY_SOL_MODEL: "gpt-5.6-pro",
      FACTORY_FABLE_OR_OPUS_MODEL: "claude-opus-4-8",
    });
    expect(readinessBrainFloor(config, loadSecrets(keys))).toMatchObject({
      configured: true,
      paidProviders: ["anthropic", "openai"],
      solConfigured: true,
      fableOrOpusConfigured: true,
    });

    const freeOnly = loadConfig({
      FACTORY_FREE_ENABLED: "1",
      FACTORY_FREE_BASE_URL: "http://127.0.0.1:8082",
    });
    expect(readinessBrainFloor(freeOnly, loadSecrets({})).configured).toBe(false);
  });

  it("exposes diagnostics without exposing keys", () => {
    const config = loadConfig({
      ...keys,
      FACTORY_SOL_MODEL: "gpt-5.6-pro",
      FACTORY_FABLE_OR_OPUS_MODEL: "claude-fable",
    });
    const health = toHealth(config, loadSecrets(keys));
    expect(health).toMatchObject({
      mandatoryProductionReadiness: true,
      readinessBrainFloorConfigured: true,
      readinessPaidProviders: ["anthropic", "openai"],
      solConfigured: true,
      fableOrOpusConfigured: true,
      solModel: "gpt-5.6-pro",
      fableOrOpusModel: "claude-fable",
      ownerExternalMatters: "owner-managed-outside-cyberland",
    });
    expect(JSON.stringify(health)).not.toContain("openai-test-key");
    expect(JSON.stringify(health)).not.toContain("anthropic-test-key");
  });

  it("constructs two independent reviewers that each descend paid to AI Time free", async () => {
    const built: LLMProvider[] = [];
    const pair = createReadinessBrainProviders(() => {
      const ladder = new QuotaFailoverProvider(
        provider("anthropic", "claude-fable-5-1", "exhausted"),
        [
          provider("openai", "gpt-5.5", "exhausted"),
          provider("free", "qwen2.5-coder:14b", "ok"),
        ],
      );
      built.push(ladder);
      return ladder;
    });

    expect(pair.lead.provider).not.toBe(pair.challenger.provider);
    expect(built).toHaveLength(2);
    await Promise.all([
      pair.lead.provider.generateJson({} as never),
      pair.challenger.provider.generateJson({} as never),
    ]);
    expect(pair.lead.currentProvider()).toBe("free");
    expect(pair.challenger.currentProvider()).toBe("free");
    expect(pair.lead.currentModel()).toBe("qwen2.5-coder:14b");
    expect(pair.challenger.currentModel()).toBe("qwen2.5-coder:14b");
  });

  it("accepts a free-only live route and still creates independent reviewers", () => {
    const pair = createReadinessBrainProviders(() =>
      provider("free", "qwen3:8b", "ok"),
    );
    expect(pair.lead.provider).not.toBe(pair.challenger.provider);
    expect(pair.lead.currentProvider()).toBe("free");
    expect(pair.challenger.currentProvider()).toBe("free");
  });
});
