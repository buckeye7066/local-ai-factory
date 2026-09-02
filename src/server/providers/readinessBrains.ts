import type { ProviderName } from "../../shared/schemas.js";
import type { LLMProvider } from "../../shared/types.js";
import { readinessBrainFloor, type AppConfig, type AppSecrets } from "../config.js";
import { estimateUsd, loadLimits } from "./paidBudget.js";
import { AnthropicProvider } from "./anthropicProvider.js";
import { OpenAIProvider } from "./openaiProvider.js";
import { MissingProviderCredentialError } from "./index.js";
import type { RouteLogger } from "./failoverProvider.js";
import { ModelLadderProvider } from "./modelLadderProvider.js";

export type ReadinessPaidProvider = "openai" | "anthropic";

export type ReadinessProviderRoute = {
  provider: LLMProvider;
  currentProvider: () => ReadinessPaidProvider;
  currentModel: () => string;
};

export type ReadinessProviderPair = {
  lead: ReadinessProviderRoute;
  challenger: ReadinessProviderRoute;
};

function asPaidProvider(name: ProviderName): ReadinessPaidProvider {
  if (name === "openai" || name === "anthropic") return name;
  throw new Error(`Readiness review reached non-paid provider ${name}.`);
}

/**
 * Construct two separately stateful reviewers over the same configured paid
 * ladder. Each judgment starts at the strongest paid rung and independently
 * descends on model exhaustion. The route never splits into provider-specific
 * gates and never falls through to mock, stub, or free/local capacity.
 */
export function createReadinessBrainProviders(
  config: AppConfig,
  secrets: AppSecrets,
  log: RouteLogger = () => {},
  signal?: AbortSignal,
  decorateProvider: (provider: LLMProvider) => LLMProvider = (provider) => provider,
): ReadinessProviderPair {
  const floor = readinessBrainFloor(config, secrets);
  if (!floor.configured) {
    throw new MissingProviderCredentialError([
      "at least one configured paid model in FACTORY_MODEL_LADDER",
    ]);
  }

  const paidOrder = (config.modelLadder ?? ["anthropic", "openai", "free"]).filter(
    (name): name is ReadinessPaidProvider =>
      (name === "anthropic" && floor.anthropicConfigured) ||
      (name === "openai" && floor.openaiConfigured),
  );

  const usageLogger =
    (reviewer: "lead" | "challenger", family: string, model: string) =>
    (usage: { inTokens: number; outTokens: number }) => {
      const usd = estimateUsd(usage.inTokens, usage.outTokens, loadLimits());
      log(
        "warn",
        `[readiness] paid ${reviewer} review on ${family}/${model} billed: ` +
          `${usage.inTokens} in / ${usage.outTokens} out tokens ` +
          `(est. $${usd.toFixed(4)}).`,
      );
    };

  const makeRoute = (reviewer: "lead" | "challenger"): ReadinessProviderRoute => {
    const rungs: Array<{ model: string; provider: LLMProvider }> = [];
    for (const family of paidOrder) {
      if (family === "anthropic") {
        for (const model of config.anthropicModels ?? [config.anthropicModel]) {
          rungs.push({
            model,
            provider: decorateProvider(
              new AnthropicProvider(
                secrets.anthropicApiKey,
                model,
                usageLogger(reviewer, "anthropic", model),
                signal,
                true,
              ),
            ),
          });
        }
      } else {
        rungs.push({
          model: config.solModel,
          provider: decorateProvider(
            new OpenAIProvider(
              secrets.openaiApiKey,
              config.solModel,
              usageLogger(reviewer, "openai", config.solModel),
              signal,
              true,
            ),
          ),
        });
      }
    }

    const ladder = new ModelLadderProvider(rungs, (from, to, reason) =>
      log(
        "warn",
        `[readiness] ${reviewer} model ${from} exhausted — continuing on ${to}. ` +
          `(${reason.slice(0, 120)})`,
      ),
    );
    return {
      provider: ladder,
      currentProvider: () => asPaidProvider(ladder.currentProvider()),
      currentModel: () => ladder.currentModel(),
    };
  };

  return {
    lead: makeRoute("lead"),
    challenger: makeRoute("challenger"),
  };
}
