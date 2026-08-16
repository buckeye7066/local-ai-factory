import { describe, expect, it } from "vitest";
import {
  repoRewardsEndpoints,
  repoRewardsSearch,
  toSearchResults,
} from "../tools/repoRewards.js";

/**
 * Owner order 2026-08-16: Factory Deck and the Purpose Foundry use the
 * owner's own Repo Rewards service alongside their web search when hunting
 * competitors. Discovery must never abort a run, and an unreachable source
 * must be reported by name rather than silently dropped.
 */

const jsonResponse = (body: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as Response;

describe("repoRewardsEndpoints", () => {
  it("prefers a local instance, then the owner's production deploy", () => {
    const eps = repoRewardsEndpoints({} as NodeJS.ProcessEnv);
    expect(eps[0]).toBe("http://localhost:3000");
    expect(eps[1]).toMatch(/^https:\/\//);
  });
  it("an explicit URL wins outright and loses trailing slashes", () => {
    const eps = repoRewardsEndpoints({
      FACTORY_REPO_REWARDS_URL: "https://rr.example.test/",
    } as NodeJS.ProcessEnv);
    expect(eps).toEqual(["https://rr.example.test"]);
  });
});

describe("toSearchResults", () => {
  it("maps ranked repos to plain search results and skips URL-less rows", () => {
    const out = toSearchResults([
      {
        repo: {
          fullName: "acme/thing",
          htmlUrl: "https://github.com/acme/thing",
          description: "does the thing",
        },
        reason: "ranked for lesson planning",
      },
      { repo: { fullName: "no/url" } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe("https://github.com/acme/thing");
    expect(out[0].snippet).toMatch(/does the thing — ranked for lesson planning/);
  });
});

describe("repoRewardsSearch", () => {
  it("returns results from the first endpoint that answers", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(String(url));
      return jsonResponse({
        results: [
          { repo: { fullName: "a/b", htmlUrl: "https://github.com/a/b", description: "d" } },
        ],
      });
    }) as unknown as typeof fetch;

    const res = await repoRewardsSearch("lesson planning", {
      fetchImpl,
      env: {} as NodeJS.ProcessEnv,
    });
    expect(res.endpoint).toBe("http://localhost:3000");
    expect(res.results).toHaveLength(1);
    expect(res.unreachableReason).toBeNull();
    expect(calls[0]).toBe("http://localhost:3000/api/search");
  });

  it("falls through to production when the local instance is down", async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("localhost")) throw new Error("ECONNREFUSED");
      return jsonResponse({
        results: [{ repo: { fullName: "a/b", htmlUrl: "https://github.com/a/b" } }],
      });
    }) as unknown as typeof fetch;

    const res = await repoRewardsSearch("q", { fetchImpl, env: {} as NodeJS.ProcessEnv });
    expect(res.endpoint).toMatch(/^https:\/\//);
    expect(res.results).toHaveLength(1);
  });

  it("reports every endpoint failure by name instead of throwing", async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("localhost")) throw new Error("ECONNREFUSED");
      return jsonResponse({ error: "nope" }, 503);
    }) as unknown as typeof fetch;

    const res = await repoRewardsSearch("q", { fetchImpl, env: {} as NodeJS.ProcessEnv });
    expect(res.results).toEqual([]);
    expect(res.endpoint).toBeNull();
    expect(res.unreachableReason).toMatch(/ECONNREFUSED/);
    expect(res.unreachableReason).toMatch(/HTTP 503/);
  });
});
