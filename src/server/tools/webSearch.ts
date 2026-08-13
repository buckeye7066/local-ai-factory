/**
 * webSearch.ts — genuine, keyless web search.
 *
 * "If there is a tool out there that it can use, it can find it and use it to
 * properly build the thing." That needs a real search step, not just fetching
 * a URL the owner already dropped in — and it needs to work TODAY without the
 * owner provisioning a new paid search API key.
 *
 * Technique mirrors a proven, already-working keyless pattern on this machine
 * (Ellie's `orchestrator/src/services/internet.js`): DuckDuckGo Lite's plain
 * HTML endpoint, fetched with a normal browser User-Agent (DDG Lite blocks
 * headless-browser-shaped requests but serves a plain `fetch` fine), parsed
 * with regex rather than a DOM library. No API key, no account, no cost.
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const SEARCH_TIMEOUT_MS = 12_000;
const MAX_RESULTS = 8;

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "").trim();
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
  return results;
}

/**
 * Real, live web search. Degrades to a single pseudo-result pointing at a
 * manual DDG search link on any failure (network error, non-2xx, zero
 * parsed results) rather than throwing — a research step should never abort
 * the whole run just because search had a bad moment.
 */
export async function webSearchTool(query: string): Promise<SearchResult[]> {
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!res.ok) throw new Error(`DDG returned ${res.status}`);
    const html = await res.text();
    const results = parseDdgLiteHtml(html);
    if (results.length === 0) throw new Error("no results parsed");
    return results;
  } catch (err) {
    return [
      {
        title: query,
        url: `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
        snippet: `Web search failed (${err instanceof Error ? err.message : String(err)}) — manual search link provided instead.`,
      },
    ];
  }
}
