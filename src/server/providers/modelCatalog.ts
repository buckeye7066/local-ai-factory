import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { ProviderName } from "../../shared/schemas.js";
import { ProviderAbortError } from "./types.js";

export type ModelIdResolver = (requestedModel: string) => Promise<string>;

type CatalogModel = {
  id: string;
  created: number;
};

type CatalogLogger = (level: "info" | "warn", message: string) => void;

/**
 * A successful Models API response is an account-scoped availability fact.
 * Keep it for the life of the provider registry so every ladder rung consults
 * the same snapshot instead of repeatedly probing model IDs with generation
 * requests. A failed catalog read is deliberately not treated as proof that a
 * configured model is unavailable; the normal generation request remains the
 * authoritative fallback in that case.
 */
export function createCachedModelResolver(args: {
  provider: Extract<ProviderName, "anthropic" | "openai">;
  preferred: readonly string[];
  load: () => Promise<CatalogModel[]>;
  log: CatalogLogger;
  signal?: AbortSignal;
}): ModelIdResolver {
  let snapshot: Promise<CatalogModel[] | null> | null = null;
  let warned = false;
  let configuredFallbackAttempted = false;
  const loggedResolutions = new Set<string>();

  const loadOnce = (): Promise<CatalogModel[] | null> => {
    snapshot ??= args.load().catch(() => {
      if (args.signal?.aborted) throw new ProviderAbortError();
      if (!warned) {
        warned = true;
        args.log(
          "warn",
          `[route] ${args.provider} model catalog could not be read; ` +
            "falling back to the configured model IDs.",
        );
      }
      return null;
    });
    return snapshot;
  };

  return async (requestedModel: string): Promise<string> => {
    const catalog = await loadOnce();
    if (catalog === null) {
      // A transient Models API outage must not trigger a fan-out across a list
      // of unverified IDs. Permit exactly the strongest configured ID as a
      // compatibility probe, then make lower rungs fail locally so the ladder
      // proceeds to the next paid provider family.
      if (!configuredFallbackAttempted) {
        configuredFallbackAttempted = true;
        return requestedModel;
      }
      throw Object.assign(
        new Error(
          `${args.provider} model catalog unavailable; suppressed unverified model probe for ${requestedModel}`,
        ),
        { status: 404 },
      );
    }

    const available = catalog.filter((model) =>
      isGenerativeModel(args.provider, model.id),
    );
    const ordered = resolvePreferredModels(args.provider, args.preferred, available);
    const requestedIndex = args.preferred.indexOf(requestedModel);
    const resolved = requestedIndex >= 0 ? ordered[requestedIndex] : undefined;
    if (resolved) {
      const resolution = `${requestedModel}\u0000${resolved}`;
      if (!loggedResolutions.has(resolution)) {
        loggedResolutions.add(resolution);
        args.log(
          "info",
          `[route] ${args.provider} Models API confirmed account-visible model ${resolved}` +
            (resolved === requestedModel
              ? "."
              : ` for configured rung ${requestedModel}.`),
        );
      }
      return resolved;
    }

    throw Object.assign(
      new Error(
        `${args.provider} model not found in the account catalog: ${requestedModel}`,
      ),
      { status: 404 },
    );
  };
}

/**
 * Resolve owner preferences against actual account-visible IDs. Provider
 * quality tiers determine the execution order; exact configured aliases win
 * only within the same tier. A dated provider snapshot (for example
 * `claude-haiku-4-5-20251001`) can satisfy its undated alias. This means an
 * unlisted account-visible flagship remains ahead of a newer weak snapshot
 * instead of being displaced by a positional match.
 */
export function resolvePreferredModels(
  provider: Extract<ProviderName, "anthropic" | "openai">,
  preferred: readonly string[],
  available: readonly CatalogModel[],
): string[] {
  const unique = [
    ...new Map(available.map((model) => [model.id.toLowerCase(), model])).values(),
  ];
  return unique
    .sort((left, right) => compareModelStrength(provider, preferred, left, right))
    .map(({ id }) => id);
}

/**
 * Models APIs report availability and creation time, not model quality. Rank
 * explicit product tiers first; creation time is only a tie-breaker within a
 * tier. This prevents a newer Haiku/Luna snapshot from outranking an older
 * Opus/Sol model. Exact configured aliases remain preferred within their
 * quality tier, but cannot pull a weaker tier ahead of a stronger unlisted
 * account-visible model.
 */
function compareModelStrength(
  provider: Extract<ProviderName, "anthropic" | "openai">,
  preferred: readonly string[],
  left: CatalogModel,
  right: CatalogModel,
): number {
  const leftTier = modelQualityTier(provider, left.id);
  const rightTier = modelQualityTier(provider, right.id);
  if (leftTier !== rightTier) return rightTier - leftTier;

  const leftPreference = preferred.findIndex((model) => modelMatches(model, left.id));
  const rightPreference = preferred.findIndex((model) => modelMatches(model, right.id));
  if (leftPreference >= 0 || rightPreference >= 0) {
    if (leftPreference < 0) return 1;
    if (rightPreference < 0) return -1;
    if (leftPreference !== rightPreference) return leftPreference - rightPreference;
  }

  if (left.created !== right.created) return right.created - left.created;
  return left.id.localeCompare(right.id);
}

function modelMatches(configured: string, available: string): boolean {
  const requested = configured.toLowerCase();
  const candidate = available.toLowerCase();
  return (
    candidate === requested ||
    candidate.startsWith(`${requested}-`) ||
    requested.startsWith(`${candidate}-`)
  );
}

function modelQualityTier(
  provider: Extract<ProviderName, "anthropic" | "openai">,
  model: string,
): number {
  const id = model.toLowerCase();
  if (provider === "anthropic") {
    if (id.includes("fable")) return 500;
    if (id.includes("opus")) return 400;
    if (id.includes("sonnet")) return 300;
    if (id.includes("haiku")) return 200;
    return 100;
  }

  if (id.includes("astra")) return 700;
  if (id.includes("pro")) return 650;
  if (id.includes("sol")) return 600;
  if (id.includes("terra")) return 500;
  if (id.includes("codex")) return 450;
  if (id.includes("mini")) return 350;
  if (id.includes("luna")) return 300;
  if (id.includes("nano")) return 200;
  return 400;
}

function isGenerativeModel(
  provider: Extract<ProviderName, "anthropic" | "openai">,
  model: string,
): boolean {
  if (provider === "anthropic") return /^claude-/i.test(model);
  // The factory uses the Responses API for text/code generation. Exclude the
  // image/audio/embedding/moderation catalogs that the OpenAI Models endpoint
  // also returns; the current flagship families all begin with gpt-5/gpt-6.
  return /^gpt-(?:5|6)(?:[.\-]|$)/i.test(model);
}

export function createAnthropicModelResolver(args: {
  apiKey: string;
  preferred: readonly string[];
  log: CatalogLogger;
  signal?: AbortSignal;
}): ModelIdResolver | undefined {
  if (!args.apiKey) return undefined;
  const client = new Anthropic({
    apiKey: args.apiKey,
    baseURL: "https://api.anthropic.com",
  });
  return createCachedModelResolver({
    provider: "anthropic",
    preferred: args.preferred,
    log: args.log,
    signal: args.signal,
    load: async () => {
      const page = await client.models.list({ limit: 100 }, { signal: args.signal });
      return page.data.map((model) => ({
        id: model.id,
        created: Date.parse(model.created_at) || 0,
      }));
    },
  });
}

export function createOpenAiModelResolver(args: {
  apiKey: string;
  preferred: readonly string[];
  log: CatalogLogger;
  signal?: AbortSignal;
}): ModelIdResolver | undefined {
  if (!args.apiKey) return undefined;
  const client = new OpenAI({
    apiKey: args.apiKey,
    baseURL: "https://api.openai.com/v1",
  });
  return createCachedModelResolver({
    provider: "openai",
    preferred: args.preferred,
    log: args.log,
    signal: args.signal,
    load: async () => {
      const page = await client.models.list({ signal: args.signal });
      return page.data.map((model) => ({
        id: model.id,
        created: model.created,
      }));
    },
  });
}
