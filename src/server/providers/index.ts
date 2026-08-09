import type { AppConfig, AppSecrets } from "../config.js";
import type { LLMProvider } from "../../shared/types.js";
import type { ProviderName } from "../../shared/schemas.js";
import { AnthropicProvider } from "./anthropicProvider.js";
import { OpenAIProvider } from "./openaiProvider.js";
import { StubProvider } from "./stubProvider.js";
import { MockProvider } from "./mockProvider.js";

export { AnthropicProvider, OpenAIProvider, StubProvider, MockProvider };

/**
 * A registry of available providers for a single run. Mock (and legacy stub)
 * are always present; anthropic/openai are present only when keys exist.
 */
export interface ProviderRegistry {
  get(name: ProviderName): LLMProvider;
  resolve(requested: ProviderName | undefined, fallback: ProviderName): LLMProvider;
  available(): ProviderName[];
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

  /**
   * Pick the requested provider when it is configured; otherwise gracefully
   * fall back (and finally to the always-available mock). Paid-provider outage
   * or missing keys never take down the control plane — journeys degrade to mock.
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

  function available(): ProviderName[] {
    return (Object.keys(byName) as ProviderName[]).filter((n) =>
      byName[n].isConfigured(),
    );
  }

  return { get, resolve, available };
}
