import { describe, expect, it, vi } from "vitest";
import { webSearch } from "../tools/webSearch.js";

/**
 * Live test 2026-09-11: after several research runs lite.duckduckgo.com served
 * an HTTP 202 bot-challenge page (anomaly-modal, no result links). It was
 * recorded as an honest "empty" search, so run reports said discovery found
 * nothing when the source was actually blocked.
 */
const CHALLENGE_HTML = `<!DOCTYPE html><html><body>
<form action="//duckduckgo.com/anomaly.js?sv=lite&cc=botnet" method="POST">
  <div class="anomaly-modal__mask"><div class="anomaly-modal__modal">
    <p class="anomaly-modal__description">Unfortunately, bots use DuckDuckGo too.</p>
    <div class="anomaly-modal__puzzle"></div>
  </div></div>
</form></body></html>`;

describe("DuckDuckGo bot challenge", () => {
  it("is a failed search attempt, never an honest empty result", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response(CHALLENGE_HTML, { status: 202 }));
    const searched = await webSearch("Habitica official website", {
      fetchImpl,
      env: {} as NodeJS.ProcessEnv,
      firecrawlUrl: "https://firecrawl.test/v2/search",
    });
    expect(searched.results).toEqual([]);
    expect(searched.status).toBe("failed");
    const ddg = searched.attempts.find((attempt) => attempt.provider === "duckduckgo");
    expect(ddg?.status).toBe("failed");
    expect(ddg?.detail).toMatch(/challenge/i);
  });

  it("still treats a real zero-result page as empty", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(
        new Response("<html><body>No results.</body></html>", { status: 200 }),
      );
    const searched = await webSearch("zzzz unlikely query", {
      fetchImpl,
      env: {} as NodeJS.ProcessEnv,
      firecrawlUrl: "https://firecrawl.test/v2/search",
    });
    const ddg = searched.attempts.find((attempt) => attempt.provider === "duckduckgo");
    expect(ddg?.status).toBe("empty");
  });
});
