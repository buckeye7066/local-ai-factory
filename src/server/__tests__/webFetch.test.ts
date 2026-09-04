import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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

  it.each([
    ["inactive popover", "<div popover>Hidden feature claim.</div>"],
    [
      "closed details",
      "<details><summary>More</summary>Hidden feature claim.</details>",
    ],
    [
      "zero-height overflow",
      '<div style="height:0;overflow:hidden">Hidden feature claim.</div>',
    ],
    [
      "zero max-height overflow",
      '<div style="max-height:0;overflow-y:hidden">Hidden feature claim.</div>',
    ],
  ])("excludes %s content from evidence text", async (_name, hiddenMarkup) => {
    const fetch = vi.fn(async () =>
      Promise.resolve(
        new Response(`<p>Visible evidence.</p>${hiddenMarkup}`, {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      ),
    );

    const result = await webFetchTool("https://evidence.example/hidden-state", 1_000, {
      fetch,
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    });

    expect(result.ok).toBe(true);
    expect(result.textExcerpt).toContain("Visible evidence.");
    expect(result.textExcerpt).not.toContain("Hidden feature claim.");
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

  it("decodes HTML entities before testing whether inline CSS hides content", async () => {
    const fetch = vi.fn(async () =>
      Promise.resolve(
        new Response(
          `<p>Visible.</p><div style="display&#58;none">Hidden feature claim.</div>`,
          { headers: { "content-type": "text/html" } },
        ),
      ),
    );

    const result = await webFetchTool("https://evidence.example/css-entity", 1_000, {
      fetch,
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    });

    expect(result.textExcerpt).toBe("Visible.");
  });

  it.each(["display&#58none", "display&#x3anone"])(
    "decodes semicolon-less numeric references before testing inline CSS: %s",
    async (style) => {
      const fetch = vi.fn(async () =>
        Promise.resolve(
          new Response(
            `<p>Visible.</p><div style="${style}">Hidden feature claim.</div>`,
            { headers: { "content-type": "text/html" } },
          ),
        ),
      );

      const result = await webFetchTool(
        "https://evidence.example/css-numeric-entity",
        1_000,
        {
          fetch,
          lookup: async () => [{ address: "93.184.216.34", family: 4 }],
        },
      );

      expect(result.textExcerpt).toBe("Visible.");
    },
  );

  it("applies embedded stylesheet visibility before admitting evidence text", async () => {
    const fetch = vi.fn(async () =>
      Promise.resolve(
        new Response(
          `<style>@media screen { .hidden { display: none } }</style>
           <p>Visible evidence.</p>
           <div class="hidden">Hidden feature claim.</div>`,
          { headers: { "content-type": "text/html" } },
        ),
      ),
    );

    const result = await webFetchTool(
      "https://evidence.example/embedded-stylesheet",
      1_000,
      {
        fetch,
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      },
    );

    expect(result.ok).toBe(true);
    expect(result.textExcerpt).toBe("Visible evidence.");
  });

  it("fails closed on an unterminated embedded stylesheet comment", async () => {
    const fetch = vi.fn(async () =>
      Promise.resolve(
        new Response(
          `<style>/* unterminated .claim { display: none }</style>
           <div class="claim">Unverifiable feature claim.</div>`,
          { headers: { "content-type": "text/html" } },
        ),
      ),
    );

    const result = await webFetchTool(
      "https://evidence.example/unterminated-embedded-css",
      1_000,
      {
        fetch,
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      },
    );

    expect(result.ok).toBe(false);
    expect(result.textExcerpt).toBe("");
    expect(result.error).toMatch(/unterminated CSS comment/i);
  });

  it("fetches and applies external stylesheet visibility before admitting evidence", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const requestUrl =
        input instanceof URL
          ? input
          : new URL(typeof input === "string" ? input : input.url);
      if (requestUrl.pathname === "/evidence.css") {
        return new Response(".hidden { visibility: hidden }", {
          headers: { "content-type": "text/css" },
        });
      }
      return new Response(
        `<link rel="stylesheet" href="/evidence.css">
         <p>Visible evidence.</p>
         <div class="hidden">Hidden feature claim.</div>`,
        { headers: { "content-type": "text/html" } },
      );
    });

    const result = await webFetchTool(
      "https://evidence.example/external-stylesheet",
      1_000,
      {
        fetch,
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      },
    );

    expect(result.ok).toBe(true);
    expect(result.textExcerpt).toBe("Visible evidence.");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("fails closed on an unterminated external stylesheet comment", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const requestUrl =
        input instanceof URL
          ? input
          : new URL(typeof input === "string" ? input : input.url);
      if (requestUrl.pathname === "/broken.css") {
        return new Response("/* unterminated .claim { display: none }", {
          headers: { "content-type": "text/css" },
        });
      }
      return new Response(
        `<link rel="stylesheet" href="/broken.css">
         <div class="claim">Unverifiable feature claim.</div>`,
        { headers: { "content-type": "text/html" } },
      );
    });

    const result = await webFetchTool(
      "https://evidence.example/unterminated-external-css",
      1_000,
      {
        fetch,
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      },
    );

    expect(result.ok).toBe(false);
    expect(result.textExcerpt).toBe("");
    expect(result.error).toMatch(/unterminated CSS comment/i);
  });

  it.each([
    "opacity: 0",
    "transform: scale(0)",
    "transform: scale(0, 1)",
    "transform: rotate(1deg) scale(1) scale(0, 1)",
    "transform: matrix3d(0,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)",
    "scale: 0",
    "scale: 0 1",
    "clip: rect(0, 0, 0, 0)",
    "clip-path: inset(50%)",
    "clip-path: inset(0 50%)",
    "clip-path: polygon(50% 50%, 50% 50%, 50% 50%)",
    "font-size: 0",
    "color: transparent",
    "color: rgba(0, 0, 0, 0)",
    "color: rgb(0 0 0 / 0%)",
    "color: #0000",
    "color: #00000000",
    "-webkit-text-fill-color: rgba(12, 34, 56, 0)",
  ])("rejects text hidden by a visual CSS technique: %s", async (declaration) => {
    const fetch = vi.fn(async () =>
      Promise.resolve(
        new Response(
          `<style>.claim { ${declaration} }</style><p>Visible.</p><div class="claim">Hidden feature claim.</div>`,
          { headers: { "content-type": "text/html" } },
        ),
      ),
    );

    const result = await webFetchTool("https://evidence.example/visual-hide", 1_000, {
      fetch,
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    });

    expect(result.ok).toBe(true);
    expect(result.textExcerpt).toBe("Visible.");
  });

  it("rejects truncated HTML whose unseen suffix can govern visibility", async () => {
    const fetch = vi.fn(async () =>
      Promise.resolve(
        new Response(
          `<div class="claim">Hidden feature claim.</div>${"x".repeat(210_000)}<style>.claim { display: none }</style>`,
          { headers: { "content-type": "text/html" } },
        ),
      ),
    );

    const result = await webFetchTool("https://evidence.example/truncated", 1_000, {
      fetch,
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    });

    expect(result).toMatchObject({ ok: false, truncated: true, textExcerpt: "" });
    expect(result.error).toMatch(/cannot be verified safely/i);
  });

  it("does not let DOM style evaluation preload an unvetted network target", async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.end("unexpected");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    try {
      const fetch = vi.fn(async () =>
        Promise.resolve(
          new Response(
            `<style>.visible { display: block }</style><link rel="preload" as="fetch" href="http://127.0.0.1:${port}/probe"><p class="visible">Visible evidence.</p>`,
            { headers: { "content-type": "text/html" } },
          ),
        ),
      );

      const result = await webFetchTool("http://evidence.example/preload", 1_000, {
        fetch,
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(result.ok).toBe(true);
      expect(result.textExcerpt).toBe("Visible evidence.");
      expect(requests).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("ignores style-like text inside preceding quoted attributes", async () => {
    const fetch = vi.fn(async () =>
      Promise.resolve(
        new Response(
          `<p>Visible.</p><div data-note='x style="color:red"' style="display:none">Hidden feature claim.</div>`,
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
