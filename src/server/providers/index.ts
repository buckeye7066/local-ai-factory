import type { AppConfig, AppSecrets } from "../config.js";
import type { LLMProvider } from "../../shared/types.js";
import type { ProviderName } from "../../shared/schemas.js";
import { AnthropicProvider } from "./anthropicProvider.js";
import { OpenAIProvider } from "./openaiProvider.js";
import { StubProvider } from "./stubProvider.js";
import { MockProvider } from "./mockProvider.js";
import { FreeProvider } from "./freeProvider.js";
import { FailoverProvider, type RouteLogger } from "./failoverProvider.js";
import { recordPaidCall } from "./paidBudget.js";

export { AnthropicProvider, OpenAIProvider, StubProvider, MockProvider, FreeProvider };
export { FailoverProvider };

/**
 * Offline providers — deterministic fakes that never satisfy the live
 * purpose-contract journey.
 *
 * NOTE that "free" is deliberately NOT in this set. The free route runs real
 * models through the local FCC proxy; it really builds software, it just costs
 * nothing. Treating it as offline would be the same mistake as treating paid
 * as the only real tier.
 */
export const OFFLINE_PROVIDERS = new Set<ProviderName>(["mock", "stub"]);

/**
 * Raised when a live (non-demo) run is requested with no usable live provider
 * at all — no free route AND no paid credentials.
 */
export class MissingProviderCredentialError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    const list = missing.length
      ? missing.join(", ")
      : "FACTORY_FREE_ENABLED, ANTHROPIC_API_KEY, OPENAI_API_KEY";
    super(
      `Live factory run blocked: no usable provider. Missing: ${list}. ` +
        `Start the free route ("Claude Code - FREE (Ollama)") or set a paid key, ` +
        `or pass explicit demo mode (options.demo=true / --demo).`,
    );
    this.name = "MissingProviderCredentialError";
    this.missing = missing;
  }
}

export interface ProviderRegistry {
  get(name: ProviderName): LLMProvider;
  /**
   * Soft resolve — may land on mock/stub. Use only for explicit demo / health
   * diagnostics. Live runs must use {@link resolveLive}.
   */
  resolve(requested: ProviderName | undefined, fallback: ProviderName): LLMProvider;
  /**
   * Live resolve — never returns mock/stub. Prefers the FREE route and hands
   * back the failover chain (free -> Anthropic -> OpenAI) so a wedged free
   * backend is rescued per call without ever becoming the default.
   */
  resolveLive(requested: ProviderName | undefined, fallback: ProviderName): LLMProvider;
  available(): ProviderName[];
  /** Every configured LIVE provider, free included. */
  availableLive(): ProviderName[];
  /** Configured PAID providers only — the rescue tier. */
  availablePaid(): ProviderName[];
  missingCredentialNames(): string[];
}

export function createProviderRegistry(
  config: AppConfig,
  secrets: AppSecrets,
  log: RouteLogger = () => {},
): ProviderRegistry {
  const mock = new MockProvider();
  const stub = new StubProvider("stub");

  // Every paid call reports its token usage into the spend ledger, so the
  // daily ceiling is enforced against real usage rather than a guess.
  const anthropic = new AnthropicProvider(
    secrets.anthropicApiKey,
    config.anthropicModel,
    (u) => {
      const usd = recordPaidCall("anthropic", u.inTokens, u.outTokens);
      log(
        "warn",
        `[route] paid Anthropic call billed: ${u.inTokens} in / ${u.outTokens} out ` +
          `tokens (est. $${usd.toFixed(4)}).`,
      );
    },
  );
  const openai = new OpenAIProvider(secrets.openaiApiKey, config.openaiModel, (u) => {
    const usd = recordPaidCall("openai", u.inTokens, u.outTokens);
    log(
      "warn",
      `[route] paid OpenAI call billed: ${u.inTokens} in / ${u.outTokens} out ` +
        `tokens (est. $${usd.toFixed(4)}).`,
    );
  });

  const free = new FreeProvider({
    baseUrl: config.free.baseUrl,
    authToken: secrets.freeAuthToken,
    model: config.free.model,
    ollamaUrl: config.free.ollamaUrl,
    maxConcurrency: config.free.maxConcurrency,
    backpressureRetryMs: config.free.retrySpacingMs,
    enabled: config.free.enabled,
  });

  /** The chain the deck actually runs on: free primary, paid rescue. */
  const chain = new FailoverProvider(
    free,
    anthropic,
    openai,
    {
      holdMs: config.free.holdMs,
      attempts: config.free.attempts,
      retrySpacingMs: config.free.retrySpacingMs,
      maxBackpressureRetries: config.free.maxBackpressureRetries,
      baseUrl: config.free.baseUrl,
      autoRestart: config.free.autoRestart,
    },
    log,
  );

  const byName: Record<ProviderName, LLMProvider> = {
    free,
    mock,
    stub,
    anthropic,
    openai,
  };

  function get(name: ProviderName): LLMProvider {
    return byName[name];
  }

  function missingCredentialNames(): string[] {
    const missing: string[] = [];
    if (!free.isConfigured())
      missing.push("FACTORY_FREE_ENABLED / FACTORY_FREE_BASE_URL");
    if (!anthropic.isConfigured()) missing.push("ANTHROPIC_API_KEY");
    if (!openai.isConfigured()) missing.push("OPENAI_API_KEY");
    return missing;
  }

  function availablePaid(): ProviderName[] {
    return (["anthropic", "openai"] as ProviderName[]).filter((n) =>
      byName[n].isConfigured(),
    );
  }

  function availableLive(): ProviderName[] {
    return (["free", "anthropic", "openai"] as ProviderName[]).filter((n) =>
      byName[n].isConfigured(),
    );
  }

  function resolve(
    requested: ProviderName | undefined,
    fallback: ProviderName,
  ): LLMProvider {
    const order: ProviderName[] = [];
    if (requested) order.push(requested);
    order.push(fallback, "free", "anthropic", "openai", "mock", "stub");
    for (const name of order) {
      const p = byName[name];
      if (p.isConfigured()) return p;
    }
    return mock;
  }

  function resolveLive(
    requested: ProviderName | undefined,
    fallback: ProviderName,
  ): LLMProvider {
    // The free route is primary whenever it is usable, regardless of what was
    // requested, EXCEPT when the caller explicitly pinned a paid provider.
    const explicitPaid =
      requested === "anthropic" || requested === "openai" ? requested : null;
    if (explicitPaid && byName[explicitPaid].isConfigured()) {
      return byName[explicitPaid];
    }
    if (free.isConfigured()) return chain;

    const order: ProviderName[] = [];
    if (fallback === "anthropic" || fallback === "openai") order.push(fallback);
    order.push("anthropic", "openai");
    for (const name of order) {
      const p = byName[name];
      if (p.isConfigured()) return p;
    }
    throw new MissingProviderCredentialError(missingCredentialNames());
  }

  function available(): ProviderName[] {
    return (Object.keys(byName) as ProviderName[]).filter((n) =>
      byName[n].isConfigured(),
    );
  }

  return {
    get,
    resolve,
    resolveLive,
    available,
    availableLive,
    availablePaid,
    missingCredentialNames,
  };
}
