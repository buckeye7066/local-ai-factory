import { describe, it, expect } from "vitest";
import { createProviderRegistry } from "../providers/index.js";
import { loadConfig, loadSecrets } from "../config.js";
import { StubProvider } from "../providers/stubProvider.js";
import { ProductSpecSchema } from "../../shared/schemas.js";

const cfg = loadConfig({});

describe("provider registry selection", () => {
  it("falls back to stub when no keys are configured", () => {
    const reg = createProviderRegistry(cfg, loadSecrets({}));
    expect(reg.available()).toEqual(["stub"]);
    expect(reg.resolve("anthropic", "anthropic").name).toBe("stub");
  });

  it("resolves to the requested provider when its key exists", () => {
    const reg = createProviderRegistry(
      cfg,
      loadSecrets({ ANTHROPIC_API_KEY: "sk-a", OPENAI_API_KEY: "sk-o" }),
    );
    expect(reg.resolve("anthropic", "openai").name).toBe("anthropic");
    expect(reg.resolve("openai", "anthropic").name).toBe("openai");
    expect(reg.available().sort()).toEqual(["anthropic", "openai", "stub"]);
  });

  it("falls back past an unconfigured requested provider", () => {
    const reg = createProviderRegistry(cfg, loadSecrets({ OPENAI_API_KEY: "sk-o" }));
    // Anthropic requested but missing → should land on openai (configured) or stub.
    expect(reg.resolve("anthropic", "openai").name).toBe("openai");
  });
});

describe("stub provider", () => {
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
