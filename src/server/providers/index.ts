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
import { ModelLadderProvider, type ModelLadderRung } from "./modelLadderProvider.js";
import {
  createAnthropicModelResolver,
  createOpenAiModelResolver,
} from "./modelCatalog.js";

export { AnthropicProvider, OpenAIProvider, StubProvider, MockProvider, FreeProvider };
export { FailoverProvider };
export { ModelLadderProvider };
export { ProviderAbortError } from "./types.js";

/**
 * Offline providers — deterministic fakes that never satisfy the live
 * purpose-contract journey.
 *
 * NOTE that "free" is deliberately NOT in this set. The final free/local rung
 * runs real models through the FCC proxy; it really builds software, it just
 * costs nothing.
 */
export const OFFLINE_PROVIDERS = new Set<ProviderName>(["mock", "stub"]);

/**
 * Raised when the single automatic ladder has no usable live provider.
 * Paid capacity and free/local capacity are rungs in that one route; mock and
 * stub providers never satisfy live admission or readiness.
 */
export class MissingProviderCredentialError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    const list = missing.length
      ? missing.join(", ")
      : "FACTORY_FREE_ENABLED, ANTHROPIC_API_KEY, OPENAI_API_KEY";
    super(
      `Live factory operation blocked: required provider capability missing: ${list}. ` +
        `Live work uses one paid-first model ladder with free/local last; mock/stub are never a live fallback. ` +
        `Production-readiness receipts require two independent live judgments through that same ladder.`,
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
   * Legacy free-route diagnostic resolver — never returns mock/stub. Current
   * Factory Deck and Purpose Foundry work uses the automatic ladder builder.
   */
  resolveLive(requested: ProviderName | undefined, fallback: ProviderName): LLMProvider;
  available(): ProviderName[];
  /** Every configured live ladder rung. */
  availableLive(): ProviderName[];
  /** Configured paid ladder rungs only. */
  availablePaid(): ProviderName[];
  /**
   * Exact strongest-to-weakest model rungs for a run. Paid models are
   * individual sticky rungs; AI Time's best available free rotation is last.
   */
  automaticRungs?(order?: ProviderName[]): ModelLadderRung[];
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
  const anthropicModels = config.anthropicModels ?? [config.anthropicModel];
  const anthropicModelResolver = createAnthropicModelResolver({
    apiKey: secrets.anthropicApiKey,
    preferred: anthropicModels,
    log,
    signal,
  });
  const anthropicRungs: ModelLadderRung[] = anthropicModels.map((model) => ({
    model,
    provider: new AnthropicProvider(
      secrets.anthropicApiKey,
      model,
      (u) => {
        const usd = estimateUsd(u.inTokens, u.outTokens, loadLimits());
        log(
          "warn",
          `[route] paid Anthropic ${model} call billed: ${u.inTokens} in / ` +
            `${u.outTokens} out tokens (est. $${usd.toFixed(4)}).`,
        );
      },
      signal,
      true,
      anthropicModelResolver,
    ),
  }));
  const anthropic = new ModelLadderProvider(anthropicRungs, (from, to, reason) =>
    log(
      "warn",
      `[route] Anthropic model ${from} exhausted — continuing on ${to}. (${reason.slice(0, 120)})`,
    ),
  );

  const openaiModels = config.openaiModels ?? [config.openaiModel];
  const openAiModelResolver = createOpenAiModelResolver({
    apiKey: secrets.openaiApiKey,
    preferred: openaiModels,
    log,
    signal,
  });
  const openaiRungs: ModelLadderRung[] = openaiModels.map((model) => ({
    model,
    provider: new OpenAIProvider(
      secrets.openaiApiKey,
      model,
      (u) => {
        const usd = estimateUsd(u.inTokens, u.outTokens, loadLimits());
        log(
          "warn",
          `[route] paid OpenAI ${model} call billed: ${u.inTokens} in / ${u.outTokens} out ` +
            `tokens (est. $${usd.toFixed(4)}).`,
        );
      },
      signal,
      true,
      openAiModelResolver,
    ),
  }));
  const openai = new ModelLadderProvider(openaiRungs, (from, to, reason) =>
    log(
      "warn",
      `[route] OpenAI model ${from} exhausted — continuing on ${to}. (${reason.slice(0, 120)})`,
    ),
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

  function automaticRungs(
    order: ProviderName[] = config.modelLadder ?? ["anthropic", "openai", "free"],
  ): ModelLadderRung[] {
    const groups: Partial<Record<ProviderName, ModelLadderRung[]>> = {
      anthropic: anthropicRungs,
      openai: openaiRungs,
      free: [
        {
          model: rotator ? "aitime:best-free" : `fcc:${config.free.model}`,
          provider: freePrimary,
        },
      ],
    };
    return [...new Set(order)]
      .flatMap((name) => groups[name] ?? [])
      .filter((rung) => rung.provider.isConfigured());
  }

  /** Legacy free-route diagnostic chain; current live work uses the ladder. */
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
    if (!free.isConfigured()) {
      missing.push("FACTORY_FREE_ENABLED / FACTORY_FREE_BASE_URL");
    }
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
    automaticRungs,
    missingCredentialNames,
  };
}
