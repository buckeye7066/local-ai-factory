import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import {
  MissingProviderCredentialError,
  type ProviderRegistry,
} from "../providers/index.js";
import {
  createTierProvider,
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
  const byName = new Map(
    providers.map((provider) => [provider.name, provider]),
  );
  const unavailable = (name: ProviderName) =>
    ({ name, isConfigured: () => false }) as LLMProvider;
  const get = (name: ProviderName) => byName.get(name) ?? unavailable(name);
  const configured = providers.map((provider) => provider.name);
  const paid = configured.filter(
    (name): name is "anthropic" | "openai" =>
      name === "anthropic" || name === "openai",
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
      return (await behavior()) as unknown as T;
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
  FACTORY_MODEL_LADDER: "anthropic,openai",
});

describe("one automatic model ladder", () => {
  it.each(["auto", "free", "paid"] as const)(
    "normalizes legacy %s input to paid-first execution with free last",
    (routingMode) => {
      expect(
        selectRunRouting(
          { routingMode },
          registry(true, ["anthropic", "openai"]),
          config,
        ),
      ).toEqual({
        routingMode: "auto",
        codeProvider: "anthropic",
        reviewProvider: "anthropic",
        ladder: ["anthropic", "openai", "free"],
      });
    },
  );

  it("honors configured paid order and skips unavailable rungs", () => {
    const openaiFirst = loadConfig({
      FACTORY_FREE_ENABLED: "true",
      FACTORY_MODEL_LADDER: "openai,anthropic",
    });
    expect(
      selectRunRouting(
        { codeProvider: "anthropic", reviewProvider: "free" },
        registry(true, ["openai"]),
        openaiFirst,
      ),
    ).toEqual({
      routingMode: "auto",
      codeProvider: "openai",
      reviewProvider: "openai",
      ladder: ["openai", "free"],
    });
  });

  it("uses free/local as the final usable rung when paid models are exhausted", () => {
    expect(selectRunRouting({}, registry(true, []), config)).toEqual({
      routingMode: "auto",
      codeProvider: "free",
      reviewProvider: "free",
      ladder: ["free"],
    });
  });

  it("fails loudly when no live rung is configured", () => {
    expect(() => selectRunRouting({}, registry(false, []), config)).toThrow(
      MissingProviderCredentialError,
    );
  });

  it("keeps quota demotion sticky across later calls in the same run", async () => {
    vi.stubEnv("FACTORY_PAID_RESCUES_PER_DAY", "999");
    const exhausted = Object.assign(new Error("rate limit exceeded"), {
      status: 429,
    });
    const anthropic = callable("anthropic", async () => {
      throw exhausted;
    });
    const openai = callable("openai", async () => ({
      text: "served",
      provider: "openai",
    }));
    const free = callable("free", async () => ({
      text: "free",
      provider: "free",
    }));
    const providers = liveRegistry([anthropic, openai, free]);
    const routing = selectRunRouting(
      { routingMode: "free" },
      providers,
      config,
    );
    const selected = createTierProvider(
      routing,
      routing.codeProvider,
      providers,
    );

    await expect(
      selected.generateText({ system: "test", prompt: "first" }),
    ).resolves.toMatchObject({ provider: "openai" });
    await expect(
      selected.generateText({ system: "test", prompt: "second" }),
    ).resolves.toMatchObject({ provider: "openai" });
    expect(anthropic.calls).toBe(1);
    expect(openai.calls).toBe(2);
    expect(free.calls).toBe(0);
  });

  it("demotes to free when the paid admission budget is exhausted", async () => {
    vi.stubEnv("FACTORY_PAID_RESCUES_PER_DAY", "0");
    resetPaidBudget();
    const paid = callable("openai", async () => ({
      text: "paid",
      provider: "openai",
    }));
    const free = callable("free", async () => ({
      text: "free",
      provider: "free",
    }));
    const providers = liveRegistry([paid, free]);
    const openaiFirst = loadConfig({
      FACTORY_FREE_ENABLED: "true",
      FACTORY_MODEL_LADDER: "openai",
    });
    const routing = selectRunRouting({}, providers, openaiFirst);

    await expect(
      createTierProvider(routing, routing.codeProvider, providers).generateText(
        {
          system: "test",
          prompt: "x",
        },
      ),
    ).resolves.toMatchObject({ provider: "free" });
    expect(paid.calls).toBe(0);
    expect(free.calls).toBe(1);
  });
});

describe("resume routing", () => {
  it("normalizes old tier switches onto the current configured ladder", () => {
    expect(
      selectResumeRouting(
        {
          routingMode: "free",
          codeProvider: "free",
          reviewProvider: "free",
        },
        { codeProvider: "free", reviewProvider: "openai" },
        registry(true, ["anthropic", "openai"]),
        config,
      ),
    ).toEqual({
      routingMode: "auto",
      codeProvider: "anthropic",
      reviewProvider: "anthropic",
      ladder: ["anthropic", "openai", "free"],
    });
  });

  it("rejects offline mock/stub overrides", () => {
    expect(() =>
      selectResumeRouting(
        {
          routingMode: "paid",
          codeProvider: "openai",
          reviewProvider: "openai",
        },
        { codeProvider: "mock" },
        registry(true, ["openai"]),
        config,
      ),
    ).toThrow(MissingProviderCredentialError);
  });
});
