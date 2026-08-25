import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import {
  MissingProviderCredentialError,
  type ProviderRegistry,
} from "../providers/index.js";
import { selectRunRouting } from "../orchestrator/runFactory.js";
import type { ProviderName } from "../../shared/schemas.js";
import type { LLMProvider } from "../../shared/types.js";

function registry(free: boolean, paid: ProviderName[]): ProviderRegistry {
  const configured = new Set<ProviderName>([
    ...(free ? (["free"] as ProviderName[]) : []),
    ...paid,
  ]);
  const get = (name: ProviderName) =>
    ({
      name,
      isConfigured: () => configured.has(name),
    }) as LLMProvider;
  return {
    get,
    resolve: (requested, fallback) => get(requested ?? fallback),
    resolveLive: (requested, fallback) => get(requested ?? fallback),
    available: () => [...configured],
    availableLive: () => [...configured],
    availablePaid: () => paid,
    missingCredentialNames: () => [],
  };
}

const config = loadConfig({
  FACTORY_FREE_ENABLED: "true",
  DEFAULT_CODE_PROVIDER: "free",
  DEFAULT_REVIEW_PROVIDER: "free",
});

const paidDefaultConfig = loadConfig({
  FACTORY_FREE_ENABLED: "false",
  DEFAULT_CODE_PROVIDER: "anthropic",
  DEFAULT_REVIEW_PROVIDER: "anthropic",
});

describe("provider-neutral run routing", () => {
  it("free mode remains free even when paid keys are available", () => {
    expect(
      selectRunRouting(
        { routingMode: "free" },
        registry(true, ["anthropic", "openai"]),
        config,
      ),
    ).toEqual({
      routingMode: "free",
      codeProvider: "free",
      reviewProvider: "free",
    });
  });

  it("paid mode chooses only configured paid routes", () => {
    expect(
      selectRunRouting({ routingMode: "paid" }, registry(true, ["openai"]), config),
    ).toEqual({
      routingMode: "paid",
      codeProvider: "openai",
      reviewProvider: "openai",
    });
  });

  it("legacy explicit paid provider requests still infer paid mode", () => {
    expect(
      selectRunRouting(
        { codeProvider: "openai", reviewProvider: "openai" },
        registry(true, ["openai"]),
        config,
      ).routingMode,
    ).toBe("paid");
  });

  it("legacy callers with paid defaults still infer paid mode", () => {
    expect(
      selectRunRouting({}, registry(false, ["anthropic"]), paidDefaultConfig),
    ).toEqual({
      routingMode: "paid",
      codeProvider: "anthropic",
      reviewProvider: "anthropic",
    });
  });

  it("paid routing rotates to another paid provider, never free", () => {
    expect(
      selectRunRouting(
        {
          routingMode: "paid",
          codeProvider: "anthropic",
          reviewProvider: "anthropic",
        },
        registry(true, ["openai"]),
        config,
      ),
    ).toEqual({
      routingMode: "paid",
      codeProvider: "openai",
      reviewProvider: "openai",
    });
  });

  it("paid mode fails closed when no paid route is configured", () => {
    expect(() =>
      selectRunRouting({ routingMode: "paid" }, registry(true, []), config),
    ).toThrow(MissingProviderCredentialError);
  });

  it("free mode fails closed when the free route is unavailable", () => {
    expect(() =>
      selectRunRouting({ routingMode: "free" }, registry(false, ["openai"]), config),
    ).toThrow(MissingProviderCredentialError);
  });
});
