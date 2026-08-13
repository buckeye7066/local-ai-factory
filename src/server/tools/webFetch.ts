/**
 * webFetch.ts — the resolver agent's "real internet access" tool.
 *
 * Deliberately narrow: GET only, bounded size/time, text extracted and
 * clipped. This is enough to let the resolver look at what a URL actually IS
 * (a GitHub repo page? a raw README? a random webpage?) before deciding to
 * clone/ingest it — "don't fetch/execute anything from a URL blindly without
 * at least reading what it actually is first."
 */

export interface WebFetchResult {
  ok: boolean;
  status: number;
  contentType: string;
  finalUrl: string;
  textExcerpt: string;
  error?: string;
}

const MAX_BYTES = 200_000;
const MAX_EXCERPT = 4000;

function isHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Strip HTML tags/scripts down to readable text for the excerpt. */
function toReadableText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function webFetchTool(
  url: string,
  timeoutMs = 15_000,
): Promise<WebFetchResult> {
  if (!isHttpUrl(url)) {
    return {
      ok: false,
      status: 0,
      contentType: "",
      finalUrl: url,
      textExcerpt: "",
      error: "Not an http(s) URL.",
    };
  }
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "factory-deck-resolver/1.0" },
    });
    const contentType = res.headers.get("content-type") ?? "";
    const buf = await res.arrayBuffer();
    const bytes = buf.byteLength > MAX_BYTES ? buf.slice(0, MAX_BYTES) : buf;
    const raw = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const text = contentType.includes("html") ? toReadableText(raw) : raw;
    return {
      ok: res.ok,
      status: res.status,
      contentType,
      finalUrl: res.url || url,
      textExcerpt: text.slice(0, MAX_EXCERPT),
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      contentType: "",
      finalUrl: url,
      textExcerpt: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** True when a URL looks like a clonable repo (github/gitlab/codeberg/bitbucket/etc.). */
export function looksLikeRepoUrl(url: string): boolean {
  if (!isHttpUrl(url)) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return /github\.com|gitlab\.com|codeberg\.org|bitbucket\.org|gitea|sourceforge\.net/.test(
      host,
    );
  } catch {
    return false;
  }
}

/** Extract the first http(s) URL found in free text, if any. */
export function extractFirstUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s)"'<>]+/);
  return m ? m[0].replace(/[.,;:!?]+$/, "") : null;
}

/** Extract EVERY distinct http(s) URL found in free text — for multi-program prompts. */
export function extractAllUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s)"'<>]+/g) ?? [];
  return [...new Set(matches.map((u) => u.replace(/[.,;:!?]+$/, "")))];
}
