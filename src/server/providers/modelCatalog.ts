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

    const available = catalog
      .filter((model) => isGenerativeModel(args.provider, model.id))
      .sort((a, b) => b.created - a.created || a.id.localeCompare(b.id));
    const ordered = resolvePreferredModels(args.preferred, available);
    const requestedIndex = args.preferred.indexOf(requestedModel);
    const resolved = requestedIndex >= 0 ? ordered[requestedIndex] : undefined;
    if (resolved) return resolved;

    throw Object.assign(
      new Error(
        `${args.provider} model not found in the account catalog: ${requestedModel}`,
      ),
      { status: 404 },
    );
  };
}

/**
 * Resolve the owner-configured strength order against actual account-visible
 * IDs. Exact IDs win. A dated provider snapshot (for example
 * `claude-haiku-4-5-20251001`) can satisfy its undated alias. Remaining
 * account-visible generative models are appended newest-first, so an account
 * that has the current flagship but not a stale configured alias still starts
 * with paid capacity instead of falling through to local inference.
 */
export function resolvePreferredModels(
  preferred: readonly string[],
  available: readonly CatalogModel[],
): string[] {
  const remaining = [...available];
  const resolved: string[] = [];
  for (const requested of preferred) {
    const normalized = requested.toLowerCase();
    const index = remaining.findIndex(({ id }) => {
      const candidate = id.toLowerCase();
      return (
        candidate === normalized ||
        candidate.startsWith(`${normalized}-`) ||
        normalized.startsWith(`${candidate}-`)
      );
    });
    if (index < 0) continue;
    const [match] = remaining.splice(index, 1);
    if (match) resolved.push(match.id);
  }
  resolved.push(...remaining.map(({ id }) => id));
  return [...new Set(resolved)];
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
