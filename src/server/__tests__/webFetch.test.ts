import { describe, expect, it, vi } from "vitest";
import { webFetchTool } from "../tools/webFetch.js";

describe("webFetchTool readable HTML extraction", () => {
  it("excludes non-rendered and explicitly hidden content from evidence text", async () => {
    const fetch = vi.fn(async () =>
      Promise.resolve(
        new Response(
          `<html><head><title>Hidden title payload</title></head><body>
            <p>Visible offline synchronization evidence.</p>
            <template>Template-only false claim.</template>
            <noscript>Fallback-only false claim.</noscript>
            <svg><text>Vector-only false claim.</text></svg>
            <div hidden>Hidden-attribute false claim.</div>
            <section aria-hidden="true">Aria-hidden false claim.</section>
            <aside style="display: none !important">Display-none false claim.</aside>
            <p>Visible recovery evidence.</p>
          </body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        ),
      ),
    );

    const result = await webFetchTool("https://evidence.example/product", 1_000, {
      fetch,
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    });

    expect(result.ok).toBe(true);
    expect(result.textExcerpt).toContain("Visible offline synchronization evidence.");
    expect(result.textExcerpt).toContain("Visible recovery evidence.");
    expect(result.textExcerpt).not.toMatch(
      /Hidden title|Template-only|Fallback-only|Vector-only|Hidden-attribute|Aria-hidden|Display-none/,
    );
  });

  it("keeps nested hidden elements suppressed until their outer boundary closes", async () => {
    const fetch = vi.fn(async () =>
      Promise.resolve(
        new Response(
          `<p>Visible before.</p><template>outer <template>inner</template> hidden tail</template><p>Visible after.</p>`,
          { headers: { "content-type": "text/html" } },
        ),
      ),
    );

    const result = await webFetchTool("https://evidence.example/nested", 1_000, {
      fetch,
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    });

    expect(result.textExcerpt).toContain("Visible before.");
    expect(result.textExcerpt).toContain("Visible after.");
    expect(result.textExcerpt).not.toMatch(/outer|inner|hidden tail/);
  });

  it("does not treat an HTML slash as closing a non-void hidden element", async () => {
    const fetch = vi.fn(async () =>
      Promise.resolve(
        new Response(
          `<p>Visible before.</p><template/>slash-hidden payload</template><p>Visible after.</p>`,
          { headers: { "content-type": "text/html" } },
        ),
      ),
    );

    const result = await webFetchTool("https://evidence.example/slash", 1_000, {
      fetch,
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    });

    expect(result.textExcerpt).toContain("Visible before.");
    expect(result.textExcerpt).toContain("Visible after.");
    expect(result.textExcerpt).not.toContain("slash-hidden payload");
  });

  it("drops an unterminated HTML comment instead of treating it as evidence", async () => {
    const fetch = vi.fn(async () =>
      Promise.resolve(
        new Response(`<p>Visible.</p><!-- hidden false claim`, {
          headers: { "content-type": "text/html" },
        }),
      ),
    );

    const result = await webFetchTool("https://evidence.example/comment", 1_000, {
      fetch,
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    });

    expect(result.textExcerpt).toBe("Visible.");
  });

  it("honors quoted angle brackets before recognizing a hidden-element boundary", async () => {
    const fetch = vi.fn(async () =>
      Promise.resolve(
        new Response(
          `<p>Visible before.</p><template data-x="></template>">Hidden feature claim.</template><p>Visible after.</p>`,
          { headers: { "content-type": "text/html" } },
        ),
      ),
    );

    const result = await webFetchTool("https://evidence.example/quoted-tag", 1_000, {
      fetch,
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    });

    expect(result.textExcerpt).toContain("Visible before.");
    expect(result.textExcerpt).toContain("Visible after.");
    expect(result.textExcerpt).not.toContain("Hidden feature claim");
  });

  it.each(["<?Hidden feature claim.>", "<?Hidden feature claim without a terminator"])(
    "discards an HTML bogus comment instead of exposing it: %s",
    async (bogus) => {
      const fetch = vi.fn(async () =>
        Promise.resolve(
          new Response(`<p>Visible.</p>${bogus}`, {
            headers: { "content-type": "text/html" },
          }),
        ),
      );

      const result = await webFetchTool("https://evidence.example/bogus", 1_000, {
        fetch,
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      });

      expect(result.textExcerpt).toBe("Visible.");
    },
  );

  it("normalizes CSS comments before testing whether inline content is hidden", async () => {
    const fetch = vi.fn(async () =>
      Promise.resolve(
        new Response(
          `<p>Visible.</p><div style="display:/**/none">Hidden feature claim.</div>`,
          { headers: { "content-type": "text/html" } },
        ),
      ),
    );

    const result = await webFetchTool("https://evidence.example/css", 1_000, {
      fetch,
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    });

    expect(result.textExcerpt).toBe("Visible.");
  });

  it("decodes CSS escapes before testing whether inline content is hidden", async () => {
    const fetch = vi.fn(async () =>
      Promise.resolve(
        new Response(
          "<p>Visible.</p><div style='display:n\\6f ne'>Hidden feature claim.</div>",
          { headers: { "content-type": "text/html" } },
        ),
      ),
    );

    const result = await webFetchTool("https://evidence.example/css-escape", 1_000, {
      fetch,
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    });

    expect(result.textExcerpt).toBe("Visible.");
  });

  it("decodes HTML entities in real style attributes before visibility checks", async () => {
    const fetch = vi.fn(async () =>
      Promise.resolve(
        new Response(
          `<p>Visible.</p><div style="display&#58;none">Entity-hidden feature claim.</div>`,
          { headers: { "content-type": "text/html" } },
        ),
      ),
    );

    const result = await webFetchTool(
      "https://evidence.example/css-html-entity",
      1_000,
      {
        fetch,
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      },
    );

    expect(result.textExcerpt).toBe("Visible.");
  });

  it("ignores style-like text inside preceding quoted attributes", async () => {
    const fetch = vi.fn(async () =>
      Promise.resolve(
        new Response(
          `<p>Visible.</p><div data-note='x style="color:red"' style="display:none">Decoy-hidden feature claim.</div>`,
          { headers: { "content-type": "text/html" } },
        ),
      ),
    );

    const result = await webFetchTool(
      "https://evidence.example/css-quoted-decoy",
      1_000,
      {
        fetch,
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      },
    );

    expect(result.textExcerpt).toBe("Visible.");
  });

  it("removes CSS newline continuations before testing hidden declarations", async () => {
    const fetch = vi.fn(async () =>
      Promise.resolve(
        new Response(
          "<p>Visible.</p><div style='dis\\\nplay:n\\6f ne'>Hidden feature claim.</div>",
          { headers: { "content-type": "text/html" } },
        ),
      ),
    );

    const result = await webFetchTool(
      "https://evidence.example/css-continuation",
      1_000,
      {
        fetch,
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      },
    );

    expect(result.textExcerpt).toBe("Visible.");
  });

  it("does not let markup-looking script text close a hidden ancestor", async () => {
    const fetch = vi.fn(async () =>
      Promise.resolve(
        new Response(
          '<div hidden><script>const payload = "</div>"; Hidden feature claim.</script></div><p>Visible.</p>',
          { headers: { "content-type": "text/html" } },
        ),
      ),
    );

    const result = await webFetchTool("https://evidence.example/raw-text", 1_000, {
      fetch,
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    });

    expect(result.textExcerpt).toBe("Visible.");
  });

  it("honors the complete XHTML processing-instruction terminator", async () => {
    const fetch = vi.fn(async () =>
      Promise.resolve(
        new Response(
          '<?audit note=">Hidden feature claim."?><p>Visible XHTML evidence.</p>',
          { headers: { "content-type": "application/xhtml+xml" } },
        ),
      ),
    );

    const result = await webFetchTool("https://evidence.example/xhtml-pi", 1_000, {
      fetch,
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    });

    expect(result.textExcerpt).toBe("Visible XHTML evidence.");
  });

  it("suppresses a bare title while honoring ordinary XHTML self-closing tags", async () => {
    const fetch = vi.fn(async () =>
      Promise.resolve(
        new Response(
          `<title>Hidden title claim.</title><template/><p>Visible XHTML evidence.</p>`,
          { headers: { "content-type": "application/xhtml+xml" } },
        ),
      ),
    );

    const result = await webFetchTool("https://evidence.example/xhtml", 1_000, {
      fetch,
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    });

    expect(result.textExcerpt).toBe("Visible XHTML evidence.");
  });
});
