import type { AppConfig, AppSecrets } from "../config.js";
import type { LLMProvider } from "../../shared/types.js";
import type { ProviderName } from "../../shared/schemas.js";
import { AnthropicProvider } from "./anthropicProvider.js";
import { OpenAIProvider } from "./openaiProvider.js";
import { StubProvider } from "./stubProvider.js";
import { MockProvider } from "./mockProvider.js";
import { FreeProvider } from "./freeProvider.js";
import {
  FailoverProvider,
  type FreePrimary,
  type RouteLogger,
} from "./failoverProvider.js";
import { estimateUsd, loadLimits } from "./paidBudget.js";
import {
  buildRotator,
  rotationEnabled,
  unavailableReason,
} from "../rotation/aitimeRotation.js";
import {
  RotatingProvider,
  filterRoutableCatalog,
} from "../rotation/rotatingProvider.js";
import { ThemedProvider } from "../orchestrator/workTheme.js";

export { AnthropicProvider, OpenAIProvider, StubProvider, MockProvider, FreeProvider };
export { FailoverProvider };
export { ProviderAbortError } from "./types.js";

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
        `Start the free route ("Claude Code - FREE (Ollama)") or set a paid key. ` +
        `There is no offline/mock fallback — a run with no real provider must ` +
        `fail loudly rather than fabricate a result.`,
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
   * Legacy live resolve — never returns mock/stub. Owner-selected runs use the
   * strict tier builder instead, because this compatibility resolver may hand
   * back the historical free-to-paid failover chain.
   */
  resolveLive(requested: ProviderName | undefined, fallback: ProviderName): LLMProvider;
  available(): ProviderName[];
  /** Every configured LIVE provider, free included. */
  availableLive(): ProviderName[];
  /** Configured PAID providers only. */
  availablePaid(): ProviderName[];
  missingCredentialNames(): string[];
}

/** Stamp the run's WorkTheme onto every live call when ALS is bound. */
function withTheme(provider: LLMProvider): LLMProvider {
  return provider instanceof ThemedProvider ? provider : new ThemedProvider(provider);
}

export function createProviderRegistry(
  config: AppConfig,
  secrets: AppSecrets,
  log: RouteLogger = () => {},
  /**
   * Bounds every paid-provider SDK call this registry's Anthropic/OpenAI
   * instances make — the run's deadline combined with its cancellation
   * signal. Optional and unused by callers that only resolve provider NAMES
   * (queue-time validation, health checks) rather than making live calls.
   */
  signal?: AbortSignal,
  /**
   * Which consumer this registry serves, for the per-app pin key in the
   * shared rotation state ("factory-deck" vs "purpose-foundry").
   */
  app: string = "factory-deck",
): ProviderRegistry {
  const mock = new MockProvider();
  const stub = new StubProvider("stub");

  // Every paid SDK call reserves admission before I/O. Its returned token
  // usage then replaces the in-flight estimate in the local ledger; provider
  // billing can include charges this estimate does not model.
  const anthropic = new AnthropicProvider(
    secrets.anthropicApiKey,
    config.anthropicModel,
    (u) => {
      const usd = estimateUsd(u.inTokens, u.outTokens, loadLimits());
      log(
        "warn",
        `[route] paid Anthropic call billed: ${u.inTokens} in / ${u.outTokens} out ` +
          `tokens (est. $${usd.toFixed(4)}).`,
      );
    },
    signal,
    true,
  );
  const openai = new OpenAIProvider(
    secrets.openaiApiKey,
    config.openaiModel,
    (u) => {
      const usd = estimateUsd(u.inTokens, u.outTokens, loadLimits());
      log(
        "warn",
        `[route] paid OpenAI call billed: ${u.inTokens} in / ${u.outTokens} out ` +
          `tokens (est. $${usd.toFixed(4)}).`,
      );
    },
    signal,
    true,
  );

  const free = new FreeProvider({
    baseUrl: config.free.baseUrl,
    authToken: secrets.freeAuthToken,
    model: config.free.model,
    ollamaUrl: config.free.ollamaUrl,
    maxConcurrency: config.free.maxConcurrency,
    backpressureRetryMs: config.free.retrySpacingMs,
    enabled: config.free.enabled,
    // Cancel/deadline reaches FREE calls too, not only paid SDK calls.
    signal,
  });

  // Pool-first rotation across every $0 route in the AI Time catalog
  // (docs/rotation-contract.md v1). Rotation is the DEFAULT $0 primary;
  // AI_ROTATE=off, or an unusable catalog, restores the FCC-only free route
  // exactly. Never a silent no-op: when rotation is wanted but unavailable,
  // the reason is logged. Paid routes never enter this ring — the rescue tier
  // below remains the only path to paid-metered spending, behind canPayNow().
  const built = buildRotator(app);
  // Routes whose credential env var is absent in THIS process are filtered
  // out locally (never marked in the shared state — other consumers may hold
  // the key), so rotation only walks pools this process can actually call.
  const rotator = built ? filterRoutableCatalog(built, config.free.baseUrl, log) : null;
  if (!built && rotationEnabled()) {
    log(
      "warn",
      `[rotate] rotation unavailable (${unavailableReason()}); ` +
        `using the FCC free route as the sole $0 primary.`,
    );
  }
  if (rotator?.catalog.isStale) {
    log(
      "warn",
      `[rotate] route catalog is ${Math.round(
        rotator.catalog.ageSeconds / 3600,
      )}h old (stale past 3h) — still routing; refresh with ` +
        `\`python -m aitime.catalog\`.`,
    );
  }
  const freePrimary: FreePrimary = rotator
    ? new RotatingProvider(rotator, {
        fccDelegate: free,
        fccBaseUrl: config.free.baseUrl,
        tier: "frontier",
        log,
        signal,
      })
    : free;

  /** Legacy compatibility chain; strict owner-selected Free runs bypass it. */
  const chain = new FailoverProvider(
    freePrimary,
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
    // "free" is the $0 primary — the rotating provider when rotation is on,
    // the FCC route alone otherwise. Either way it never spends money.
    free: freePrimary,
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
      return withTheme(byName[explicitPaid]);
    }
    // The $0 primary counts as configured when EITHER the FCC proxy is up or
    // the rotation catalog offers other $0 routes (local ollama, free tiers).
    if (freePrimary.isConfigured()) return withTheme(chain);

    const order: ProviderName[] = [];
    if (fallback === "anthropic" || fallback === "openai") order.push(fallback);
    order.push("anthropic", "openai");
    for (const name of order) {
      const p = byName[name];
      if (p.isConfigured()) return withTheme(p);
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
