import type { LLMProvider } from "../../shared/types.js";
import { readinessBrainFloor, type AppConfig, type AppSecrets } from "../config.js";
import { estimateUsd, loadLimits } from "./paidBudget.js";
import { AnthropicProvider } from "./anthropicProvider.js";
import { OpenAIProvider } from "./openaiProvider.js";
import { MissingProviderCredentialError } from "./index.js";
import type { RouteLogger } from "./failoverProvider.js";

export type ReadinessProviderPair = {
  sol: LLMProvider;
  solModel: string;
  second: LLMProvider;
  secondIdentity: "fable" | "opus";
  secondModel: string;
};

/**
 * Construct the mandatory readiness brains independently from ordinary run
 * routing. Free/helper models may build, but production completion always pays
 * for and records one OpenAI Sol judgment plus one Anthropic Fable/Opus-class
 * judgment. No failover crosses this boundary.
 */
export function createReadinessBrainProviders(
  config: AppConfig,
  secrets: AppSecrets,
  log: RouteLogger = () => {},
  signal?: AbortSignal,
): ReadinessProviderPair {
  const floor = readinessBrainFloor(config, secrets);
  if (!floor.configured) {
    const missing: string[] = [];
    if (!floor.solConfigured) {
      missing.push("OPENAI_API_KEY and FACTORY_SOL_MODEL");
    }
    if (!floor.fableOrOpusConfigured) {
      missing.push(
        "ANTHROPIC_API_KEY and FACTORY_FABLE_OR_OPUS_MODEL containing Fable or Opus",
      );
    }
    throw new MissingProviderCredentialError(missing);
  }

  const usageLogger =
    (label: "Sol" | "Fable/Opus") =>
    (usage: { inTokens: number; outTokens: number }) => {
      const usd = estimateUsd(usage.inTokens, usage.outTokens, loadLimits());
      log(
        "warn",
        `[readiness] paid ${label} review billed: ${usage.inTokens} in / ` +
          `${usage.outTokens} out tokens (est. $${usd.toFixed(4)}).`,
      );
    };

  const sol = new OpenAIProvider(
    secrets.openaiApiKey,
    config.solModel,
    usageLogger("Sol"),
    signal,
    true,
  );
  const second = new AnthropicProvider(
    secrets.anthropicApiKey,
    config.fableOrOpusModel,
    usageLogger("Fable/Opus"),
    signal,
    true,
  );

  return {
    sol,
    solModel: config.solModel,
    second,
    secondIdentity: /fable/i.test(config.fableOrOpusModel) ? "fable" : "opus",
    secondModel: config.fableOrOpusModel,
  };
}
