import { describe, it, expect } from "vitest";
import { createProviderRegistry } from "../providers/index.js";
import { loadConfig, loadSecrets } from "../config.js";
import { StubProvider } from "../providers/stubProvider.js";
import { MockProvider } from "../providers/mockProvider.js";
import { ProductSpecSchema } from "../../shared/schemas.js";

const cfg = loadConfig({});
/** A deck with the free route switched off — the only truly provider-less case. */
const noFreeCfg = loadConfig({
  FACTORY_FREE_ENABLED: "0",
} as NodeJS.ProcessEnv);

describe("provider registry selection", () => {
  it("offers the FREE route even with no paid keys at all", () => {
    // The old contract here was "no paid key means no live provider". That is
    // now wrong by design: the free route is a real live provider that happens
    // to cost nothing, so a deck with no credit card still builds software.
    const reg = createProviderRegistry(cfg, loadSecrets({}));
    expect(reg.available().sort()).toEqual(["free", "mock", "stub"]);
    expect(reg.availableLive()).toEqual(["free"]);
    expect(reg.resolveLive(undefined, "free").name).toBe("free");
  });

  it("soft resolve may fall back to mock only when nothing live exists", () => {
    const reg = createProviderRegistry(noFreeCfg, loadSecrets({}));
    expect(reg.available().sort()).toEqual(["mock", "stub"]);
    expect(reg.resolve("anthropic", "anthropic").name).toBe("mock");
  });

  it("resolveLive fails closed when there is NO live provider at all", () => {
    // Fail-closed still holds; it just now requires the free route to be off
    // AND no paid key, rather than merely no paid key.
    const reg = createProviderRegistry(noFreeCfg, loadSecrets({}));
    expect(() => reg.resolveLive("anthropic", "anthropic")).toThrow(
      /ANTHROPIC_API_KEY/,
    );
  });

  it("exposes one exact paid-model ladder with AI Time free as the final rung", () => {
    const configured = loadConfig({
      FACTORY_FREE_ENABLED: "1",
      FACTORY_ANTHROPIC_MODEL_LADDER: "claude-fable-5-1,claude-opus-5,claude-sonnet-5",
      FACTORY_OPENAI_MODEL_LADDER: "gpt-5.6-pro,gpt-5.5",
      FACTORY_MODEL_LADDER: "anthropic,openai",
    });
    const reg = createProviderRegistry(
      configured,
      loadSecrets({ ANTHROPIC_API_KEY: "sk-a", OPENAI_API_KEY: "sk-o" }),
    );
    const exactRungs = reg.automaticRungs!();
    const rungs = exactRungs.map(
      (rung) => `${rung.provider.name}:${rung.model}`,
    );
    expect(rungs.slice(0, -1)).toEqual([
      "anthropic:claude-fable-5-1",
      "anthropic:claude-opus-5",
      "anthropic:claude-sonnet-5",
      "openai:gpt-5.6-pro",
      "openai:gpt-5.5",
    ]);
    expect(rungs.at(-1)).toMatch(/^free:(aitime:best-free|fcc:)/);
    expect(
      exactRungs.find((rung) => rung.model === "claude-opus-5")?.advanceOn,
    ).toBe("credit-or-unavailable");
  });

  it("keeps the legacy free-route diagnostic resolver separate from production", () => {
    const reg = createProviderRegistry(
      cfg,
      loadSecrets({ ANTHROPIC_API_KEY: "sk-a", OPENAI_API_KEY: "sk-o" }),
    );
    // This resolver is retained for the explicit free-route diagnostic only.
    expect(reg.resolveLive(undefined, "free").name).toBe("free");
    expect(reg.availableLive().sort()).toEqual(["anthropic", "free", "openai"]);
    expect(reg.available().sort()).toEqual([
      "anthropic",
      "free",
      "mock",
      "openai",
      "stub",
    ]);
  });

  it("honours an explicit paid pin, so a rescue tier can still be forced", () => {
    const reg = createProviderRegistry(
      cfg,
      loadSecrets({ ANTHROPIC_API_KEY: "sk-a", OPENAI_API_KEY: "sk-o" }),
    );
    expect(reg.resolveLive("anthropic", "free").name).toBe("anthropic");
    expect(reg.resolveLive("openai", "free").name).toBe("openai");
  });

  it("falls back past an unconfigured requested provider", () => {
    const reg = createProviderRegistry(
      noFreeCfg,
      loadSecrets({ OPENAI_API_KEY: "sk-o" }),
    );
    // Anthropic requested but missing → should land on openai (configured).
    expect(reg.resolve("anthropic", "openai").name).toBe("openai");
  });
});

describe("stub provider (legacy)", () => {
  it("returns schema-valid product specs offline", async () => {
    const stub = new StubProvider();
    const spec = await stub.generateJson({
      system: "x",
      prompt: "Build a Bible reading habit tracker",
      schema: ProductSpecSchema,
      schemaName: "ProductSpec",
    });
    expect(spec.appName).toBe("VerseKeeper");
    expect(spec.coreFeatures.length).toBeGreaterThan(0);
  });

  it("emits exactly one QA failure then passes (drives one repair loop)", async () => {
    const stub = new StubProvider();
    const { QaReportSchema } = await import("../../shared/schemas.js");
    const first = await stub.generateJson({
      system: "x",
      prompt: "demo",
      schema: QaReportSchema,
      schemaName: "QaReport",
    });
    const second = await stub.generateJson({
      system: "x",
      prompt: "demo",
      schema: QaReportSchema,
      schemaName: "QaReport",
    });
    expect(first.passed).toBe(false);
    expect(first.issues.length).toBe(1);
    expect(second.passed).toBe(true);
  });
});

describe("mock provider", () => {
  it("is a first-class offline provider named mock", async () => {
    const mock = new MockProvider();
    expect(mock.name).toBe("mock");
    expect(mock.isConfigured()).toBe(true);
  });
});
