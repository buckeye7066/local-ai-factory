import { describe, expect, it } from "vitest";
import { loadConfig, loadSecrets, readinessBrainFloor, toHealth } from "../config.js";
import { createReadinessBrainProviders } from "../providers/readinessBrains.js";

const keys = {
  OPENAI_API_KEY: "openai-test-key",
  ANTHROPIC_API_KEY: "anthropic-test-key",
} as NodeJS.ProcessEnv;

describe("mandatory readiness brain configuration", () => {
  it("admits the configured paid ladder without imposing a provider-family split", () => {
    const config = loadConfig({
      ...keys,
      FACTORY_SOL_MODEL: "gpt-5.6-pro",
      FACTORY_FABLE_OR_OPUS_MODEL: "claude-opus-4-8",
    });
    const secrets = loadSecrets(keys);
    expect(readinessBrainFloor(config, secrets)).toMatchObject({
      configured: true,
      paidProviders: ["anthropic", "openai"],
      solConfigured: true,
      fableOrOpusConfigured: true,
    });

    const openaiOnly = loadConfig({
      OPENAI_API_KEY: "openai-test-key",
      FACTORY_MODEL_LADDER: "openai",
    });
    expect(
      readinessBrainFloor(
        openaiOnly,
        loadSecrets({
          OPENAI_API_KEY: "openai-test-key",
        }),
      ),
    ).toMatchObject({
      configured: true,
      paidProviders: ["openai"],
    });
  });

  it("retains truthful legacy Fable/Opus diagnostics without gating the route", () => {
    const config = loadConfig({
      ...keys,
      FACTORY_SOL_MODEL: "gpt-5.6-pro",
      FACTORY_FABLE_OR_OPUS_MODEL: "claude-haiku",
    });

    expect(readinessBrainFloor(config, loadSecrets(keys))).toMatchObject({
      configured: true,
      fableOrOpusModels: ["claude-fable-5-1", "claude-opus-5"],
    });
  });

  it("does not let the free route substitute for either readiness brain", () => {
    const config = loadConfig({
      FACTORY_FREE_ENABLED: "1",
      FACTORY_FREE_BASE_URL: "http://127.0.0.1:8082",
    });
    const secrets = loadSecrets({});
    expect(readinessBrainFloor(config, secrets).configured).toBe(false);
    expect(() => createReadinessBrainProviders(config, secrets)).toThrow(
      /configured paid model/i,
    );
  });

  it("exposes readiness availability and model identities without exposing keys", () => {
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

  it("constructs two independent reviewers over the same paid model order", () => {
    const config = loadConfig({
      ...keys,
      FACTORY_SOL_MODEL: "gpt-5.6-pro",
      FACTORY_FABLE_OR_OPUS_MODEL: "claude-opus-4-8",
      FACTORY_MODEL_LADDER: "openai,anthropic",
    });
    const pair = createReadinessBrainProviders(config, loadSecrets(keys));
    expect(pair.lead.provider.name).toBe("openai");
    expect(pair.challenger.provider.name).toBe("openai");
    expect(pair.lead.provider).not.toBe(pair.challenger.provider);
    expect(pair.lead.currentProvider()).toBe("openai");
    expect(pair.challenger.currentProvider()).toBe("openai");
    expect(pair.lead.currentModel()).toBe("gpt-5.6-pro");
    expect(pair.challenger.currentModel()).toBe("gpt-5.6-pro");
  });
});
