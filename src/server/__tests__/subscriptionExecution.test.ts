import { afterEach, expect, it, vi } from "vitest";
import { createTierProvider, selectRunRouting } from "../orchestrator/runFactory.js";
import { createProviderRegistry, type ProviderRegistry } from "../providers/index.js";
import { loadConfig, loadSecrets } from "../config.js";
import * as rotation from "../rotation/aitimeRotation.js";
import * as providers from "../rotation/rotatingProvider.js";
import { recursionGuardEnv, argvFor } from "../providers/cliProvider.js";
import type { LLMProvider } from "../../shared/types.js";
import type { RunOptions } from "../../shared/schemas.js";
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
it("preserves subscription fallthrough through the real production decorators", async () => {
  const sub = {
    name: "free",
    isConfigured: () => true,
    generateText: vi
      .fn()
      .mockRejectedValue(new rotation.RotationError("no frontier route available")),
    generateJson: vi.fn(),
  } as unknown as LLMProvider;
  const api = {
    name: "openai",
    paidBudgetManaged: true,
    isConfigured: () => true,
    generateText: vi.fn().mockResolvedValue({ text: "api", provider: "openai" }),
    generateJson: vi.fn(),
  } as unknown as LLMProvider;
  const registry = {
    automaticRungs: () => [
      {
        model: "subscription:owner",
        provider: sub,
        advanceOn: "subscription-unavailable",
      },
      { model: "api", provider: api },
    ],
  } as unknown as ProviderRegistry;
  const provider = createTierProvider(
    {
      routingMode: "auto",
      codeProvider: "openai",
      reviewProvider: "openai",
      ladder: ["openai", "free"],
    },
    "openai",
    registry,
  );
  expect((await provider.generateText({ system: "test", prompt: "test" })).text).toBe(
    "api",
  );
  expect(sub.generateText).toHaveBeenCalledTimes(1);
  expect(api.generateText).toHaveBeenCalledTimes(1);
});
function subscriptionCatalog(): rotation.Catalog {
  return new rotation.Catalog([
    {
      id: "cli/codex",
      backend: "codex-cli",
      backend_label: "Codex",
      model: "codex",
      wire_model: "codex",
      api: "codex-cli",
      base_url: "",
      pool: "codex:plan",
      auth_env: "",
      auth_kind: "none",
      cost_class: "subscription",
      tier: "frontier",
      enabled: true,
      disabled_reason: "",
      quota_status: "unknown",
      resets_at: null,
      note: "",
      capabilities: [],
      capabilities_source: "",
    },
  ]);
}
it("keeps subscriptions first when runtime filtering removes unconfigured API providers", () => {
  vi.spyOn(rotation, "buildRotator").mockReturnValue(
    new rotation.Rotator(subscriptionCatalog()),
  );
  vi.spyOn(providers, "filterRoutableCatalog").mockImplementation((r) => r);
  const config = loadConfig({});
  const registry = createProviderRegistry(config, loadSecrets({}));
  const routing = selectRunRouting({} as RunOptions, registry, config);
  expect(routing.ladder).toEqual(["free"]);
  expect(registry.automaticRungs!(routing.ladder)[0].model).toMatch(/^subscription:/);
});
it("does not reinterpret an explicitly configured free-only ladder", () => {
  vi.spyOn(rotation, "buildRotator").mockReturnValue(
    new rotation.Rotator(subscriptionCatalog()),
  );
  vi.spyOn(providers, "filterRoutableCatalog").mockImplementation((r) => r);
  const config = loadConfig({});
  config.modelLadder = ["free"];
  const registry = createProviderRegistry(config, loadSecrets({}));
  expect(registry.automaticRungs!(["free"])[0].model).not.toMatch(/^subscription:/);
});
it("strips mixed-case Windows credential names from the copied environment", () => {
  const original = {
    OpenAI_Api_Key: "test",
    aNtHrOpIc_ApI_KeY: "test",
    Claude_Code_Use_Bedrock: "1",
    KEEP_VALUE: "preserved",
  };
  const env = recursionGuardEnv("claude-code", original);
  expect(env.OpenAI_Api_Key).toBeUndefined();
  expect(env.aNtHrOpIc_ApI_KeY).toBeUndefined();
  expect(env.Claude_Code_Use_Bedrock).toBeUndefined();
  expect(env.KEEP_VALUE).toBe("preserved");
  expect(original.OpenAI_Api_Key).toBe("test");
});

it("owner-only enrollment never retains metered API rungs even when keys exist", () => {
  vi.stubEnv("FACTORY_OWNER_SUBSCRIPTION_ONLY", "1");
  vi.stubEnv("FACTORY_OWNER_CODEX_HOME", process.cwd() + "/fixture-subscription");
  vi.spyOn(rotation, "buildRotator").mockReturnValue(null);
  const config = loadConfig({});
  const secrets = loadSecrets({
    OPENAI_API_KEY: "fixture-only",
    ANTHROPIC_API_KEY: "fixture-only",
  });
  const registry = createProviderRegistry(config, secrets);
  expect(registry.availablePaid()).toEqual([]);
  expect(registry.automaticRungs!()[0].model).toBe("subscription:codex");
  expect(registry.get("openai").isConfigured()).toBe(false);
});
it("a Codex subscription route cannot silently accept API-key authentication", () => {
  const args = argvFor("codex-cli");
  expect(args).toContain("forced_login_method=chatgpt");
  expect(args).toContain("--ignore-user-config");
});
