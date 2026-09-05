from pathlib import Path

web_path = Path("src/server/tools/webFetch.ts")
web = web_path.read_text()
old = '''  const values: string[] = [];
  let cursor = 0;
  let inHead = false;
  let headClosed = false;
  for (
    let markup = nextHtmlMarkup(html, cursor, false);
    markup;
    markup = nextHtmlMarkup(html, cursor, false)
  ) {
    cursor = markup.end;
    if (markup.tag === "head") {
      if (markup.closing) {
        inHead = false;
        headClosed = true;
      } else if (!headClosed) {
        inHead = true;
      }
      continue;
    }
    if (!inHead || headClosed) continue;
    if (markup.closing || markup.tag !== "meta" || !markup.raw.trimEnd().endsWith(">"))
      continue;'''
new = '''  const values: string[] = [];
  let cursor = 0;
  let inHead = false;
  let headClosed = false;
  let rawTextTag: string | undefined;
  for (
    let markup = nextHtmlMarkup(html, cursor, false);
    markup;
    markup = nextHtmlMarkup(html, cursor, false)
  ) {
    cursor = markup.end;
    if (rawTextTag) {
      if (markup.closing && markup.tag === rawTextTag) rawTextTag = undefined;
      continue;
    }
    if (markup.tag === "head") {
      if (markup.closing) {
        inHead = false;
        headClosed = true;
      } else if (!headClosed) {
        inHead = true;
      }
      continue;
    }
    if (!inHead || headClosed) continue;
    if (markup.tag && !markup.closing && RAW_TEXT_ELEMENTS.has(markup.tag)) {
      rawTextTag = markup.tag;
      continue;
    }
    if (markup.closing || markup.tag !== "meta" || !markup.raw.trimEnd().endsWith(">"))
      continue;'''
if web.count(old) != 1:
    raise SystemExit(f"webFetch anchor count={web.count(old)}")
web_path.write_text(web.replace(old, new))

ci_path = Path("src/server/tools/competitiveIntelligence.ts")
ci = ci_path.read_text()
insert_anchor = "\nfunction sourceHealthFromAttempts(\n"
if ci.count(insert_anchor) != 1:
    raise SystemExit(f"metadata verifier insertion anchor count={ci.count(insert_anchor)}")
metadata_verifier = r'''

/**
 * Verify product identity from completed document metadata without pretending a
 * truncated HTML body was complete. Metadata is accepted only as a separate,
 * dual-source identity signal: the fetched page must be a same-domain 2xx HTML
 * response, contain multiple completed head metadata fields, avoid known
 * challenge/parking/login markers, and agree with independent discovery text.
 */
export function isMeaningfulProductMetadataEvidence(
  result: WebFetchResult,
  context: ProductEvidenceContext,
  discoveryText: string,
): boolean {
  const metadata = (result.metadataExcerpt ?? "").trim();
  if (
    result.truncated !== true ||
    result.status < 200 ||
    result.status >= 300 ||
    !/^text\/html(?:\s*;|$)/i.test(result.contentType.trim()) ||
    metadata.length < MIN_PRODUCT_EVIDENCE_CHARS
  ) {
    return false;
  }

  const fields = [...new Set(metadata.split(/\n+/).map((value) => value.trim()).filter(Boolean))];
  if (fields.length < 2) return false;

  const finalKey = productDomainKeyFromUrl(result.finalUrl);
  if (!finalKey || finalKey !== context.candidateKey) return false;
  try {
    if (/\/(?:auth|login|sign-?in)(?:\/|$)/i.test(new URL(result.finalUrl).pathname)) {
      return false;
    }
  } catch {
    return false;
  }

  if (
    /\b(?:buy this domain|domain (?:is )?for sale|parked domain|verify you are human|captcha|checking your browser|access denied|sign in to continue|log in to continue)\b/i.test(
      metadata,
    )
  ) {
    return false;
  }

  const brand = context.candidateKey.split(".")[0] ?? "";
  const relevanceTokens = [brand, ...context.title.split(/[^a-z0-9]+/i)]
    .map((token) => token.toLowerCase())
    .filter(
      (token, index, all) =>
        token.length >= 2 &&
        !GENERIC_PRODUCT_WORDS.has(token) &&
        all.indexOf(token) === index,
    );
  if (!relevanceTokens.length) return false;

  const lowerMetadata = metadata.toLowerCase();
  const lowerDiscovery = discoveryText.toLowerCase();
  return (
    relevanceTokens.some((token) => lowerMetadata.includes(token)) &&
    relevanceTokens.some((token) => lowerDiscovery.includes(token))
  );
}
'''
ci = ci.replace(insert_anchor, metadata_verifier + insert_anchor)

old_callback = '''      const fetched = await webFetchTool(candidate.url);
      // Never reinterpret truncated body text as complete. A separate view may
      // validate completed document metadata because that metadata was itself
      // wholly present before the byte boundary. Keep the original fetch for
      // audit/truncation reporting.
      const evidenceText = fetched.textExcerpt || fetched.metadataExcerpt || "";
      const metadataOnly =
        !fetched.ok &&
        fetched.truncated === true &&
        fetched.status >= 200 &&
        fetched.status < 300 &&
        Boolean(fetched.metadataExcerpt);
      const evidenceFetch = metadataOnly
        ? {
            ...fetched,
            ok: true,
            textExcerpt: evidenceText,
            truncated: false,
            error: undefined,
          }
        : fetched;
      const meaningful = isMeaningfulProductEvidence(evidenceFetch, {
        candidateKey: key,
        title: candidate.title,
      });'''
new_callback = '''      const fetched = await webFetchTool(candidate.url);
      const context = { candidateKey: key, title: candidate.title };
      const pageMeaningful = isMeaningfulProductEvidence(fetched, context);
      const metadataMeaningful = isMeaningfulProductMetadataEvidence(
        fetched,
        context,
        `${candidate.title}\n${candidate.snippet}`,
      );
      const meaningful = pageMeaningful || metadataMeaningful;
      const evidenceText = pageMeaningful
        ? fetched.textExcerpt
        : metadataMeaningful
          ? (fetched.metadataExcerpt ?? "")
          : "";'''
if ci.count(old_callback) != 1:
    raise SystemExit(f"competitive callback anchor count={ci.count(old_callback)}")
ci = ci.replace(old_callback, new_callback)
ci = ci.replace('path: "product-page",', 'path: pageMeaningful ? "product-page" : "product-metadata+discovery",')
ci_path.write_text(ci)

test_path = Path("src/server/__tests__/oversizedProductMetadataEvidence.test.ts")
test = test_path.read_text()
test = test.replace(
    'import { isMeaningfulProductEvidence } from "../tools/competitiveIntelligence.js";',
    'import {\n  isMeaningfulProductEvidence,\n  isMeaningfulProductMetadataEvidence,\n} from "../tools/competitiveIntelligence.js";',
)
start = test.index('const metadataView =')
end = test.index('\n\ndescribe(', start)
test = test[:start] + test[end + 2:]
test = test.replace(
    '''    expect(\n      isMeaningfulProductEvidence(metadataView(result), {\n        candidateKey: "todoist.com",\n        title: "Todoist task manager",\n      }),\n    ).toBe(true);''',
    '''    expect(\n      isMeaningfulProductMetadataEvidence(\n        result,\n        { candidateKey: "todoist.com", title: "Todoist task manager" },\n        "Todoist task manager for organizing projects and collaborative work",\n      ),\n    ).toBe(true);''',
)
test = test.replace(
    '''    expect(\n      isMeaningfulProductEvidence(metadataView(result), {\n        candidateKey: "todoist.com",\n        title: "Todoist",\n      }),\n    ).toBe(false);''',
    '''    expect(\n      isMeaningfulProductMetadataEvidence(\n        result,\n        { candidateKey: "todoist.com", title: "Todoist" },\n        "Todoist task manager",\n      ),\n    ).toBe(false);''',
)
# The same old assertion appears twice; replace both.
test = test.replace(
    '''    expect(\n      isMeaningfulProductEvidence(metadataView(result), {\n        candidateKey: "todoist.com",\n        title: "Todoist",\n      }),\n    ).toBe(false);''',
    '''    expect(\n      isMeaningfulProductMetadataEvidence(\n        result,\n        { candidateKey: "todoist.com", title: "Todoist" },\n        "Todoist task manager",\n      ),\n    ).toBe(false);''',
)
extra_anchor = '\n  it("does not promote an incomplete metadata tag at the byte boundary", async () => {'
extra = r'''

  it("ignores product-looking meta markup embedded inside head scripts", async () => {
    const html =
      '<html><head><meta property="og:title" content="Todoist"><script>' +
      '<meta name="description" content="Todoist organizes tasks projects deadlines priorities and collaboration across devices">' +
      '</script></head><body>' +
      "x".repeat(220_000) +
      "</body></html>";
    const result = await webFetchTool("https://www.todoist.com/", 15_000, {
      lookup: publicLookup,
      fetch: async () =>
        new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
    });
    expect(result).toMatchObject({ truncated: true, metadataExcerpt: "Todoist" });
    expect(
      isMeaningfulProductMetadataEvidence(
        result,
        { candidateKey: "todoist.com", title: "Todoist" },
        "Todoist task manager",
      ),
    ).toBe(false);
  });

  it("rejects challenge metadata even when independent discovery names the product", () => {
    expect(
      isMeaningfulProductMetadataEvidence(
        {
          ok: false,
          status: 200,
          contentType: "text/html; charset=utf-8",
          finalUrl: "https://www.todoist.com/",
          textExcerpt: "",
          metadataExcerpt:
            "Todoist task manager\nVerify you are human to continue. Checking your browser before accessing Todoist.",
          truncated: true,
          error: "HTML response exceeded the byte limit and cannot be verified safely.",
        },
        { candidateKey: "todoist.com", title: "Todoist task manager" },
        "Todoist task manager for organizing projects",
      ),
    ).toBe(false);
  });
'''
if test.count(extra_anchor) != 1:
    raise SystemExit(f"test extra anchor count={test.count(extra_anchor)}")
test = test.replace(extra_anchor, extra + extra_anchor)
test_path.write_text(test)
