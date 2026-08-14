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
    // Real execution is the default — dry-run was removed entirely
    // (owner order 2026-08-13). The config has NO dry-run field at all.
    expect(cfg.allowUntrustedScripts).toBe(true);
    expect("dryRunCommands" in cfg).toBe(false);
  });

  it("parses numbers and booleans from env", () => {
    const cfg = loadConfig({ MAX_REPAIR_LOOPS: "5", ALLOW_UNTRUSTED_SCRIPTS: "0" });
    expect(cfg.maxRepairLoops).toBe(5);
    expect(cfg.allowUntrustedScripts).toBe(false);
  });

  it("detects configured keys", () => {
    const secrets = loadSecrets({ ANTHROPIC_API_KEY: "sk-abc", OPENAI_API_KEY: "" });
    expect(isAnthropicConfigured(secrets)).toBe(true);
    expect(isOpenAiConfigured(secrets)).toBe(false);
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
