import { afterEach, describe, expect, it, vi } from "vitest";
import { createProviderRegistry } from "../providers/index.js";
import { loadConfig, loadSecrets } from "../config.js";
import * as rotation from "../rotation/aitimeRotation.js";
import * as providers from "../rotation/rotatingProvider.js";
import { ModelLadderProvider } from "../providers/modelLadderProvider.js";
import { recursionGuardEnv } from "../providers/cliProvider.js";
import type { LLMProvider } from "../../shared/types.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
describe("owner subscription priority", () => {
  it("puts subscription capacity ahead of configured API keys", () => {
    const route = {
      id: "cli/codex",
      backend: "codex-cli",
      backend_label: "Codex",
      model: "codex",
      wire_model: "codex",
      api: "codex-cli" as const,
      base_url: "",
      pool: "codex:plan",
      auth_env: "",
      auth_kind: "none",
      cost_class: "subscription" as const,
      tier: "frontier" as const,
      enabled: true,
      disabled_reason: "",
      quota_status: "unknown",
      resets_at: null,
      note: "",
      capabilities: [],
      capabilities_source: "" as const,
    };
    vi.spyOn(rotation, "buildRotator").mockReturnValue(
      new rotation.Rotator(new rotation.Catalog([route])),
    );
    vi.spyOn(providers, "filterRoutableCatalog").mockImplementation((r) => r);
    const reg = createProviderRegistry(
      loadConfig({}),
      loadSecrets({
        ANTHROPIC_API_KEY: "test-anthropic",
        OPENAI_API_KEY: "test-openai",
      }),
    );
    expect(reg.automaticRungs!()[0].model).toMatch(/^subscription:/);
    expect(
      reg.automaticRungs!(["free"]).some((r) => r.provider.name === "anthropic"),
    ).toBe(false);
  });
  it("falls through subscription exhaustion but retries that tier on the next call", async () => {
    const subscription = {
      name: "free",
      isConfigured: () => true,
      generateText: vi
        .fn()
        .mockRejectedValueOnce(new rotation.RotationError("No subscription route"))
        .mockResolvedValue({ text: "subscription" }),
      generateJson: vi.fn(),
    } as unknown as LLMProvider;
    const api = {
      name: "openai",
      isConfigured: () => true,
      generateText: vi.fn().mockResolvedValue({ text: "api" }),
      generateJson: vi.fn(),
    } as unknown as LLMProvider;
    const ladder = new ModelLadderProvider([
      {
        model: "subscription:owner",
        provider: subscription,
        advanceOn: "subscription-unavailable",
      },
      { model: "api:model", provider: api },
    ]);
    expect((await ladder.generateText({ system: "test", prompt: "test" })).text).toBe(
      "api",
    );
    expect((await ladder.generateText({ system: "test", prompt: "test" })).text).toBe(
      "subscription",
    );
    expect(api.generateText).toHaveBeenCalledTimes(1);
  });
  it("isolates inherited API keys without deleting fallback credentials", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic");
    vi.stubEnv("OPENAI_API_KEY", "test-openai");
    vi.stubEnv("CODEX_API_KEY", "test-codex");
    for (const api of ["claude-code", "codex-cli"]) {
      const env = recursionGuardEnv(api);
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.CODEX_API_KEY).toBeUndefined();
    }
    expect(process.env.ANTHROPIC_API_KEY).toBe("test-anthropic");
    expect(process.env.OPENAI_API_KEY).toBe("test-openai");
  });
});
