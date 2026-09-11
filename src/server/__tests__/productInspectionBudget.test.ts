import { afterEach, describe, expect, it, vi } from "vitest";
import type { Architecture, ProductSpec } from "../../shared/schemas.js";
import type { WebFetchResult } from "../tools/webFetch.js";

/**
 * Live run db900aba (2026-09-11): 23 product candidates were discovered but
 * only the top 10 were ever fetched; failed pages consumed the budget and the
 * remaining 13 were never tried, so the five-product floor was unreachable.
 * Failed inspections must be replaced by further ranked candidates.
 */
const domains = Array.from({ length: 20 }, (_, index) => `rival-${index + 1}.example`);

vi.mock("../tools/repoRewards.js", () => ({
  repoRewardsSearch: vi.fn(async () => ({
    endpoint: "https://repo-rewards.example",
    results: [],
  })),
}));

vi.mock("../tools/webSearch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools/webSearch.js")>();
  return {
    ...actual,
    webSearch: vi.fn(async () => ({
      provider: "duckduckgo",
      status: "ok",
      attempts: [
        {
          provider: "duckduckgo",
          status: "ok",
          resultCount: domains.length,
          detail: "ok",
        },
      ],
      results: domains.map((domain, index) => ({
        title: `Rival ${index + 1} habit tracker`,
        url: `https://${domain}/`,
        snippet: `Rival ${index + 1} habit tracker keeps daily streaks and weekly summaries.`,
      })),
    })),
  };
});

const fetched: string[] = [];
vi.mock("../tools/webFetch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools/webFetch.js")>();
  return {
    ...actual,
    webFetchTool: vi.fn(async (url: string): Promise<WebFetchResult> => {
      fetched.push(url);
      const host = new URL(url).hostname;
      const number = Number(/rival-(\d+)/.exec(host)?.[1] ?? 0);
      // The first eleven ranked pages are dead; later ones are real products.
      if (fetched.length <= 11) {
        return {
          ok: false,
          status: 503,
          contentType: "text/html",
          finalUrl: url,
          textExcerpt: "",
          error: "HTTP 503",
        };
      }
      return {
        ok: true,
        status: 200,
        contentType: "text/html",
        finalUrl: url,
        textExcerpt: `Rival ${number} is a habit tracker with daily check-ins, current and best streaks, reminders, and a weekly summary of every habit you build.`,
      };
    }),
  };
});

const spec: ProductSpec = {
  appName: "Habit Hub",
  tagline: "Local habit tracker",
  targetUser: "people building daily habits",
  coreFeatures: ["daily habit check-ins", "streak tracking", "weekly summary"],
  dataModel: [],
  userFlows: ["check off a habit"],
  acceptanceCriteria: ["streaks are computed from check-ins"],
};
const arch: Architecture = {
  overview: "Local habit tracker",
  frontend: "Browser UI",
  backend: "Express API",
  dataModel: "Habits and check-ins",
  risks: [],
};

afterEach(() => {
  fetched.length = 0;
});

describe("product inspection budget", () => {
  it("keeps inspecting ranked candidates past failed pages until five products verify", async () => {
    const { buildCompetitiveDossier, MIN_PRODUCT_COMPETITORS } =
      await import("../tools/competitiveIntelligence.js");
    const dossier = await buildCompetitiveDossier(spec, arch, {
      productQueries: ["habit tracker competitors"],
    });
    expect(dossier.coverage.productVerifiedCount).toBeGreaterThanOrEqual(
      MIN_PRODUCT_COMPETITORS,
    );
    expect(dossier.coverage.productCoverageMet).toBe(true);
    // It stopped once the floor was met instead of fetching every candidate.
    expect(fetched.length).toBeLessThan(domains.length);
  });
});
