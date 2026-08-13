import { describe, it, expect, afterEach, vi } from "vitest";
import { parseDdgLiteHtml, webSearchTool } from "../tools/webSearch.js";
import { extractAllUrls, looksLikeRepoUrl } from "../tools/webFetch.js";
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

describe("webSearchTool (fetch stubbed — no real network)", () => {
  it("returns parsed results on a successful response", async () => {
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
    const results = await webSearchTool("weather api");
    expect(results).toHaveLength(2);
    expect(results[0].url).toBe("https://example.com/weatherapi");
  });

  it("degrades to a manual-search pseudo-result on a network failure — never throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network unreachable");
      }),
    );
    const results = await webSearchTool("anything");
    expect(results).toHaveLength(1);
    expect(results[0].url).toContain("duckduckgo.com/?q=");
    expect(results[0].snippet).toContain("network unreachable");
  });

  it("degrades gracefully on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({ ok: false, status: 503, text: async () => "" }) as unknown as Response,
      ),
    );
    const results = await webSearchTool("anything");
    expect(results[0].snippet).toContain("503");
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
  constructor(private script: unknown[]) {}
  isConfigured() {
    return true;
  }
  async generateText() {
    return { text: "", provider: this.name };
  }
  async generateJson<T>(input: GenerateJsonInput<T>): Promise<T> {
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
