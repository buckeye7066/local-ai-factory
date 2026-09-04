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
});
