import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import {
  MissingProviderCredentialError,
  type ProviderRegistry,
} from "../providers/index.js";
import {
  createTierProvider,
  RunNotResumableError,
  selectResumeRouting,
  selectRunRouting,
} from "../orchestrator/runFactory.js";
import type { ProviderName } from "../../shared/schemas.js";
import type { LLMProvider } from "../../shared/types.js";
import { resetPaidBudget } from "../providers/paidBudget.js";

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

function liveRegistry(providers: LLMProvider[]): ProviderRegistry {
  const byName = new Map(providers.map((provider) => [provider.name, provider]));
  const unavailable = (name: ProviderName) =>
    ({ name, isConfigured: () => false }) as LLMProvider;
  const get = (name: ProviderName) => byName.get(name) ?? unavailable(name);
  const configured = providers.map((provider) => provider.name);
  const paid = configured.filter(
    (name): name is "anthropic" | "openai" => name === "anthropic" || name === "openai",
  );
  return {
    get,
    resolve: (requested, fallback) => get(requested ?? fallback),
    resolveLive: (requested, fallback) => get(requested ?? fallback),
    available: () => configured,
    availableLive: () =>
      configured.filter((name) => name !== "mock" && name !== "stub"),
    availablePaid: () => paid,
    missingCredentialNames: () => [],
  };
}

function callable(
  name: ProviderName,
  behavior: () => Promise<{ text: string; provider: ProviderName }>,
): LLMProvider & { calls: number } {
  const provider = {
    name,
    calls: 0,
    isConfigured: () => true,
    async generateText() {
      provider.calls += 1;
      return behavior();
    },
    async generateJson<T>() {
      provider.calls += 1;
      const result = await behavior();
      return result as T;
    },
  };
  return provider as LLMProvider & { calls: number };
}

afterEach(() => {
  vi.unstubAllEnvs();
  resetPaidBudget();
});

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

  it("an explicit free tier wins over legacy paid provider fields", () => {
    expect(
      selectRunRouting(
        { routingMode: "free", codeProvider: "openai" },
        registry(true, ["openai"]),
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

  it("a failing free call never reaches a configured paid provider", async () => {
    const free = callable("free", async () => {
      throw new Error("429 no credits remaining");
    });
    const paid = callable("openai", async () => ({
      text: "paid",
      provider: "openai",
    }));
    const providers = liveRegistry([free, paid]);
    const routing = selectRunRouting({ routingMode: "free" }, providers, config);
    const selected = createTierProvider(routing, routing.codeProvider, providers);

    await expect(
      selected.generateText({ system: "test", prompt: "x" }),
    ).rejects.toThrow(/no credits/i);
    expect(free.calls).toBe(1);
    expect(paid.calls).toBe(0);
  });

  it("budget-gates a paid quota alternate before it can spend", async () => {
    vi.stubEnv("FACTORY_PAID_RESCUES_PER_DAY", "999");
    resetPaidBudget();
    const primary = callable("openai", async () => {
      process.env.FACTORY_PAID_RESCUES_PER_DAY = "0";
      throw new Error("insufficient_quota");
    });
    const alternate = callable("anthropic", async () => ({
      text: "paid alternate",
      provider: "anthropic",
    }));
    const providers = liveRegistry([primary, alternate]);
    const routing = selectRunRouting(
      { routingMode: "paid", codeProvider: "openai" },
      providers,
      config,
    );

    await expect(
      createTierProvider(routing, routing.codeProvider, providers).generateText({
        system: "test",
        prompt: "x",
      }),
    ).rejects.toThrow(/paid provider call refused/i);
    expect(primary.calls).toBe(1);
    expect(alternate.calls).toBe(0);
  });
});

describe("resume provider-tier switching", () => {
  it("switches a free run to a configured paid tier for both roles", () => {
    expect(
      selectResumeRouting(
        {
          routingMode: "free",
          codeProvider: "free",
          reviewProvider: "free",
        },
        { codeProvider: "openai" },
        registry(true, ["openai"]),
        config,
      ),
    ).toEqual({
      routingMode: "paid",
      codeProvider: "openai",
      reviewProvider: "openai",
    });
  });

  it("switches a paid run to free for both roles", () => {
    expect(
      selectResumeRouting(
        {
          routingMode: "paid",
          codeProvider: "openai",
          reviewProvider: "openai",
        },
        { reviewProvider: "free" },
        registry(true, ["openai"]),
        config,
      ),
    ).toEqual({
      routingMode: "free",
      codeProvider: "free",
      reviewProvider: "free",
    });
  });

  it("rejects a mixed-tier resume override", () => {
    expect(() =>
      selectResumeRouting(
        {
          routingMode: "free",
          codeProvider: "free",
          reviewProvider: "free",
        },
        { codeProvider: "free", reviewProvider: "openai" },
        registry(true, ["openai"]),
        config,
      ),
    ).toThrow(RunNotResumableError);
  });

  it("keeps a paid resume inside paid routes when the old key is removed", () => {
    expect(
      selectResumeRouting(
        {
          routingMode: "paid",
          codeProvider: "anthropic",
          reviewProvider: "anthropic",
        },
        undefined,
        registry(true, ["openai"]),
        config,
      ),
    ).toEqual({
      routingMode: "paid",
      codeProvider: "openai",
      reviewProvider: "openai",
    });
  });

  it("fails closed when a paid resume has no paid route left", () => {
    expect(() =>
      selectResumeRouting(
        {
          routingMode: "paid",
          codeProvider: "anthropic",
          reviewProvider: "anthropic",
        },
        undefined,
        registry(true, []),
        config,
      ),
    ).toThrow(MissingProviderCredentialError);
  });
});
