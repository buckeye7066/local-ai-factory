import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { ProviderName } from "../../shared/schemas.js";
import { ProviderAbortError, ProviderModelUnavailableError } from "./types.js";

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
      throw new ProviderModelUnavailableError(
        `${args.provider} model unavailable: suppressed unverified model probe for ${requestedModel} because catalog lookup failed`,
      );
    }

    const available = catalog.filter((model) =>
      isGenerativeModel(args.provider, model.id, args.preferred),
    );
    const assignments = resolvePreferredAssignments(
      args.provider,
      args.preferred,
      available,
    );
    const requestedIndex = args.preferred.indexOf(requestedModel);
    const resolved = requestedIndex >= 0 ? assignments[requestedIndex]?.id : undefined;
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

    throw new ProviderModelUnavailableError(
      `${args.provider} model unavailable in the account catalog: ${requestedModel}`,
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
  const usable = available.filter((model) =>
    isGenerativeModel(provider, model.id, preferred),
  );
  return resolvePreferredAssignments(provider, preferred, usable)
    .filter((model): model is CatalogModel => model !== undefined)
    .map(({ id }) => id);
}

function resolvePreferredAssignments(
  provider: Extract<ProviderName, "anthropic" | "openai">,
  preferred: readonly string[],
  available: readonly CatalogModel[],
): Array<CatalogModel | undefined> {
  const unique = [
    ...new Map(available.map((model) => [model.id.toLowerCase(), model])).values(),
  ];
  const assignments = new Array<CatalogModel | undefined>(preferred.length);
  const pinnedIds = new Set<string>();

  // A dated model is an immutable owner pin. Reserve its exact catalog entry
  // in that rung (or leave that rung unavailable) before deriving automatic
  // substitutions for flexible aliases. This prevents a missing early pin
  // from shifting every later configured rung onto the wrong model.
  preferred.forEach((configured, index) => {
    if (!isDatedSnapshot(configured)) return;
    const exact = unique.find(
      (candidate) =>
        candidate.id.toLowerCase() === configured.toLowerCase() &&
        !pinnedIds.has(candidate.id.toLowerCase()),
    );
    if (!exact) return;
    assignments[index] = exact;
    pinnedIds.add(exact.id.toLowerCase());
  });

  const flexiblePositions = preferred
    .map((configured, index) => ({ configured, index }))
    .filter(({ configured }) => !isDatedSnapshot(configured));
  const flexible = resolveFlexibleModels(
    provider,
    flexiblePositions.map(({ configured }) => configured),
    unique.filter((candidate) => !pinnedIds.has(candidate.id.toLowerCase())),
  );
  flexiblePositions.forEach(({ index }, flexibleIndex) => {
    assignments[index] = flexible[flexibleIndex];
  });
  return assignments;
}

function resolveFlexibleModels(
  provider: Extract<ProviderName, "anthropic" | "openai">,
  preferred: readonly string[],
  available: readonly CatalogModel[],
): CatalogModel[] {
  const selected: CatalogModel[] = [];
  const selectedIds = new Set<string>();

  // Account-visible explicit IDs are commitments, not disposable hints. Keep
  // one exact/snapshot match for every configured rung before filling missing
  // slots with newly discovered models. This preserves intentional gpt-4.1
  // and o-series routes even when the same account also exposes newer IDs.
  for (const configured of preferred) {
    const match = available
      .filter(
        (candidate) =>
          !selectedIds.has(candidate.id.toLowerCase()) &&
          modelMatches(configured, candidate.id),
      )
      .sort((left, right) => right.created - left.created)[0];
    if (!match) continue;
    selected.push(match);
    selectedIds.add(match.id.toLowerCase());
  }

  const remaining = available
    .filter((candidate) => !selectedIds.has(candidate.id.toLowerCase()))
    .sort((left, right) => compareModelStrength(provider, preferred, left, right))
    .slice(0, Math.max(0, preferred.length - selected.length));
  selected.push(...remaining);

  return selected.sort((left, right) =>
    compareModelStrength(provider, preferred, left, right),
  );
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
  if (candidate === requested) return true;
  // A dated configuration is an immutable pin, never an alias for another
  // date. Only an undated or explicit `latest` configuration may resolve to
  // a provider-listed dated snapshot (or its undated account alias).
  if (isDatedSnapshot(requested)) return false;
  const requestedBase = requested.replace(/-latest$/, "");
  const candidateBase = candidate
    .replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, "")
    .replace(/-latest$/, "");
  return requestedBase === candidateBase;
}

function isDatedSnapshot(model: string): boolean {
  return /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/i.test(model);
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
  if (/(?:^|[-.])pro(?:[-.]|$)/.test(id)) return 650;
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
  preferred: readonly string[],
): boolean {
  if (provider === "anthropic") return /^claude-/i.test(model);
  // An explicitly configured account-visible model is authoritative even
  // when its family predates or differs from the current defaults (for
  // example gpt-4.1 or o3). This also avoids guessing that every model in the
  // broad OpenAI catalog can serve Responses text.
  if (preferred.some((configured) => modelMatches(configured, model))) return true;
  // The factory uses the Responses API for text/code generation. Exclude the
  // image/audio/embedding/moderation catalogs that the OpenAI Models endpoint
  // also returns; retain current GPT families and reasoning o-series models.
  const normalized = model.toLowerCase();
  if (
    /(?:^|[-.])(?:audio|embedding|image|moderation|realtime|search|transcribe|tts|vision)(?:[-.]|$)/.test(
      normalized,
    )
  ) {
    return false;
  }
  return /^(?:gpt-(?:5|6)(?:[.\-]|$)|o\d+(?:[.\-]|$))/i.test(normalized);
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
    authToken: null,
    baseURL: "https://api.anthropic.com",
    maxRetries: 0,
  });
  return createCachedModelResolver({
    provider: "anthropic",
    preferred: args.preferred,
    log: args.log,
    signal: args.signal,
    load: async () => {
      const models: CatalogModel[] = [];
      // The Models API is newest-first and paginated. A successful first page
      // is not proof that an older immutable pin is absent, so consume the
      // SDK's auto-paginating iterator before making availability decisions.
      for await (const model of client.models.list(
        { limit: 100 },
        { signal: args.signal },
      )) {
        models.push({
          id: model.id,
          created: Date.parse(model.created_at) || 0,
        });
      }
      return models;
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
    organization: null,
    project: null,
    maxRetries: 0,
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
