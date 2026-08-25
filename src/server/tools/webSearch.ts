/**
 * webSearch.ts — bounded, provider-aware web search.
 *
 * Firecrawl v2 is attempted first. FIRECRAWL_API_KEY is optional: when it is
 * absent the same endpoint is called keylessly, because Firecrawl may permit
 * anonymous access for the deployment/account in use. DuckDuckGo Lite is the
 * fallback. Neither provider is ever represented by a fabricated "manual
 * search" result; callers receive an honest empty/failed status and the
 * attempt-level source health needed for an audit trail.
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export type WebSearchProvider = "firecrawl" | "duckduckgo";
export type SearchAttemptStatus = "ok" | "empty" | "failed" | "skipped";

export interface SearchAttempt {
  provider: WebSearchProvider;
  status: SearchAttemptStatus;
  resultCount: number;
  detail: string;
}

export interface WebSearchResponse {
  results: SearchResult[];
  provider: WebSearchProvider | null;
  status: "ok" | "empty" | "failed";
  attempts: SearchAttempt[];
}

export interface WebSearchOptions {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  firecrawlUrl?: string;
  timeoutMs?: number;
}

const FIRECRAWL_SEARCH_URL = "https://api.firecrawl.dev/v2/search";
const SEARCH_TIMEOUT_MS = 12_000;
const MAX_RESULTS = 8;
const MAX_FIRECRAWL_RESPONSE_BYTES = 2_000_000;
const MAX_DDG_RESPONSE_BYTES = 1_000_000;

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  // Some injected test/self-hosted fetch implementations expose text() but no
  // Web stream. Real undici responses take the streaming path below.
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new Error(`response exceeded ${maxBytes} bytes`);
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (total + next.value.byteLength > maxBytes) {
        await reader.cancel("search response exceeded byte limit").catch(() => {});
        throw new Error(`response exceeded ${maxBytes} bytes`);
      }
      chunks.push(next.value);
      total += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "").trim();
}

function isHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function uniqueResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const result of results) {
    const url = result.url.trim();
    if (!isHttpUrl(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({
      title: result.title.trim() || url,
      url,
      snippet: result.snippet.trim(),
    });
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}

/** Parse DuckDuckGo Lite's HTML result table into structured results. */
export function parseDdgLiteHtml(html: string): SearchResult[] {
  const titleRe = /class='result-link'[^>]*>([^<]+)<\/a>/g;
  const hrefRe = /href="[^"]*[?&]uddg=([^&"]+)[^"]*"\s+class='result-link'/g;
  const snippetRe = /<td\s+class='result-snippet'>\s*([\s\S]*?)\s*<\/td>/g;

  const titles: string[] = [];
  const urls: string[] = [];
  const snippets: string[] = [];

  let m: RegExpExecArray | null;
  while ((m = titleRe.exec(html))) titles.push(m[1].trim());
  while ((m = hrefRe.exec(html))) {
    try {
      urls.push(decodeURIComponent(m[1]));
    } catch {
      urls.push(m[1]);
    }
  }
  while ((m = snippetRe.exec(html))) snippets.push(stripTags(m[1]));

  const count = Math.min(titles.length, urls.length, MAX_RESULTS);
  const results: SearchResult[] = [];
  for (let i = 0; i < count; i++) {
    results.push({ title: titles[i], url: urls[i], snippet: snippets[i] ?? "" });
  }
  return uniqueResults(results);
}

interface FirecrawlSearchItem {
  title?: unknown;
  url?: unknown;
  description?: unknown;
  snippet?: unknown;
  markdown?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Parse the Firecrawl v2 search response. The API's current shape is
 * data.web[], while data[] is accepted for compatibility with self-hosted or
 * transitional v2 deployments.
 */
export function parseFirecrawlSearchResponse(body: unknown): SearchResult[] {
  const root = asRecord(body);
  if (!root || root.success === false) return [];
  const data = root.data;
  let items: unknown[] = [];
  if (Array.isArray(data)) {
    items = data;
  } else {
    const dataRecord = asRecord(data);
    if (Array.isArray(dataRecord?.web)) items = dataRecord.web;
  }
  if (!items.length && Array.isArray(root.web)) items = root.web;

  return uniqueResults(
    items.flatMap((item) => {
      const record = asRecord(item) as FirecrawlSearchItem | null;
      if (!record || typeof record.url !== "string") return [];
      const description =
        typeof record.description === "string"
          ? record.description
          : typeof record.snippet === "string"
            ? record.snippet
            : typeof record.markdown === "string"
              ? record.markdown.slice(0, 500)
              : "";
      return [
        {
          title: typeof record.title === "string" ? record.title : record.url,
          url: record.url,
          snippet: description,
        },
      ];
    }),
  );
}

async function searchFirecrawl(
  query: string,
  opts: Required<
    Pick<WebSearchOptions, "fetchImpl" | "env" | "firecrawlUrl" | "timeoutMs">
  >,
): Promise<{ results: SearchResult[]; attempt: SearchAttempt }> {
  const apiKey = opts.env.FIRECRAWL_API_KEY?.trim() || "";
  const authMode = apiKey ? "authenticated" : "keyless";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  try {
    const response = await opts.fetchImpl(opts.firecrawlUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query,
        limit: MAX_RESULTS,
        sources: ["web"],
        safe: true,
        timeout: opts.timeoutMs,
        // Firecrawl v2 expects formats under scrapeOptions. Markdown gives
        // downstream research an evidence-bearing excerpt while the parser
        // still accepts the lighter title/description-only response.
        scrapeOptions: {
          formats: [{ type: "markdown" }],
          onlyMainContent: true,
        },
      }),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    if (!response.ok) {
      return {
        results: [],
        attempt: {
          provider: "firecrawl",
          status: "failed",
          resultCount: 0,
          detail: `${authMode} Firecrawl v2 returned HTTP ${response.status}`,
        },
      };
    }
    let body: unknown;
    try {
      body = JSON.parse(await readBoundedText(response, MAX_FIRECRAWL_RESPONSE_BYTES));
    } catch {
      return {
        results: [],
        attempt: {
          provider: "firecrawl",
          status: "failed",
          resultCount: 0,
          detail: `${authMode} Firecrawl v2 returned invalid or oversized JSON`,
        },
      };
    }
    const root = asRecord(body);
    if (root?.success === false) {
      return {
        results: [],
        attempt: {
          provider: "firecrawl",
          status: "failed",
          resultCount: 0,
          detail: `${authMode} Firecrawl v2 reported failure`,
        },
      };
    }
    const results = parseFirecrawlSearchResponse(body);
    return {
      results,
      attempt: {
        provider: "firecrawl",
        status: results.length ? "ok" : "empty",
        resultCount: results.length,
        detail: `${authMode} Firecrawl v2 returned ${results.length} result(s)`,
      },
    };
  } catch (err) {
    return {
      results: [],
      attempt: {
        provider: "firecrawl",
        status: "failed",
        resultCount: 0,
        detail: `${authMode} Firecrawl v2 failed (${err instanceof Error ? err.message : String(err)})`,
      },
    };
  }
}

async function searchDuckDuckGo(
  query: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ results: SearchResult[]; attempt: SearchAttempt }> {
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!response.ok) {
      return {
        results: [],
        attempt: {
          provider: "duckduckgo",
          status: "failed",
          resultCount: 0,
          detail: `DuckDuckGo Lite returned HTTP ${response.status}`,
        },
      };
    }
    const results = parseDdgLiteHtml(
      await readBoundedText(response, MAX_DDG_RESPONSE_BYTES),
    );
    return {
      results,
      attempt: {
        provider: "duckduckgo",
        status: results.length ? "ok" : "empty",
        resultCount: results.length,
        detail: `DuckDuckGo Lite returned ${results.length} result(s)`,
      },
    };
  } catch (err) {
    return {
      results: [],
      attempt: {
        provider: "duckduckgo",
        status: "failed",
        resultCount: 0,
        detail: `DuckDuckGo Lite failed (${err instanceof Error ? err.message : String(err)})`,
      },
    };
  }
}

/** Firecrawl-first search with an honest DuckDuckGo fallback. */
export async function webSearch(
  query: string,
  options: WebSearchOptions = {},
): Promise<WebSearchResponse> {
  const opts = {
    fetchImpl: options.fetchImpl ?? fetch,
    env: options.env ?? process.env,
    firecrawlUrl: options.firecrawlUrl ?? FIRECRAWL_SEARCH_URL,
    timeoutMs: options.timeoutMs ?? SEARCH_TIMEOUT_MS,
  };
  const firecrawl = await searchFirecrawl(query, opts);
  if (firecrawl.results.length) {
    return {
      results: firecrawl.results,
      provider: "firecrawl",
      status: "ok",
      attempts: [
        firecrawl.attempt,
        {
          provider: "duckduckgo",
          status: "skipped",
          resultCount: 0,
          detail: "Firecrawl returned results; fallback was not needed",
        },
      ],
    };
  }

  const duckduckgo = await searchDuckDuckGo(query, opts.fetchImpl, opts.timeoutMs);
  if (duckduckgo.results.length) {
    return {
      results: duckduckgo.results,
      provider: "duckduckgo",
      status: "ok",
      attempts: [firecrawl.attempt, duckduckgo.attempt],
    };
  }

  const attempts = [firecrawl.attempt, duckduckgo.attempt];
  return {
    results: [],
    provider: null,
    status: attempts.every((attempt) => attempt.status === "failed")
      ? "failed"
      : "empty",
    attempts,
  };
}

/**
 * Compatibility wrapper for callers that only need results. It deliberately
 * returns [] on empty/failure; source health is available through webSearch.
 */
export async function webSearchTool(query: string): Promise<SearchResult[]> {
  return (await webSearch(query)).results;
}
