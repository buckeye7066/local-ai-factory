import { describe, expect, it } from "vitest";
import {
  createCachedModelResolver,
  resolvePreferredModels,
} from "../providers/modelCatalog.js";

describe("provider model catalog ordering", () => {
  it("preserves configured strength while resolving dated model snapshots", () => {
    expect(
      resolvePreferredModels(
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
        ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra"],
        [
          { id: "gpt-5.6-sol", created: 30 },
          { id: "gpt-5.6-terra", created: 20 },
          { id: "gpt-5.6-luna", created: 10 },
        ],
      ),
    ).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
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
