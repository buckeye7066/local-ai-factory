import type { SearchResult } from "./webSearch.js";

/**
 * repoRewards.ts — the owner's own repo-discovery service as a first-class
 * research source (owner order 2026-08-16: "allow flexfactor and factorydeck
 * (and purpose foundry) by default also use scout and repo rewards as well
 * their own web search for competitors").
 *
 * Repo Rewards ranks real repositories for a natural-language need. It is
 * strictly a DISCOVERY source: its own contract says results are
 * metadata-screened candidates only — never "safe to install" or "safe to
 * run". Everything found here still flows through the same inspection,
 * license gate, and reuse-mode enforcement that web-discovered candidates do.
 *
 * Degrades exactly like webSearchTool: any failure returns [] and the caller
 * reports the source as unreachable. Research never aborts a run.
 */

const SEARCH_TIMEOUT_MS = 45_000;

/** Local instance first (free, private), then the owner's production deploy. */
export function repoRewardsEndpoints(env: NodeJS.ProcessEnv = process.env): string[] {
  const explicit = env.FACTORY_REPO_REWARDS_URL?.trim();
  if (explicit) return [explicit.replace(/\/+$/, "")];
  return [
    "http://localhost:3000",
    (
      env.FACTORY_REPO_REWARDS_PRODUCTION_URL?.trim() ||
      "https://web-production-d7db7.up.railway.app"
    ).replace(/\/+$/, ""),
  ];
}

interface RepoRewardsRepo {
  fullName?: string;
  htmlUrl?: string;
  description?: string;
  stargazersCount?: number;
  license?: { spdxId?: string; name?: string } | string | null;
}

interface RepoRewardsResult {
  repo?: RepoRewardsRepo;
  score?: number;
  reason?: string;
}

/** One ranked repo as a plain SearchResult, so callers treat all sources alike. */
export function toSearchResults(results: RepoRewardsResult[]): SearchResult[] {
  const out: SearchResult[] = [];
  for (const r of results) {
    const url = r.repo?.htmlUrl;
    if (!url) continue;
    out.push({
      title: r.repo?.fullName || url,
      url,
      snippet: [r.repo?.description, r.reason].filter(Boolean).join(" — ").slice(0, 500),
    });
  }
  return out;
}

export interface RepoRewardsSearch {
  results: SearchResult[];
  /** The endpoint that answered, or null when none did. */
  endpoint: string | null;
  /** Named reason when nothing answered — reported, never silent. */
  unreachableReason: string | null;
}

/**
 * Search Repo Rewards for a need. Tries a local instance first, then the
 * owner's production deployment; returns the first endpoint that answers.
 */
export async function repoRewardsSearch(
  query: string,
  opts: {
    limit?: number;
    fetchImpl?: typeof fetch;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<RepoRewardsSearch> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const endpoints = repoRewardsEndpoints(opts.env);
  const failures: string[] = [];

  for (const base of endpoints) {
    try {
      const res = await fetchImpl(`${base}/api/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, limit: opts.limit ?? 10 }),
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        failures.push(`${base} → HTTP ${res.status}`);
        continue;
      }
      const body = (await res.json()) as { results?: RepoRewardsResult[] };
      return {
        results: toSearchResults(body.results ?? []),
        endpoint: base,
        unreachableReason: null,
      };
    } catch (err) {
      failures.push(`${base} → ${String((err as Error)?.message ?? err).slice(0, 120)}`);
    }
  }

  return {
    results: [],
    endpoint: null,
    unreachableReason: `Repo Rewards unreachable (${failures.join("; ")})`,
  };
}
