import { describe, expect, it } from "vitest";
import {
  createCachedModelResolver,
  resolvePreferredModels,
} from "../providers/modelCatalog.js";

describe("provider model catalog ordering", () => {
  it("preserves configured strength while resolving dated model snapshots", () => {
    expect(
      resolvePreferredModels(
        "anthropic",
        ["claude-fable-5-1", "claude-opus-5", "claude-haiku-4-5"],
        [
          { id: "claude-opus-5", created: 20 },
          { id: "claude-haiku-4-5-20251001", created: 10 },
          { id: "claude-fable-5-1", created: 30 },
        ],
      ),
    ).toEqual(["claude-fable-5-1", "claude-opus-5", "claude-haiku-4-5-20251001"]);
  });

  it("uses the strongest remaining account-visible model when a configured ID is absent", () => {
    expect(
      resolvePreferredModels(
        "openai",
        ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra"],
        [
          { id: "gpt-5.6-sol", created: 30 },
          { id: "gpt-5.6-terra", created: 20 },
          { id: "gpt-5.6-luna", created: 10 },
        ],
      ),
    ).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
  });

  it("keeps an unlisted stronger model ahead of an exact later weak alias", async () => {
    const messages: string[] = [];
    const preferred = ["claude-fable-5-1", "claude-opus-5", "claude-haiku-4-5"];
    const available = [
      { id: "claude-haiku-4-5-20251001", created: 200 },
      { id: "claude-fable-5-2", created: 100 },
    ];

    expect(resolvePreferredModels("anthropic", preferred, available)).toEqual([
      "claude-fable-5-2",
      "claude-haiku-4-5-20251001",
    ]);

    const resolver = createCachedModelResolver({
      provider: "anthropic",
      preferred,
      load: async () => available,
      log: (_level, message) => messages.push(message),
    });
    await expect(resolver("claude-fable-5-1")).resolves.toBe("claude-fable-5-2");
    expect(messages).toContain(
      "[route] anthropic Models API confirmed account-visible model claude-fable-5-2 for configured rung claude-fable-5-1.",
    );
  });

  it("does not mistake a newer weak snapshot for the strongest model", () => {
    expect(
      resolvePreferredModels(
        "anthropic",
        ["claude-opus-5", "claude-haiku-4-5"],
        [
          { id: "claude-haiku-4-5-20251001", created: 300 },
          { id: "claude-opus-5", created: 100 },
        ],
      ),
    ).toEqual(["claude-opus-5", "claude-haiku-4-5-20251001"]);
  });

  it("preserves explicitly configured account-visible gpt-4.1 and o-series models", async () => {
    const preferred = ["gpt-4.1", "o3"];
    const available = [
      { id: "gpt-6-astra", created: 400 },
      { id: "o3", created: 300 },
      { id: "gpt-4.1", created: 200 },
      { id: "text-embedding-3-large", created: 100 },
    ];
    const resolver = createCachedModelResolver({
      provider: "openai",
      preferred,
      load: async () => available,
      log: () => {},
    });

    expect(resolvePreferredModels("openai", preferred, available)).toEqual([
      "gpt-4.1",
      "o3",
    ]);
    await expect(resolver("gpt-4.1")).resolves.toBe("gpt-4.1");
    await expect(resolver("o3")).resolves.toBe("o3");
  });

  it("does not treat a weaker arbitrary suffix as a configured model snapshot", async () => {
    const resolver = createCachedModelResolver({
      provider: "openai",
      preferred: ["gpt-4.1"],
      load: async () => [
        { id: "gpt-4.1-mini", created: 300 },
        { id: "gpt-4.1-2025-04-14", created: 100 },
      ],
      log: () => {},
    });

    await expect(resolver("gpt-4.1")).resolves.toBe("gpt-4.1-2025-04-14");
  });

  it("keeps a configured dated snapshot pinned to that exact date", async () => {
    const resolver = createCachedModelResolver({
      provider: "openai",
      preferred: ["gpt-4.1-2025-04-14"],
      load: async () => [
        { id: "gpt-4.1-2025-05-01", created: 300 },
        { id: "gpt-4.1-2025-04-14", created: 100 },
      ],
      log: () => {},
    });

    await expect(resolver("gpt-4.1-2025-04-14")).resolves.toBe("gpt-4.1-2025-04-14");
  });

  it("rejects an unavailable dated pin without shifting later flexible rungs", async () => {
    const preferred = ["gpt-4.1-2025-04-14", "gpt-5.6-sol", "gpt-5.6-terra"];
    const available = [
      { id: "gpt-4.1-2025-05-01", created: 400 },
      { id: "gpt-5.6-sol", created: 300 },
      { id: "gpt-5.6-terra", created: 200 },
    ];
    const resolver = createCachedModelResolver({
      provider: "openai",
      preferred,
      load: async () => available,
      log: () => {},
    });

    expect(resolvePreferredModels("openai", preferred, available)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
    ]);
    await expect(resolver("gpt-4.1-2025-04-14")).rejects.toThrow(
      /model unavailable in the account catalog/,
    );
    await expect(resolver("gpt-5.6-sol")).resolves.toBe("gpt-5.6-sol");
    await expect(resolver("gpt-5.6-terra")).resolves.toBe("gpt-5.6-terra");
  });

  it("allows only one configured probe when the account catalog is unreachable", async () => {
    let loads = 0;
    const resolver = createCachedModelResolver({
      provider: "anthropic",
      preferred: ["claude-fable-5-1", "claude-opus-5"],
      load: async () => {
        loads += 1;
        throw new Error("catalog unavailable");
      },
      log: () => {},
    });

    await expect(resolver("claude-fable-5-1")).resolves.toBe("claude-fable-5-1");
    await expect(resolver("claude-opus-5")).rejects.toThrow(
      /suppressed unverified model probe/,
    );
    expect(loads).toBe(1);
  });
});
