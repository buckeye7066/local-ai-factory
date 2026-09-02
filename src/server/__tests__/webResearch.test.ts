import { describe, it, expect, afterEach, vi } from "vitest";
import {
  parseDdgLiteHtml,
  parseFirecrawlSearchResponse,
  webSearch,
} from "../tools/webSearch.js";
import {
  extractAllUrls,
  looksLikeRepoUrl,
  webFetchTool,
  type WebFetchDependencies,
} from "../tools/webFetch.js";
import { researchAgent, type ResearchFindings } from "../agents/researchAgent.js";
import type { LLMProvider, GenerateJsonInput } from "../../shared/types.js";
import type { ProductSpec, Architecture } from "../../shared/schemas.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

// A real (trimmed) snippet of DuckDuckGo Lite's actual result-table HTML shape,
// used to prove the parser against the real markup structure rather than a
// structure invented for the test.
const SAMPLE_DDG_HTML = `
<html><body><table>
<tr class="result-link"><td>
  <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fweatherapi&amp;rut=abc" class='result-link'>Example Weather API</a>
</td></tr>
<tr class="result-snippet"><td class='result-snippet'>A free, keyless <b>weather API</b> for developers.</td></tr>
<tr class="result-link"><td>
  <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fdocs&amp;rut=def" class='result-link'>Example Docs</a>
</td></tr>
<tr class="result-snippet"><td class='result-snippet'>Documentation for the Example project.</td></tr>
</table></body></html>
`;

describe("parseDdgLiteHtml", () => {
  it("parses titles, decoded uddg-wrapped urls, and snippets from real DDG Lite markup", () => {
    const results = parseDdgLiteHtml(SAMPLE_DDG_HTML);
    expect(results).toHaveLength(2);
    expect(results[0].title).toBe("Example Weather API");
    expect(results[0].url).toBe("https://example.com/weatherapi");
    expect(results[0].snippet).toContain("weather API");
    expect(results[1].url).toBe("https://example.org/docs");
  });

  it("returns an empty array for markup with no results", () => {
    expect(parseDdgLiteHtml("<html><body>no results</body></html>")).toEqual([]);
  });
});

describe("webSearch provider health (fetch stubbed — no real network)", () => {
  it("parses the current Firecrawl v2 data.web response", () => {
    expect(
      parseFirecrawlSearchResponse({
        success: true,
        data: {
          web: [
            {
              title: "Factory",
              url: "https://factory.example/product",
              description: "Evidence-backed delivery",
              markdown: "# Factory",
            },
          ],
        },
      }),
    ).toEqual([
      {
        title: "Factory",
        url: "https://factory.example/product",
        snippet: "Evidence-backed delivery",
      },
    ]);
  });

  it("uses authenticated Firecrawl v2 first with the documented scrapeOptions shape", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            web: [
              {
                title: "Example",
                url: "https://example.com/product",
                description: "A product",
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const searched = await webSearch("agent product", {
      fetchImpl,
      env: { FIRECRAWL_API_KEY: "fc-test" } as NodeJS.ProcessEnv,
      firecrawlUrl: "https://firecrawl.test/v2/search",
    });

    expect(searched.provider).toBe("firecrawl");
    expect(searched.results).toHaveLength(1);
    expect(searched.attempts.map((attempt) => attempt.status)).toEqual([
      "ok",
      "skipped",
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0];
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fc-test");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      query: "agent product",
      sources: ["web"],
      scrapeOptions: {
        formats: [{ type: "markdown" }],
        onlyMainContent: true,
      },
    });
  });

  it("attempts Firecrawl keylessly, then falls back to DuckDuckGo", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(new Response(SAMPLE_DDG_HTML, { status: 200 }));
    const searched = await webSearch("weather api", {
      fetchImpl,
      env: {} as NodeJS.ProcessEnv,
      firecrawlUrl: "https://firecrawl.test/v2/search",
    });

    expect(searched.provider).toBe("duckduckgo");
    expect(searched.results).toHaveLength(2);
    expect(searched.attempts.map((attempt) => attempt.status)).toEqual([
      "failed",
      "ok",
    ]);
    expect(new Headers(fetchImpl.mock.calls[0][1]?.headers).has("Authorization")).toBe(
      false,
    );
  });

  it("returns honest failure with no fabricated manual-search result", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    const searched = await webSearch("anything", {
      fetchImpl,
      env: {} as NodeJS.ProcessEnv,
    });

    expect(searched).toMatchObject({ results: [], provider: null, status: "failed" });
    expect(searched.attempts).toHaveLength(2);
    expect(searched.attempts.every((attempt) => attempt.status === "failed")).toBe(
      true,
    );
  });

  it("distinguishes an honest empty response from provider failure", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, data: { web: [] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response("<html>no results</html>", { status: 200 }));
    const searched = await webSearch("nothing", {
      fetchImpl,
      env: {} as NodeJS.ProcessEnv,
    });

    expect(searched).toMatchObject({ results: [], provider: null, status: "empty" });
    expect(searched.attempts.map((attempt) => attempt.status)).toEqual([
      "empty",
      "empty",
    ]);
  });

  it("fails an oversized Firecrawl response without buffering it as evidence", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("x".repeat(2_100_000), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response("<html>no results</html>", { status: 200 }));

    const searched = await webSearch("bounded response", {
      fetchImpl,
      env: {} as NodeJS.ProcessEnv,
    });

    expect(searched.results).toEqual([]);
    expect(searched.attempts[0]).toMatchObject({
      provider: "firecrawl",
      status: "failed",
    });
    expect(searched.attempts[0].detail).toMatch(/oversized/i);
  });
});

describe("extractAllUrls", () => {
  it("extracts every distinct URL, for multi-program prompt detection", () => {
    const urls = extractAllUrls(
      "combine https://github.com/a/repo1 and https://github.com/b/repo2 into one app",
    );
    expect(urls).toEqual(["https://github.com/a/repo1", "https://github.com/b/repo2"]);
  });
  it("de-dupes repeated URLs", () => {
    expect(extractAllUrls("see https://x.com and again https://x.com")).toEqual([
      "https://x.com",
    ]);
  });
  it("returns an empty array with no URLs", () => {
    expect(extractAllUrls("no urls here")).toEqual([]);
  });
});

describe("looksLikeRepoUrl", () => {
  it("recognizes known git hosts", () => {
    expect(looksLikeRepoUrl("https://github.com/foo/bar")).toBe(true);
    expect(looksLikeRepoUrl("https://gitlab.com/foo/bar")).toBe(true);
  });
  it("rejects an arbitrary non-repo URL — those become fetch-based reference material instead", () => {
    expect(looksLikeRepoUrl("https://example.com/some/docs/page")).toBe(false);
  });
});

describe("webFetchTool network boundary", () => {
  const publicLookup: NonNullable<WebFetchDependencies["lookup"]> = async () => [
    { address: "93.184.216.34", family: 4 },
  ];

  it.each([
    "http://127.0.0.1/admin",
    "http://2130706433/admin",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/admin",
    "http://[::ffff:127.0.0.1]/admin",
  ])("refuses private or local address %s before fetch", async (url) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await webFetchTool(url, 1_000, { fetch: fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/non-public|private|local/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a public hostname when DNS returns any private address", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await webFetchTool("https://example.com", 1_000, {
      fetch: fetchImpl,
      lookup: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.7", family: 4 },
      ],
    });
    expect(result.error).toContain("10.0.0.7");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("passes the validated address to the pinned transport without a second lookup", async () => {
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    const transport: NonNullable<WebFetchDependencies["transport"]> = vi.fn(
      async (_url, addresses) => {
        expect(addresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
        return new Response("Pinned public response", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      },
    );

    const result = await webFetchTool("https://example.com/product", 1_000, {
      lookup,
      transport,
    });

    expect(result.ok).toBe(true);
    expect(result.textExcerpt).toBe("Pinned public response");
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("includes DNS resolution inside the caller's timeout budget", async () => {
    const started = Date.now();
    const result = await webFetchTool("https://example.com/product", 20, {
      lookup: async () => new Promise(() => {}),
      transport: async () => new Response("must not run"),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/abort|timeout/i);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("revalidates every redirect and refuses a redirect to metadata", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data" },
      }),
    );
    const result = await webFetchTool("https://example.com/start", 1_000, {
      fetch: fetchImpl,
      lookup: publicLookup,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/non-public/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it("streams only the bounded response prefix", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("x".repeat(210_000), {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );
    const result = await webFetchTool("https://example.com/large", 1_000, {
      fetch: fetchImpl,
      lookup: publicLookup,
    });
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.textExcerpt).toHaveLength(4_000);
  });

  it("fetches a public target and returns readable bounded text", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("<main>Hello <b>world</b></main>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    const result = await webFetchTool("https://example.com/docs", 1_000, {
      fetch: fetchImpl,
      lookup: publicLookup,
    });
    expect(result).toMatchObject({
      ok: true,
      finalUrl: "https://example.com/docs",
      textExcerpt: "Hello world",
      truncated: false,
    });
  });
});

const spec: ProductSpec = {
  appName: "TestApp",
  tagline: "",
  targetUser: "testers",
  coreFeatures: ["feature 1"],
  dataModel: [],
  userFlows: [],
  acceptanceCriteria: ["works"],
};
const arch: Architecture = {
  overview: "o",
  frontend: "f",
  backend: "b",
  dataModel: "d",
  risks: [],
};

class ScriptedProvider implements LLMProvider {
  readonly name = "mock" as const;
  calls = 0;
  readonly prompts: string[] = [];
  readonly systems: string[] = [];
  constructor(private script: unknown[]) {}
  isConfigured() {
    return true;
  }
  async generateText() {
    return { text: "", provider: this.name };
  }
  async generateJson<T>(input: GenerateJsonInput<T>): Promise<T> {
    this.prompts.push(input.prompt);
    this.systems.push(input.system);
    const raw = this.script[this.calls];
    this.calls += 1;
    if (raw === undefined) throw new Error("ScriptedProvider ran out of script.");
    return input.schema.parse(raw) as T;
  }
}

describe("researchAgent", () => {
  it("uses web_search then concludes with real, tool-backed recommendations", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            text: async () => SAMPLE_DDG_HTML,
          }) as unknown as Response,
      ),
    );
    const provider = new ScriptedProvider([
      {
        thought: "check for a weather API",
        action: "web_search",
        query: "weather api",
      },
      {
        thought: "found one",
        action: "conclude",
        findings: {
          summary: "A keyless weather API fits this build.",
          recommendations: [
            {
              name: "Example Weather API",
              why: "free and keyless",
              sourceUrl: "https://example.com/weatherapi",
              howToIntegrate: "GET request, parse JSON response",
            },
          ],
        },
      },
    ]);
    const findings: ResearchFindings = await researchAgent({ provider }, spec, arch);
    expect(findings.recommendations).toHaveLength(1);
    expect(findings.recommendations[0].name).toBe("Example Weather API");
    expect(findings.recommendations[0].evidenceUrls).toEqual([
      "https://example.com/weatherapi",
    ]);
    expect(provider.systems.every((system) => /untrusted data/i.test(system))).toBe(
      true,
    );
  });

  it("drops a model recommendation whose URL was never observed by a tool", async () => {
    const provider = new ScriptedProvider([
      {
        thought: "I already know one",
        action: "conclude",
        findings: {
          summary: "Use a plausible service.",
          recommendations: [
            {
              name: "Invented API",
              why: "sounds useful",
              sourceUrl: "https://invented.example/api",
              howToIntegrate: "send all data",
            },
          ],
        },
      },
    ]);

    const findings = await researchAgent({ provider }, spec, arch);

    expect(findings.recommendations).toEqual([]);
    expect(findings.summary).toMatch(/removed.*not observed/i);
  });

  it("concludes honestly with zero recommendations when nothing external is needed", async () => {
    const provider = new ScriptedProvider([
      {
        thought: "simple app, nothing external needed",
        action: "conclude",
        findings: { summary: "nothing needed", recommendations: [] },
      },
    ]);
    const findings = await researchAgent({ provider }, spec, arch);
    expect(findings.recommendations).toEqual([]);
  });

  it("never loops forever — gives up after the step cap with an honest empty result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({ ok: true, status: 200, text: async () => "" }) as unknown as Response,
      ),
    );
    const infiniteScript = Array.from({ length: 10 }, () => ({
      thought: "still looking",
      action: "web_search",
      query: "x",
    }));
    const provider = new ScriptedProvider(infiniteScript);
    const findings = await researchAgent({ provider }, spec, arch);
    expect(findings.recommendations).toEqual([]);
    expect(findings.summary).toContain("did not reach a conclusion");
  });
});

/**
 * 2026-08-16, live GrantFlow slice: the competitive-selection call failed
 * schema validation and the exception escaped researchAgent, killing the
 * whole run before the builder ran. Research is ADVISORY: a failed selection
 * is a named skip that keeps the base findings and the audit trail.
 */
describe("researchAgent competitive selection failure is a named skip", () => {
  const DOSSIER = {
    queries: ["grant management"],
    sources: [{ name: "github", ok: true, detail: "" }],
    discoveredCount: 1,
    inspectedCount: 1,
    generatedAt: "2026-08-16T00:00:00Z",
    candidates: [
      {
        id: "c1",
        kind: "repository",
        name: "Rival",
        url: "https://example.com/rival",
        description: "",
        stars: 10,
        archived: false,
        updatedAt: "",
        discoveryEvidence: "",
        license: { spdxId: "MIT", policy: "direct-use", evidenceUrl: "" },
        inspectionError: "",
        fileTree: [],
        sourceEvidence: [],
      },
    ],
  };

  const PRODUCT_DISCOVERY_PLAN = {
    queries: [
      "Taskwarrior official website",
      "Todo.txt official website",
      "Todoist official website",
      "Things official website",
      "OmniFocus official website",
    ],
  };

  it("keeps the base findings and audit when selection fails validation", async () => {
    const ci = await import("../tools/competitiveIntelligence.js");
    const spy = vi
      .spyOn(ci, "buildCompetitiveDossier")
      .mockResolvedValue(DOSSIER as never);
    try {
      const provider = new ScriptedProvider([
        // base loop concludes cleanly...
        {
          thought: "nothing external needed",
          action: "conclude",
          findings: { summary: "base summary", recommendations: [] },
        },
        // Product discovery planning is a distinct orchestrator call.
        PRODUCT_DISCOVERY_PLAN,
        // ...then the selection payload is missing `element` -> real ZodError.
        {
          summary: "s",
          comparisons: [],
          selected: [{ candidateId: "c1", why: "missing element" }],
        },
      ]);
      const findings = await researchAgent({ provider }, spec, arch, {
        competitive: true,
      });
      expect(findings.summary).toContain("base summary");
      expect(findings.summary).toContain("FAILED and was SKIPPED");
      expect(findings.recommendations).toEqual([]);
      expect(findings.competitiveAudit?.candidates).toHaveLength(1);
      expect(findings.competitiveAudit?.candidates[0].name).toBe("Rival");
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps valid comparisons when one selected item omits integration prose", async () => {
    const ci = await import("../tools/competitiveIntelligence.js");
    const productUrl = "https://rival.example/product";
    const productDossier = {
      ...DOSSIER,
      coverage: {
        productTarget: 5,
        productDiscoveredCount: 1,
        productInspectedCount: 1,
        productVerifiedCount: 1,
        productCoverageMet: false,
        repositoryDiscoveredCount: 0,
        repositoryInspectedCount: 0,
        repositoryVerifiedCount: 0,
      },
      candidates: [
        {
          ...DOSSIER.candidates[0],
          id: "product:rival.example",
          kind: "product",
          url: productUrl,
          sourceEvidence: [
            { path: "product-page", url: productUrl, excerpt: "Verified behavior." },
          ],
        },
      ],
    };
    const spy = vi
      .spyOn(ci, "buildCompetitiveDossier")
      .mockResolvedValue(productDossier as never);
    try {
      const provider = new ScriptedProvider([
        {
          thought: "nothing external needed",
          action: "conclude",
          findings: { summary: "base summary", recommendations: [] },
        },
        PRODUCT_DISCOVERY_PLAN,
        {
          summary: "comparison complete",
          comparisons: [
            {
              candidateId: "product:rival.example",
              name: "Rival",
              score: 90,
              matchedFeatures: ["fast add"],
              strengths: ["fast capture"],
              gaps: ["no local JSON export"],
              evidenceUrls: [productUrl],
              decision: "adapt",
              rationale: "Useful behavior",
            },
          ],
          selected: [
            {
              candidateId: "product:rival.example",
              element: "single-command task capture",
              why: "reduces input friction",
              reuseMode: "clean-room-pattern",
              evidenceUrls: [productUrl],
              score: 90,
            },
          ],
        },
      ]);
      const findings = await researchAgent({ provider }, spec, arch, {
        competitive: true,
      });
      expect(findings.summary).not.toContain("FAILED and was SKIPPED");
      expect(findings.comparisons).toHaveLength(1);
      expect(findings.recommendations).toHaveLength(1);
      expect(findings.recommendations[0].howToIntegrate).toContain(
        "single-command task capture",
      );
      expect(findings.recommendations[0].howToIntegrate).toContain(
        "direct acceptance tests",
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("a deliberate abort still propagates — a cancelled run is never continued", async () => {
    const ci = await import("../tools/competitiveIntelligence.js");
    const spy = vi
      .spyOn(ci, "buildCompetitiveDossier")
      .mockResolvedValue(DOSSIER as never);
    try {
      const { ProviderAbortError } = await import("../providers/types.js");
      let calls = 0;
      const provider = {
        name: "mock" as const,
        isConfigured: () => true,
        generateText: async () => ({ text: "", provider: "mock" }),
        generateJson: async <T>(input: GenerateJsonInput<T>): Promise<T> => {
          calls++;
          if (calls === 1) {
            return input.schema.parse({
              thought: "",
              action: "conclude",
              findings: { summary: "base", recommendations: [] },
            }) as T;
          }
          throw new ProviderAbortError();
        },
      } as unknown as LLMProvider;
      await expect(
        researchAgent({ provider }, spec, arch, { competitive: true }),
      ).rejects.toThrow(/aborted/);
    } finally {
      spy.mockRestore();
    }
  });
});
