import type { AppConfig, AppSecrets } from "../config.js";
import type { LLMProvider } from "../../shared/types.js";
import type { ProviderName } from "../../shared/schemas.js";
import { AnthropicProvider } from "./anthropicProvider.js";
import { OpenAIProvider } from "./openaiProvider.js";
import { StubProvider } from "./stubProvider.js";
import { MockProvider } from "./mockProvider.js";

export { AnthropicProvider, OpenAIProvider, StubProvider, MockProvider };

/** Offline providers — never satisfy the live purpose-contract journey alone. */
export const OFFLINE_PROVIDERS = new Set<ProviderName>(["mock", "stub"]);

/**
 * Raised when a live (non-demo) run is requested without paid credentials.
 * Callers must surface the exact missing env var names — never silently mock.
 */
export class MissingProviderCredentialError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    const list = missing.length ? missing.join(", ") : "ANTHROPIC_API_KEY, OPENAI_API_KEY";
    super(
      `Live factory run blocked: missing credential(s): ${list}. ` +
        `Set them in .env or pass explicit demo mode (options.demo=true / --demo).`,
    );
    this.name = "MissingProviderCredentialError";
    this.missing = missing;
  }
}

/**
 * A registry of available providers for a single run. Mock (and legacy stub)
 * are always present; anthropic/openai are present only when keys exist.
 */
export interface ProviderRegistry {
  get(name: ProviderName): LLMProvider;
  /**
   * Soft resolve — may land on mock/stub. Use only for explicit demo / health
   * diagnostics. Live runs must use {@link resolveLive}.
   */
  resolve(requested: ProviderName | undefined, fallback: ProviderName): LLMProvider;
  /**
   * Live resolve — never returns mock/stub. Throws
   * {@link MissingProviderCredentialError} when no paid provider is configured.
   */
  resolveLive(
    requested: ProviderName | undefined,
    fallback: ProviderName,
  ): LLMProvider;
  available(): ProviderName[];
  availablePaid(): ProviderName[];
  missingCredentialNames(): string[];
}

export function createProviderRegistry(
  config: AppConfig,
  secrets: AppSecrets,
): ProviderRegistry {
  const mock = new MockProvider();
  const stub = new StubProvider("stub");
  const anthropic = new AnthropicProvider(
    secrets.anthropicApiKey,
    config.anthropicModel,
  );
  const openai = new OpenAIProvider(secrets.openaiApiKey, config.openaiModel);

  const byName: Record<ProviderName, LLMProvider> = {
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
    if (!anthropic.isConfigured()) missing.push("ANTHROPIC_API_KEY");
    if (!openai.isConfigured()) missing.push("OPENAI_API_KEY");
    return missing;
  }

  function availablePaid(): ProviderName[] {
    return (["anthropic", "openai"] as ProviderName[]).filter((n) =>
      byName[n].isConfigured(),
    );
  }

  /**
   * Soft resolve for explicit demo/offline journeys only. Paid-provider gaps
   * may land on mock — never use this to claim live purpose fulfillment.
   */
  function resolve(
    requested: ProviderName | undefined,
    fallback: ProviderName,
  ): LLMProvider {
    const order: ProviderName[] = [];
    if (requested) order.push(requested);
    order.push(fallback, "anthropic", "openai", "mock", "stub");
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
    const order: ProviderName[] = [];
    if (requested && !OFFLINE_PROVIDERS.has(requested)) order.push(requested);
    if (!OFFLINE_PROVIDERS.has(fallback)) order.push(fallback);
    order.push("anthropic", "openai");
    for (const name of order) {
      const p = byName[name];
      if (p.isConfigured() && !OFFLINE_PROVIDERS.has(p.name)) return p;
    }
    throw new MissingProviderCredentialError(missingCredentialNames());
  }

  function available(): ProviderName[] {
    return (Object.keys(byName) as ProviderName[]).filter((n) =>
      byName[n].isConfigured(),
    );
  }

  return { get, resolve, resolveLive, available, availablePaid, missingCredentialNames };
}
