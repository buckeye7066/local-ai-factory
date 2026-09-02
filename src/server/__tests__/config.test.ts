import { describe, it, expect } from "vitest";
import {
  loadConfig,
  loadSecrets,
  toHealth,
  isAnthropicConfigured,
  isOpenAiConfigured,
} from "../config.js";

describe("config", () => {
  it("loads defaults when env is empty", () => {
    const cfg = loadConfig({});
    expect(cfg.anthropicModel).toBe("claude-opus-4-8");
    expect(cfg.openaiModel).toBe("gpt-5.5");
    expect(cfg.maxRepairLoops).toBe(3);
    expect(cfg.maxModelCallsPerRun).toBe(30);
    // Untrusted project code is not executed on the host by default. Owners
    // may opt in only when Factory Deck itself runs in a container/VM.
    expect(cfg.allowUntrustedScripts).toBe(false);
    expect("dryRunCommands" in cfg).toBe(false);
  });

  it("parses numbers and booleans from env", () => {
    const cfg = loadConfig({
      MAX_REPAIR_LOOPS: "5",
      ALLOW_UNTRUSTED_SCRIPTS: "1",
    });
    expect(cfg.maxRepairLoops).toBe(5);
    expect(cfg.allowUntrustedScripts).toBe(true);
  });

  it("detects configured keys", () => {
    const secrets = loadSecrets({
      ANTHROPIC_API_KEY: "sk-abc",
      OPENAI_API_KEY: "",
    });
    expect(isAnthropicConfigured(secrets)).toBe(true);
    expect(isOpenAiConfigured(secrets)).toBe(false);
  });

  it("exposes only configured rungs in paid-first order", () => {
    const cfg = loadConfig({
      FACTORY_FREE_ENABLED: "true",
      FACTORY_MODEL_LADDER: "anthropic,openai",
    });
    expect(
      toHealth(cfg, loadSecrets({ ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "sk-openai" }))
        .modelLadder,
    ).toEqual(["openai", "free"]);
    expect(
      toHealth(loadConfig({ FACTORY_FREE_ENABLED: "false" }), loadSecrets({}))
        .modelLadder,
    ).toEqual([]);
  });

  it("NEVER leaks key values through the health view", () => {
    const cfg = loadConfig({});
    const secrets = loadSecrets({
      ANTHROPIC_API_KEY: "sk-super-secret-123",
      OPENAI_API_KEY: "sk-other-secret-456",
    });
    const health = toHealth(cfg, secrets);
    const serialized = JSON.stringify(health);
    expect(serialized).not.toContain("sk-super-secret-123");
    expect(serialized).not.toContain("sk-other-secret-456");
    // Only booleans are exposed.
    expect(health.anthropicConfigured).toBe(true);
    expect(health.openaiConfigured).toBe(true);
    expect(health.controlPlaneOk).toBe(true);
    expect(health.mockConfigured).toBe(true);
  });
});
