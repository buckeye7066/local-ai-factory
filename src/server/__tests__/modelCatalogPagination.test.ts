import { describe, expect, it, vi } from "vitest";

const anthropicCatalog = vi.hoisted(() => ({
  pages: [] as Array<Array<{ id: string; created_at: string }>>,
  listCalls: [] as Array<{ query: unknown; options: unknown }>,
}));

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    models = {
      list: (query: unknown, options: unknown) => {
        anthropicCatalog.listCalls.push({ query, options });
        return {
          async *[Symbol.asyncIterator]() {
            for (const page of anthropicCatalog.pages) {
              for (const model of page) yield model;
            }
          },
        };
      },
    };
  }
  return { default: FakeAnthropic };
});

import { createAnthropicModelResolver } from "../providers/modelCatalog.js";

describe("Anthropic account catalog pagination", () => {
  it("finds an immutable pin after the first 100 newest models", async () => {
    const signal = new AbortController().signal;
    anthropicCatalog.pages = [
      Array.from({ length: 100 }, (_, index) => ({
        id: `claude-newer-${index + 1}`,
        created_at: "2026-01-01T00:00:00.000Z",
      })),
      [
        {
          id: "claude-haiku-4-5-20251001",
          created_at: "2025-10-01T00:00:00.000Z",
        },
      ],
    ];
    anthropicCatalog.listCalls = [];
    const resolver = createAnthropicModelResolver({
      apiKey: "sk-test",
      preferred: ["claude-haiku-4-5-20251001"],
      log: () => {},
      signal,
    })!;

    await expect(resolver("claude-haiku-4-5-20251001")).resolves.toBe(
      "claude-haiku-4-5-20251001",
    );
    expect(anthropicCatalog.listCalls).toEqual([
      { query: { limit: 100 }, options: { signal } },
    ]);
  });
});
