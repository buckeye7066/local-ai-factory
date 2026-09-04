import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

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
  /** True when the response body exceeded the network byte budget. */
  truncated?: boolean;
  error?: string;
}

const MAX_BYTES = 200_000;
const MAX_EXCERPT = 4000;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface LookupAddress {
  address: string;
  family: number;
}

export interface WebFetchDependencies {
  fetch?: typeof globalThis.fetch;
  lookup?: (hostname: string) => Promise<readonly LookupAddress[]>;
  /** Test seam for the production address-pinned transport. */
  transport?: (
    url: URL,
    addresses: readonly LookupAddress[],
    signal: AbortSignal,
  ) => Promise<Response>;
}

const blockedIpv4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedIpv4.addSubnet(network, prefix, "ipv4");
}
const blockedIpv6 = new BlockList();
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::", 96],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001::", 32],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  blockedIpv6.addSubnet(network, prefix, "ipv6");
}
const globalIpv6 = new BlockList();
globalIpv6.addSubnet("2000::", 3, "ipv6");

function normalizedHostname(url: URL): string {
  return url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
}

function isPublicAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/g, "").split("%")[0]!;
  const family = isIP(normalized);
  if (family === 4) return !blockedIpv4.check(normalized, "ipv4");
  if (family === 6) {
    return (
      globalIpv6.check(normalized, "ipv6") && !blockedIpv6.check(normalized, "ipv6")
    );
  }
  return false;
}

async function defaultLookup(hostname: string): Promise<LookupAddress[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

async function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

async function assertPublicTarget(
  url: URL,
  lookup: NonNullable<WebFetchDependencies["lookup"]>,
  signal: AbortSignal,
): Promise<readonly LookupAddress[]> {
  if (url.username || url.password) {
    throw new Error("URLs containing credentials are not allowed.");
  }
  const hostname = normalizedHostname(url);
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home.arpa")
  ) {
    throw new Error("Local or private hostnames are not allowed.");
  }

  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await withAbort(lookup(hostname), signal);
  if (addresses.length === 0) {
    throw new Error(`Hostname did not resolve: ${hostname}`);
  }
  const unsafe = addresses.find((entry) => !isPublicAddress(entry.address));
  if (unsafe) {
    throw new Error(
      `Refused non-public network target for ${hostname}: ${unsafe.address}`,
    );
  }
  return addresses;
}

/**
 * Connect to an already validated address while preserving HTTP Host and TLS
 * SNI/certificate verification for the original hostname. Ordinary fetch
 * would resolve the hostname a second time and reopen DNS-rebinding SSRF.
 */
async function pinnedFetch(
  url: URL,
  addresses: readonly LookupAddress[],
  signal: AbortSignal,
): Promise<Response> {
  const originalHost = normalizedHostname(url);
  const selected = addresses.find((entry) => entry.family === 4) ?? addresses[0];
  if (!selected) throw new Error(`Hostname did not resolve: ${originalHost}`);
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise<Response>((resolve, reject) => {
    const req = request(
      {
        protocol: url.protocol,
        hostname: selected.address,
        family: selected.family,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: {
          Host: url.host,
          "user-agent": "factory-deck-resolver/1.0",
        },
        servername: isIP(originalHost) ? undefined : originalHost,
        signal,
      },
      (incoming) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) headers.append(name, item);
          } else if (value !== undefined) {
            headers.set(name, String(value));
          }
        }
        const status = incoming.statusCode ?? 500;
        const body =
          status === 204 || status === 304
            ? null
            : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>);
        resolve(
          new Response(body, {
            status,
            statusText: incoming.statusMessage,
            headers,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function readBoundedBody(
  response: Response,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      const remaining = MAX_BYTES - total;
      if (chunk.byteLength > remaining) {
        if (remaining > 0) {
          chunks.push(chunk.subarray(0, remaining));
          total += remaining;
        }
        truncated = true;
        await reader.cancel("response exceeded byte limit").catch(() => {});
        break;
      }
      chunks.push(chunk);
      total += chunk.byteLength;
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
  return { bytes, truncated };
}

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
    .replace(/<(?:br|hr)\b[^>]*\/?>/gi, "\n")
    .replace(
      /<\/?(?:address|article|aside|blockquote|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)\b[^>]*>/gi,
      "\n",
    )
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/ *\r?\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export async function webFetchTool(
  url: string,
  timeoutMs = 15_000,
  dependencies: WebFetchDependencies = {},
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
    const fetchImpl = dependencies.fetch;
    const lookup = dependencies.lookup ?? defaultLookup;
    const transport = dependencies.transport ?? pinnedFetch;
    const signal = AbortSignal.timeout(timeoutMs);
    let current = new URL(url);

    for (let redirects = 0; ; redirects += 1) {
      const addresses = await assertPublicTarget(current, lookup, signal);
      const res = fetchImpl
        ? await fetchImpl(current, {
            method: "GET",
            redirect: "manual",
            signal,
            headers: { "user-agent": "factory-deck-resolver/1.0" },
          })
        : await transport(current, addresses, signal);
      if (REDIRECT_STATUSES.has(res.status)) {
        const location = res.headers.get("location");
        if (!location) throw new Error(`Redirect ${res.status} omitted Location.`);
        if (redirects >= MAX_REDIRECTS) {
          throw new Error(`Too many redirects (maximum ${MAX_REDIRECTS}).`);
        }
        current = new URL(location, current);
        if (!isHttpUrl(current.href)) {
          throw new Error("Redirect target is not an http(s) URL.");
        }
        await res.body?.cancel("following validated redirect").catch(() => {});
        continue;
      }

      const contentType = res.headers.get("content-type") ?? "";
      const bounded = await readBoundedBody(res);
      const raw = new TextDecoder("utf-8", { fatal: false }).decode(bounded.bytes);
      const text = contentType.includes("html") ? toReadableText(raw) : raw;
      return {
        ok: res.ok,
        status: res.status,
        contentType,
        finalUrl: current.href,
        textExcerpt: text.slice(0, MAX_EXCERPT),
        truncated: bounded.truncated,
      };
    }
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
