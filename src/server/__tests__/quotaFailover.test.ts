import { describe, expect, it } from "vitest";
import {
  QuotaFailoverProvider,
  isModelExhaustion,
  isQuotaRefusal,
} from "../providers/quotaFailover.js";
import type { LLMProvider } from "../../shared/types.js";

/**
 * Owner rule 2026-08-16: errors are to be FIXED, not blocked. A provider
 * answering "no credits remaining" ended three epic slices while a second
 * funded key sat unused in the same registry.
 */

function fake(
  name: LLMProvider["name"],
  behavior: "ok" | "quota" | "badRequest",
  configured = true,
): LLMProvider & { calls: number } {
  const p = {
    name,
    calls: 0,
    isConfigured: () => configured,
    async generateText() {
      p.calls += 1;
      if (behavior === "quota")
        throw new Error("429 You have no credits remaining. Add funds");
      if (behavior === "badRequest") throw new Error("400 invalid model parameter");
      return { text: `served by ${name}`, provider: name };
    },
    async generateJson<T>() {
      p.calls += 1;
      if (behavior === "quota")
        throw new Error("insufficient_quota: exceeded your current quota");
      if (behavior === "badRequest") throw new Error("400 unknown field");
      return { served: name } as unknown as T;
    },
  };
  return p as LLMProvider & { calls: number };
}

describe("isQuotaRefusal", () => {
  it("recognizes the real refusals seen in production", () => {
    expect(isQuotaRefusal(new Error("429 You have no credits remaining."))).toBe(true);
    expect(isQuotaRefusal(new Error("insufficient_quota"))).toBe(true);
    expect(
      isQuotaRefusal(
        new Error("Your credit balance is too low to access the Anthropic API"),
      ),
    ).toBe(true);
  });
  it("does NOT treat a real bad request as a quota problem", () => {
    expect(isQuotaRefusal(new Error("400 invalid model parameter"))).toBe(false);
    expect(isQuotaRefusal(new Error("anchor not found"))).toBe(false);
  });
});

describe("isModelExhaustion", () => {
  it("demotes on capacity and model availability without hiding bad input", () => {
    expect(isModelExhaustion({ status: 429, message: "busy" })).toBe(true);
    expect(isModelExhaustion(new Error("model is temporarily unavailable"))).toBe(
      true,
    );
    expect(isModelExhaustion(new Error("400 invalid model parameter"))).toBe(false);
  });
});

describe("QuotaFailoverProvider", () => {
  it("continues on the funded alternate when the primary is out of credit", async () => {
    const primary = fake("openai", "quota");
    const alt = fake("anthropic", "ok");
    const events: string[] = [];
    const p = new QuotaFailoverProvider(primary, [alt], (from, to) =>
      events.push(`${from}->${to}`),
    );
    const out = await p.generateJson<{ served: string }>({} as never);
    expect(out.served).toBe("anthropic");
    expect(events).toEqual(["openai->anthropic"]);
    expect(alt.calls).toBe(1);
  });

  it("keeps the run on the lower rung after the upper account is exhausted", async () => {
    const primary = fake("anthropic", "quota");
    const alternate = fake("openai", "ok");
    const ladder = new QuotaFailoverProvider(primary, [alternate]);

    await ladder.generateText({ prompt: "first" } as never);
    await ladder.generateText({ prompt: "second" } as never);

    expect(primary.calls).toBe(1);
    expect(alternate.calls).toBe(2);
  });

  it("does not fail over a genuine bad request — that would hide a real bug", async () => {
    const primary = fake("openai", "badRequest");
    const alt = fake("anthropic", "ok");
    const p = new QuotaFailoverProvider(primary, [alt]);
    await expect(p.generateText({ prompt: "x" } as never)).rejects.toThrow(
      /invalid model/,
    );
    expect(alt.calls).toBe(0);
  });

  it("skips unconfigured alternates and never loops back to the primary", async () => {
    const primary = fake("openai", "quota");
    const unconfigured = fake("anthropic", "ok", false);
    const sameName = fake("openai", "ok");
    const p = new QuotaFailoverProvider(primary, [unconfigured, sameName]);
    await expect(p.generateJson({} as never)).rejects.toThrow(/quota/i);
    expect(unconfigured.calls).toBe(0);
    expect(sameName.calls).toBe(0);
  });

  it("surfaces the original refusal when every alternate is also dry", async () => {
    const primary = fake("openai", "quota");
    const alt = fake("anthropic", "quota");
    const p = new QuotaFailoverProvider(primary, [alt]);
    await expect(p.generateJson({} as never)).rejects.toThrow(/no credits|quota/i);
    expect(alt.calls).toBe(1);
  });

  it("passes straight through when the primary works", async () => {
    const primary = fake("openai", "ok");
    const alt = fake("anthropic", "ok");
    const p = new QuotaFailoverProvider(primary, [alt]);
    const out = await p.generateText({ prompt: "x" } as never);
    expect(out.text).toContain("openai");
    expect(alt.calls).toBe(0);
  });
});
