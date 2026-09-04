import { lookup as dnsLookup } from "node:dns/promises";
import { randomUUID } from "node:crypto";
import { decodeHtmlEntities } from "./htmlEntities.js";
import { BlockList, isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { Window, type CSSRule, type CSSStyleDeclaration } from "happy-dom";

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
const MAX_STYLESHEETS = 8;
const MAX_STYLESHEET_BYTES = 200_000;
const MAX_STYLED_ELEMENTS = 5_000;
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

type FetchedHttpResource = {
  response: Response;
  finalUrl: URL;
};

async function fetchHttpResource(
  initialUrl: URL,
  signal: AbortSignal,
  fetchImpl: WebFetchDependencies["fetch"],
  lookup: NonNullable<WebFetchDependencies["lookup"]>,
  transport: NonNullable<WebFetchDependencies["transport"]>,
): Promise<FetchedHttpResource> {
  let current = new URL(initialUrl);
  for (let redirects = 0; ; redirects += 1) {
    const addresses = await assertPublicTarget(current, lookup, signal);
    const response = fetchImpl
      ? await fetchImpl(current, {
          method: "GET",
          redirect: "manual",
          signal,
          headers: { "user-agent": "factory-deck-resolver/1.0" },
        })
      : await transport(current, addresses, signal);
    if (!REDIRECT_STATUSES.has(response.status)) {
      return { response, finalUrl: current };
    }

    const location = response.headers.get("location");
    if (!location) throw new Error(`Redirect ${response.status} omitted Location.`);
    if (redirects >= MAX_REDIRECTS) {
      throw new Error(`Too many redirects (maximum ${MAX_REDIRECTS}).`);
    }
    current = new URL(location, current);
    if (!isHttpUrl(current.href)) {
      throw new Error("Redirect target is not an http(s) URL.");
    }
    await response.body?.cancel("following validated redirect").catch(() => {});
  }
}

async function readBoundedBody(
  response: Response,
  maxBytes = MAX_BYTES,
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
      const remaining = maxBytes - total;
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

const NON_RENDERED_ELEMENTS = new Set([
  "canvas",
  "datalist",
  "embed",
  "head",
  "iframe",
  "map",
  "noscript",
  "object",
  "script",
  "style",
  "svg",
  "template",
  "title",
]);

const BLOCK_ELEMENTS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "dd",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

function decodeCssEscapes(value: string): string {
  // A backslash followed by a CSS newline is a continuation and contributes
  // no character. Remove it before decoding ordinary simple/hex escapes.
  return value
    .replace(/\\(?:\r\n|[\n\r\f])/g, "")
    .replace(
      /\\([0-9a-f]{1,6})(?:\r\n|[ \t\r\n\f])?|\\([^\r\n\f0-9a-f])/gi,
      (_escape, hex: string | undefined, escaped: string | undefined) => {
        if (escaped) return escaped;
        const codePoint = Number.parseInt(hex ?? "", 16);
        if (
          !Number.isSafeInteger(codePoint) ||
          codePoint <= 0 ||
          codePoint > 0x10ffff ||
          (codePoint >= 0xd800 && codePoint <= 0xdfff)
        ) {
          return "\uFFFD";
        }
        return String.fromCodePoint(codePoint);
      },
    );
}

type HtmlAttribute = {
  name: string;
  value: string;
};

function actualTagAttributes(rawTag: string): HtmlAttribute[] {
  const opening = rawTag.match(/^<\s*[a-z][\w:-]*/i);
  if (!opening) return [];

  const attributes: HtmlAttribute[] = [];
  let cursor = opening[0].length;
  while (cursor < rawTag.length) {
    while (/\s/.test(rawTag[cursor] ?? "")) cursor += 1;
    const current = rawTag[cursor];
    if (!current || current === ">" || /^\/\s*>/.test(rawTag.slice(cursor))) break;

    const nameStart = cursor;
    while (cursor < rawTag.length && !/[\s=\/>]/.test(rawTag[cursor] ?? "")) {
      cursor += 1;
    }
    if (cursor === nameStart) {
      cursor += 1;
      continue;
    }

    const name = rawTag.slice(nameStart, cursor).toLowerCase();
    while (/\s/.test(rawTag[cursor] ?? "")) cursor += 1;
    let rawValue = "";
    if (rawTag[cursor] === "=") {
      cursor += 1;
      while (/\s/.test(rawTag[cursor] ?? "")) cursor += 1;
      const quote = rawTag[cursor];
      if (quote === '"' || quote === "'") {
        cursor += 1;
        const valueStart = cursor;
        while (cursor < rawTag.length && rawTag[cursor] !== quote) cursor += 1;
        rawValue = rawTag.slice(valueStart, cursor);
        if (rawTag[cursor] === quote) cursor += 1;
      } else {
        const valueStart = cursor;
        while (cursor < rawTag.length && !/[\s>]/.test(rawTag[cursor] ?? "")) {
          cursor += 1;
        }
        rawValue = rawTag.slice(valueStart, cursor);
      }
    }

    // Browsers decode one character-reference layer in attribute values before
    // CSS and ARIA semantics are evaluated. A second layer stays literal.
    attributes.push({ name, value: decodeHtmlEntities(rawValue) });
  }
  return attributes;
}

function openingTagSuppressesText(tag: string, rawTag: string): boolean {
  if (NON_RENDERED_ELEMENTS.has(tag)) return true;
  const attributes = actualTagAttributes(rawTag);
  if (attributes.some(({ name }) => name === "hidden" || name === "inert")) {
    return true;
  }
  if (
    attributes.some(
      ({ name, value }) =>
        name === "aria-hidden" && value.trim().toLowerCase() === "true",
    )
  ) {
    return true;
  }

  const styles = attributes
    .filter(({ name }) => name === "style")
    .map(({ value }) => decodeCssEscapes(value.replace(/\/\*[\s\S]*?\*\//g, "")));
  // An unterminated CSS comment makes the remainder of the declaration
  // non-authoritative. Suppress rather than guessing that it renders.
  if (styles.some((style) => style.includes("/*"))) return true;
  return styles.some(declarationBlockSuppressesText);
}

function cssZero(value: string): boolean {
  const normalized = value.trim();
  return normalized.length > 0 && /^[-+]?(?:0+|0*\.0+)(?:[a-z]+|%)?$/i.test(normalized);
}

function transformCollapsesText(value: string): boolean {
  const normalized = value.toLowerCase().replace(/\s+/g, "");
  if (!normalized || normalized === "none") return false;
  const scale = normalized.match(/(?:^|\))scale\(([^)]+)\)/)?.[1]?.split(",");
  if (
    /(?:^|\))scale(?:x|y)?\([-+]?0*(?:\.0+)?\)/.test(normalized) ||
    (scale !== undefined && scale.slice(0, 2).some(cssZero)) ||
    (/(?:^|\))scale3d\([^,]+,[^,]+,[^)]+\)/.test(normalized) &&
      normalized
        .match(/scale3d\(([^)]+)\)/)?.[1]
        ?.split(",")
        .slice(0, 2)
        .some(cssZero))
  ) {
    return true;
  }
  const matrix = normalized.match(/matrix\(([^)]+)\)/)?.[1]?.split(",");
  if (matrix?.length === 6) {
    const [a, b, c, d] = matrix.slice(0, 4).map(Number);
    if ([a, b, c, d].every(Number.isFinite) && Math.abs(a! * d! - b! * c!) === 0) {
      return true;
    }
  }
  return false;
}

function clipRemovesText(property: string, value: string): boolean {
  const normalized = value.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized || normalized === "none" || normalized === "auto") return false;
  if (property === "clip") {
    const values = normalized
      .match(/^rect\((.*)\)$/)?.[1]
      ?.split(/[\s,]+/)
      .filter(Boolean);
    return values?.length === 4 && values.every(cssZero);
  }
  return (
    /^inset\(\s*(?:50|100)%/.test(normalized) ||
    /^(?:circle|ellipse)\(\s*0(?:[a-z]+|%)?\b/.test(normalized) ||
    /^polygon\(\s*(?:0(?:[a-z]+|%)?\s+0(?:[a-z]+|%)?\s*,?\s*)+\)$/.test(normalized)
  );
}

function propertyValuesSuppressText(get: (property: string) => string): boolean {
  const display = get("display").trim().toLowerCase();
  const visibility = get("visibility").trim().toLowerCase();
  const contentVisibility = get("content-visibility").trim().toLowerCase();
  const opacity = get("opacity").trim();
  const filter = get("filter").toLowerCase().replace(/\s+/g, "");
  const color = get("color").trim().toLowerCase();
  const textFill = get("-webkit-text-fill-color").trim().toLowerCase();
  const overflow = `${get("overflow")} ${get("overflow-x")} ${get("overflow-y")}`
    .trim()
    .toLowerCase();
  const zeroSizedAndClipped =
    cssZero(get("width")) &&
    cssZero(get("height")) &&
    /\b(?:clip|hidden)\b/.test(overflow);
  return (
    display === "none" ||
    visibility === "hidden" ||
    visibility === "collapse" ||
    contentVisibility === "hidden" ||
    (opacity !== "" && Number.parseFloat(opacity) <= 0) ||
    /opacity\([-+]?(?:0+|0*\.0+)%?\)/.test(filter) ||
    transformCollapsesText(get("transform")) ||
    clipRemovesText("clip", get("clip")) ||
    clipRemovesText("clip-path", get("clip-path")) ||
    color === "transparent" ||
    textFill === "transparent" ||
    cssZero(get("font-size")) ||
    zeroSizedAndClipped
  );
}

function declarationBlockSuppressesText(style: string): boolean {
  const declarations = new Map<string, string>();
  for (const declaration of style.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator < 0) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration
      .slice(separator + 1)
      .replace(/\s*!important\s*$/i, "")
      .trim();
    if (property) declarations.set(property, value);
  }
  return propertyValuesSuppressText((property) => declarations.get(property) ?? "");
}

function styleDeclarationSuppressesText(style: CSSStyleDeclaration): boolean {
  return propertyValuesSuppressText((property) => style.getPropertyValue(property));
}

type HtmlMarkupToken = {
  start: number;
  end: number;
  raw: string;
  tag?: string;
  closing?: boolean;
  slashClosed?: boolean;
};

const RAW_TEXT_ELEMENTS = new Set([
  "iframe",
  "noembed",
  "noframes",
  "script",
  "style",
  "title",
  "textarea",
  "xmp",
]);

function quotedTagEnd(html: string, start: number): number {
  let quote = "";
  for (let index = start + 1; index < html.length; index += 1) {
    const char = html[index]!;
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return index + 1;
    }
  }
  // Treat an unterminated tag as markup through EOF. Failing closed is safer
  // than promoting malformed attributes or hidden payloads into evidence.
  return html.length;
}

function nextHtmlMarkup(
  html: string,
  from: number,
  xmlMode = false,
): HtmlMarkupToken | null {
  for (
    let start = html.indexOf("<", from);
    start >= 0;
    start = html.indexOf("<", start + 1)
  ) {
    if (html.startsWith("<!--", start)) {
      const commentEnd = html.indexOf("-->", start + 4);
      const end = commentEnd < 0 ? html.length : commentEnd + 3;
      return { start, end, raw: html.slice(start, end) };
    }

    // HTML uses a bogus-comment terminator; XHTML honors the complete XML
    // processing-instruction terminator so quoted angle brackets stay hidden.
    if (html.startsWith("<?", start)) {
      const terminator = xmlMode ? "?>" : ">";
      const bogusEnd = html.indexOf(terminator, start + 2);
      const end = bogusEnd < 0 ? html.length : bogusEnd + terminator.length;
      return { start, end, raw: html.slice(start, end) };
    }

    if (html.startsWith("<!", start)) {
      const end = quotedTagEnd(html, start);
      return { start, end, raw: html.slice(start, end) };
    }

    const prefix = html.slice(start).match(/^<\s*(\/?)\s*([a-z][\w:-]*)\b/i);
    if (!prefix) continue;
    const end = quotedTagEnd(html, start);
    const raw = html.slice(start, end);
    return {
      start,
      end,
      raw,
      tag: prefix[2]!.toLowerCase(),
      closing: prefix[1] === "/",
      slashClosed: /\/\s*>$/.test(raw),
    };
  }
  return null;
}

type HtmlStylesheetScan = {
  instrumentedHtml: string;
  markerAttribute: string;
  markerCount: number;
  embeddedStyles: string[];
  stylesheetLinks: string[];
  baseHref?: string;
};

function scanHtmlStylesheets(html: string, xmlMode: boolean): HtmlStylesheetScan {
  const markerAttribute = `data-factory-node-${randomUUID().replaceAll("-", "")}`;
  const embeddedStyles: string[] = [];
  const stylesheetLinks: string[] = [];
  let baseHref: string | undefined;
  let markerCount = 0;
  let emittedThrough = 0;
  let searchFrom = 0;
  let rawTextTag: string | undefined;
  let rawTextStart = 0;
  let instrumentedHtml = "";

  for (
    let markup = nextHtmlMarkup(html, searchFrom, xmlMode);
    markup;
    markup = nextHtmlMarkup(html, searchFrom, xmlMode)
  ) {
    searchFrom = markup.end;
    const tag = markup.tag;
    if (rawTextTag) {
      if (!tag || !markup.closing || tag !== rawTextTag) continue;
      if (rawTextTag === "style") {
        embeddedStyles.push(html.slice(rawTextStart, markup.start));
      }
      rawTextTag = undefined;
    }

    instrumentedHtml += html.slice(emittedThrough, markup.start);
    let raw = markup.raw;
    if (tag && !markup.closing) {
      const attributes = actualTagAttributes(raw);
      if (tag === "base" && baseHref === undefined) {
        baseHref = attributes.find(({ name }) => name === "href")?.value;
      }
      if (
        tag === "link" &&
        attributes.some(
          ({ name, value }) =>
            name === "rel" && value.toLowerCase().split(/\s+/).includes("stylesheet"),
        )
      ) {
        const href = attributes.find(({ name }) => name === "href")?.value;
        if (href) stylesheetLinks.push(href);
      }

      // Linked styles are fetched above through the address-pinned transport
      // and applied as inert text. Never give happy-dom the original <link>:
      // rel=preload/modulepreload and future link types can initiate their own
      // network requests while the untrusted document is connected.
      if (tag === "link") raw = "";

      const ending = raw.match(/\/?\s*>$/);
      if (ending?.index !== undefined) {
        const marker = String(markerCount);
        markerCount += 1;
        raw = `${raw.slice(0, ending.index)} ${markerAttribute}="${marker}"${raw.slice(
          ending.index,
        )}`;
      }
      if (RAW_TEXT_ELEMENTS.has(tag)) {
        rawTextTag = tag;
        rawTextStart = markup.end;
      }
    }
    instrumentedHtml += raw;
    emittedThrough = markup.end;
  }

  if (rawTextTag === "style") {
    embeddedStyles.push(html.slice(rawTextStart));
  }
  instrumentedHtml += html.slice(emittedThrough);
  return {
    instrumentedHtml,
    markerAttribute,
    markerCount,
    embeddedStyles,
    stylesheetLinks,
    baseHref,
  };
}

function cssForConservativeRendering(css: string): string {
  return decodeCssEscapes(css.replace(/\/\*[\s\S]*?\*\//g, ""));
}

function hasUnresolvedStylesheetImport(css: string): boolean {
  return /@import\b/i.test(cssForConservativeRendering(css));
}

function potentiallyHiddenSelectors(window: Window): string[] {
  const selectors: string[] = [];
  const visit = (rule: CSSRule): void => {
    if ("selectorText" in rule && "style" in rule) {
      const styleRule = rule as CSSRule & {
        selectorText: string;
        style: CSSStyleDeclaration;
      };
      if (styleDeclarationSuppressesText(styleRule.style)) {
        selectors.push(styleRule.selectorText);
      }
    }
    if ("cssRules" in rule) {
      for (const child of (rule as CSSRule & { cssRules: CSSRule[] }).cssRules) {
        visit(child);
      }
    }
  };
  for (const sheet of Array.from(window.document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules)) visit(rule);
  }
  return selectors;
}

function stylesheetSuppressedNodes(
  scan: HtmlStylesheetScan,
  externalStyles: readonly string[],
  finalUrl: URL,
): ReadonlySet<string> {
  if (scan.markerCount > MAX_STYLED_ELEMENTS) {
    throw new Error(
      `HTML contains too many styled elements (maximum ${MAX_STYLED_ELEMENTS}).`,
    );
  }

  const styles = [...scan.embeddedStyles, ...externalStyles];
  if (styles.some(hasUnresolvedStylesheetImport)) {
    throw new Error("Stylesheet imports cannot be verified safely.");
  }

  const window = new Window({
    url: finalUrl.href,
    settings: {
      disableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      disableIframePageLoading: true,
      handleDisabledFileLoadingAsSuccess: true,
      // Computed-style evaluation does not need network access. Intercept all
      // asynchronous and synchronous resource requests in case a current or
      // future DOM element tries to load beyond the explicitly vetted CSS
      // path above.
      fetch: {
        interceptor: {
          beforeAsyncRequest: async ({ window: resourceWindow }) =>
            new resourceWindow.Response("", {
              status: 200,
              statusText: "Blocked DOM resource",
            }),
          beforeSyncRequest: ({ window: resourceWindow, request }) => ({
            status: 204,
            statusText: "Blocked DOM resource",
            ok: true,
            url: request.url,
            redirected: false,
            headers: new resourceWindow.Headers(),
            body: null,
          }),
        },
      },
      navigation: {
        disableMainFrameNavigation: true,
        disableChildFrameNavigation: true,
        disableChildPageNavigation: true,
        disableFallbackToSetURL: true,
      },
    },
  });
  try {
    window.document.write(scan.instrumentedHtml);
    const styleCopies = [...externalStyles, ...styles.map(cssForConservativeRendering)];
    for (const css of styleCopies) {
      const style = window.document.createElement("style");
      style.textContent = css;
      window.document.head.append(style);
    }

    // A page can hide evidence only in a conditional group such as @media,
    // @supports, @container, or @layer. The extractor has no authoritative
    // user viewport/capability profile, so treat every directly hidden selector
    // as potentially active. This can conservatively omit visible text, but it
    // cannot promote a conditionally hidden claim into production evidence.
    const conditionalVisibility = potentiallyHiddenSelectors(window);
    if (conditionalVisibility.length > 0) {
      const style = window.document.createElement("style");
      style.textContent = conditionalVisibility
        .map((selector) => `${selector} { display: none !important; }`)
        .join("\n");
      window.document.head.append(style);
    }

    const suppressed = new Set<string>();
    for (const element of window.document.querySelectorAll(
      `[${scan.markerAttribute}]`,
    )) {
      const marker = element.getAttribute(scan.markerAttribute);
      if (marker === null) continue;
      const computed = window.getComputedStyle(element);
      if (styleDeclarationSuppressesText(computed)) {
        suppressed.add(marker);
      }
    }
    return suppressed;
  } finally {
    window.close();
  }
}

async function loadExternalStylesheets(
  scan: HtmlStylesheetScan,
  pageUrl: URL,
  signal: AbortSignal,
  fetchImpl: WebFetchDependencies["fetch"],
  lookup: NonNullable<WebFetchDependencies["lookup"]>,
  transport: NonNullable<WebFetchDependencies["transport"]>,
): Promise<string[]> {
  let baseUrl = pageUrl;
  if (scan.baseHref) {
    baseUrl = new URL(scan.baseHref, pageUrl);
    if (!isHttpUrl(baseUrl.href)) {
      throw new Error("Stylesheet base URL is not an http(s) URL.");
    }
  }

  const stylesheetUrls = [
    ...new Set(
      scan.stylesheetLinks.map((href) => {
        const stylesheetUrl = new URL(href, baseUrl);
        if (!isHttpUrl(stylesheetUrl.href)) {
          throw new Error("Stylesheet URL is not an http(s) URL.");
        }
        return stylesheetUrl.href;
      }),
    ),
  ];
  if (stylesheetUrls.length > MAX_STYLESHEETS) {
    throw new Error(
      `HTML references too many stylesheets (maximum ${MAX_STYLESHEETS}).`,
    );
  }

  const styles: string[] = [];
  let totalBytes = 0;
  for (const href of stylesheetUrls) {
    const fetched = await fetchHttpResource(
      new URL(href),
      signal,
      fetchImpl,
      lookup,
      transport,
    );
    const contentType = fetched.response.headers.get("content-type")?.toLowerCase();
    if (!fetched.response.ok) {
      await fetched.response.body?.cancel("stylesheet request failed").catch(() => {});
      throw new Error(
        `Stylesheet request failed with status ${fetched.response.status}.`,
      );
    }
    if (!contentType?.includes("text/css")) {
      await fetched.response.body
        ?.cancel("stylesheet response had an invalid content type")
        .catch(() => {});
      throw new Error("Stylesheet response is not text/css.");
    }
    const remaining = MAX_STYLESHEET_BYTES - totalBytes;
    if (remaining <= 0) {
      await fetched.response.body
        ?.cancel("stylesheet byte budget exhausted")
        .catch(() => {});
      throw new Error("Stylesheet responses exceeded the byte budget.");
    }
    const bounded = await readBoundedBody(fetched.response, remaining);
    if (bounded.truncated) {
      throw new Error("Stylesheet responses exceeded the byte budget.");
    }
    totalBytes += bounded.bytes.byteLength;
    styles.push(new TextDecoder("utf-8", { fatal: false }).decode(bounded.bytes));
  }
  return styles;
}

/** Extract visible/readable HTML text without promoting hidden page payloads. */
function toReadableText(
  html: string,
  xmlSelfClosing = false,
  stylesheetMarkers?: {
    attribute: string;
    suppressed: ReadonlySet<string>;
  },
): string {
  const stack: Array<{ tag: string; suppressed: boolean; rawText: boolean }> = [];
  let suppressedDepth = 0;
  let cursor = 0;
  let readable = "";

  for (
    let markup = nextHtmlMarkup(html, cursor, xmlSelfClosing);
    markup;
    markup = nextHtmlMarkup(html, cursor, xmlSelfClosing)
  ) {
    if (suppressedDepth === 0) readable += html.slice(cursor, markup.start);
    cursor = markup.end;
    const tag = markup.tag;
    if (!tag) continue;

    const rawTag = markup.raw;
    const top = stack.at(-1);
    // Markup-looking bytes inside raw-text elements cannot close an ancestor
    // or create rendered evidence.
    if (suppressedDepth > 0 && top?.rawText && !(markup.closing && top.tag === tag)) {
      continue;
    }
    if (markup.closing) {
      if (suppressedDepth > 0) {
        // Fail closed on misnested closers inside a hidden subtree. Only the
        // current hidden frame may close.
        if (!top || top.tag !== tag) continue;
        const entry = stack.pop()!;
        if (entry.suppressed) suppressedDepth -= 1;
        if (suppressedDepth === 0 && BLOCK_ELEMENTS.has(tag)) readable += "\n";
        continue;
      }
      const index = stack.map((entry) => entry.tag).lastIndexOf(tag);
      if (index >= 0) {
        for (const entry of stack.splice(index)) {
          if (entry.suppressed) suppressedDepth -= 1;
        }
      }
      if (suppressedDepth === 0 && BLOCK_ELEMENTS.has(tag)) readable += "\n";
      continue;
    }

    const parentSuppressed = suppressedDepth > 0;
    const attributes = stylesheetMarkers ? actualTagAttributes(rawTag) : [];
    const stylesheetSuppressed = attributes.some(
      ({ name, value }) =>
        name === stylesheetMarkers?.attribute &&
        stylesheetMarkers.suppressed.has(value),
    );
    const suppressed =
      parentSuppressed || stylesheetSuppressed || openingTagSuppressesText(tag, rawTag);
    // In text/html, a trailing slash does not self-close ordinary elements;
    // XHTML served as XML does honor it. HTML void elements close in either
    // mode.
    const selfClosing =
      VOID_ELEMENTS.has(tag) || (xmlSelfClosing && markup.slashClosed === true);
    if (!selfClosing) {
      stack.push({ tag, suppressed, rawText: RAW_TEXT_ELEMENTS.has(tag) });
      if (suppressed) suppressedDepth += 1;
    }
    if (!suppressed && (BLOCK_ELEMENTS.has(tag) || tag === "br" || tag === "hr")) {
      readable += "\n";
    }
  }
  if (suppressedDepth === 0) readable += html.slice(cursor);

  return decodeHtmlEntities(readable)
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
    const fetched = await fetchHttpResource(
      new URL(url),
      signal,
      fetchImpl,
      lookup,
      transport,
    );
    const contentType = fetched.response.headers.get("content-type") ?? "";
    const bounded = await readBoundedBody(fetched.response);
    const raw = new TextDecoder("utf-8", { fatal: false }).decode(bounded.bytes);
    const normalizedContentType = contentType.toLowerCase();
    let text = raw;
    if (normalizedContentType.includes("html")) {
      // Visibility and attribution are properties of the complete document.
      // A stylesheet after the byte boundary can hide a claim that appears in
      // the retained prefix, so partial HTML must never become evidence text.
      if (bounded.truncated) {
        return {
          ok: false,
          status: fetched.response.status,
          contentType,
          finalUrl: fetched.finalUrl.href,
          textExcerpt: "",
          truncated: true,
          error: "HTML response exceeded the byte limit and cannot be verified safely.",
        };
      }
      const xmlMode = normalizedContentType.includes("xhtml");
      const scan = scanHtmlStylesheets(raw, xmlMode);
      if (scan.embeddedStyles.length > 0 || scan.stylesheetLinks.length > 0) {
        const externalStyles = await loadExternalStylesheets(
          scan,
          fetched.finalUrl,
          signal,
          fetchImpl,
          lookup,
          transport,
        );
        const suppressed = stylesheetSuppressedNodes(
          scan,
          externalStyles,
          fetched.finalUrl,
        );
        text = toReadableText(scan.instrumentedHtml, xmlMode, {
          attribute: scan.markerAttribute,
          suppressed,
        });
      } else {
        text = toReadableText(raw, xmlMode);
      }
    }
    return {
      ok: fetched.response.ok,
      status: fetched.response.status,
      contentType,
      finalUrl: fetched.finalUrl.href,
      textExcerpt: text.slice(0, MAX_EXCERPT),
      truncated: bounded.truncated,
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
