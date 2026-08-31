import { describe, expect, it } from "vitest";
import { loadConfig, loadSecrets, readinessBrainFloor, toHealth } from "../config.js";
import { createReadinessBrainProviders } from "../providers/readinessBrains.js";

const keys = {
  OPENAI_API_KEY: "openai-test-key",
  ANTHROPIC_API_KEY: "anthropic-test-key",
} as NodeJS.ProcessEnv;

describe("mandatory readiness brain configuration", () => {
  it("requires both provider families and an Anthropic Fable/Opus-class model", () => {
    const config = loadConfig({
      ...keys,
      FACTORY_SOL_MODEL: "gpt-5.6-pro",
      FACTORY_FABLE_OR_OPUS_MODEL: "claude-opus-4-8",
    });
    const secrets = loadSecrets(keys);
    expect(readinessBrainFloor(config, secrets)).toMatchObject({
      configured: true,
      solConfigured: true,
      fableOrOpusConfigured: true,
    });

    const weak = loadConfig({
      ...keys,
      FACTORY_SOL_MODEL: "gpt-5.6-pro",
      FACTORY_FABLE_OR_OPUS_MODEL: "claude-haiku",
    });
    expect(readinessBrainFloor(weak, secrets).configured).toBe(false);
  });

  it("does not let the free route substitute for either readiness brain", () => {
    const config = loadConfig({
      FACTORY_FREE_ENABLED: "1",
      FACTORY_FREE_BASE_URL: "http://127.0.0.1:8082",
    });
    const secrets = loadSecrets({});
    expect(readinessBrainFloor(config, secrets).configured).toBe(false);
    expect(() => createReadinessBrainProviders(config, secrets)).toThrow(
      /OPENAI_API_KEY|ANTHROPIC_API_KEY/,
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
      solConfigured: true,
      fableOrOpusConfigured: true,
      solModel: "gpt-5.6-pro",
      fableOrOpusModel: "claude-fable",
      ownerExternalMatters: "owner-managed-outside-cyberland",
    });
    expect(JSON.stringify(health)).not.toContain("openai-test-key");
    expect(JSON.stringify(health)).not.toContain("anthropic-test-key");
  });

  it("constructs dedicated provider instances with no cross-family fallback", () => {
    const config = loadConfig({
      ...keys,
      FACTORY_SOL_MODEL: "gpt-5.6-pro",
      FACTORY_FABLE_OR_OPUS_MODEL: "claude-opus-4-8",
    });
    const pair = createReadinessBrainProviders(config, loadSecrets(keys));
    expect(pair.sol.name).toBe("openai");
    expect(pair.second.name).toBe("anthropic");
    expect(pair.secondIdentity).toBe("opus");
    expect(pair.solModel).toBe("gpt-5.6-pro");
    expect(pair.secondModel).toBe("claude-opus-4-8");
  });
});
