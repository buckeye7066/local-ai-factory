import { describe, expect, it } from "vitest";
import { webFetchTool } from "../tools/webFetch.js";
import {
  isMeaningfulProductEvidence,
  isMeaningfulProductMetadataEvidence,
} from "../tools/competitiveIntelligence.js";

/**
 * Live run db900aba (2026-09-11): habitica.com, done.co, habitshareapp.com and
 * streakapp.org were dropped as "unverifiable" because they ship many
 * stylesheets, large CSS bundles, or @import. The page arrived COMPLETE; only
 * its CSS could not be evaluated inside the safety bounds. Body text must stay
 * fail-closed (CSS could hide any of it), but head metadata — never rendered,
 * so CSS cannot hide or fake it — must still be able to prove the product.
 */
const lookup = async () => [{ address: "93.184.216.34", family: 4 }] as const;
const description =
  "Habitica is a free habit building and productivity app that treats your real life like a game, with rewards and punishments to motivate you and a strong social network.";
const head =
  '<head><meta property="og:title" content="Habitica - Gamify Your Life">' +
  `<meta name="description" content="${description}">`;
const context = { candidateKey: "habitica.com", title: "Habitica - Gamify Your Life" };
const discovery = "Habitica gamified habit tracker and to-do list";

function site(html: string, css: (path: string) => Response) {
  return async (input: string | URL | Request) => {
    const url =
      input instanceof URL
        ? input
        : new URL(typeof input === "string" ? input : input.url);
    if (url.pathname.endsWith(".css")) return css(url.pathname);
    return new Response(html, {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  };
}
const cssOk = (body: string) =>
  new Response(body, { status: 200, headers: { "content-type": "text/css" } });

describe("complete product pages whose CSS cannot be evaluated safely", () => {
  it.each([
    [
      "more than eight stylesheets",
      head +
        Array.from(
          { length: 12 },
          (_, i) => `<link rel="stylesheet" href="/s${i}.css">`,
        ).join("") +
        '</head><body><div class="x">Habitica body claim</div></body>',
      () => cssOk(".a{color:red}"),
      /too many stylesheets/i,
    ],
    [
      "a stylesheet bundle over the byte budget",
      head +
        '<link rel="stylesheet" href="/app.css"></head><body><p>Habitica body claim</p></body>',
      () => cssOk(".a{color:red}\n".repeat(20_000)),
      /byte budget/i,
    ],
    [
      "a CSS @import",
      head +
        '<style>@import url("/theme.css");</style></head><body><p>Habitica body claim</p></body>',
      () => cssOk(".a{color:red}"),
      /import/i,
    ],
  ])(
    "keeps body text closed but proves identity from head metadata (%s)",
    async (_label, html, css, reason) => {
      const result = await webFetchTool("https://habitica.com/", 5_000, {
        lookup,
        fetch: site(html as string, css as (p: string) => Response),
      });
      expect(result.error).toMatch(reason as RegExp);
      expect(result).toMatchObject({
        ok: false,
        status: 200,
        textExcerpt: "",
        visibilityUnverifiable: true,
      });
      expect(result.metadataExcerpt).toContain("Habitica");
      // Body text never becomes evidence.
      expect(isMeaningfulProductEvidence(result, context)).toBe(false);
      expect(isMeaningfulProductMetadataEvidence(result, context, discovery)).toBe(
        true,
      );
    },
  );

  it("does not accept metadata from a page whose own request failed", async () => {
    const result = await webFetchTool("https://habitica.com/", 5_000, {
      lookup,
      fetch: async () =>
        new Response(head + "</head><body></body>", {
          status: 403,
          headers: { "content-type": "text/html" },
        }),
    });
    expect(isMeaningfulProductMetadataEvidence(result, context, discovery)).toBe(false);
  });

  it("still requires independent discovery agreement for CSS-unverifiable pages", async () => {
    const html =
      head +
      Array.from(
        { length: 12 },
        (_, i) => `<link rel="stylesheet" href="/s${i}.css">`,
      ).join("") +
      "</head><body></body>";
    const result = await webFetchTool("https://habitica.com/", 5_000, {
      lookup,
      fetch: site(html, () => cssOk("")),
    });
    expect(
      isMeaningfulProductMetadataEvidence(
        result,
        context,
        "an unrelated search snippet",
      ),
    ).toBe(false);
  });
});
