import { describe, expect, it } from "vitest";
import type { LLMProvider } from "../../shared/types.js";
import { CreditGuardCircuitOpenError } from "../providers/creditGuard.js";
import { PaidBudgetExhaustedError } from "../providers/paidBudget.js";
import {
  QuotaFailoverProvider,
  isPreProviderPaidRefusal,
  isQuotaRefusal,
} from "../providers/quotaFailover.js";

type Behavior = "ok" | "quota" | "badRequest" | "localBlock";

function fake(
  name: LLMProvider["name"],
  behavior: Behavior,
  configured = true,
): LLMProvider & { calls: number } {
  const provider = {
    name,
    calls: 0,
    isConfigured: () => configured,
    async generateText() {
      provider.calls += 1;
      if (behavior === "quota") {
        throw new Error("429 You have no credits remaining. Add funds");
      }
      if (behavior === "badRequest") {
        throw new Error("400 invalid model parameter");
      }
      if (behavior === "localBlock") {
        throw new CreditGuardCircuitOpenError(
          "Credit Guard blocked this route before provider I/O.",
        );
      }
      return { text: `served by ${name}`, provider: name };
    },
    async generateJson<T>() {
      provider.calls += 1;
      if (behavior === "quota") {
        throw new Error("insufficient_quota: exceeded your current quota");
      }
      if (behavior === "badRequest") throw new Error("400 unknown field");
      if (behavior === "localBlock") {
        throw new CreditGuardCircuitOpenError(
          "Credit Guard blocked this route before provider I/O.",
        );
      }
      return { served: name } as unknown as T;
    },
  };
  return provider as LLMProvider & { calls: number };
}

describe("paid refusal classification", () => {
  it("recognizes provider-originated quota messages for diagnostics", () => {
    expect(isQuotaRefusal(new Error("429 You have no credits remaining."))).toBe(
      true,
    );
    expect(isQuotaRefusal(new Error("insufficient_quota"))).toBe(true);
    expect(
      isQuotaRefusal(
        new Error("Your credit balance is too low to access the Anthropic API"),
      ),
    ).toBe(true);
    expect(isQuotaRefusal(new Error("400 invalid model parameter"))).toBe(false);
  });

  it("permits alternates only for local pre-provider admission blocks", () => {
    expect(
      isPreProviderPaidRefusal(
        new CreditGuardCircuitOpenError("duplicate request blocked"),
      ),
    ).toBe(true);
    expect(
      isPreProviderPaidRefusal(new PaidBudgetExhaustedError("daily cap reached")),
    ).toBe(true);
    expect(
      isPreProviderPaidRefusal(new Error("429 You have no credits remaining")),
    ).toBe(false);
  });
});

describe("QuotaFailoverProvider", () => {
  it("uses an alternate when Credit Guard blocked the primary before I/O", async () => {
    const primary = fake("openai", "localBlock");
    const alternate = fake("anthropic", "ok");
    const events: string[] = [];
    const provider = new QuotaFailoverProvider(
      primary,
      [alternate],
      (from, to) => events.push(`${from}->${to}`),
    );

    const output = await provider.generateJson<{ served: string }>({} as never);

    expect(output.served).toBe("anthropic");
    expect(events).toEqual(["openai->anthropic"]);
    expect(alternate.calls).toBe(1);
  });

  it("does not buy an alternate after an actual provider quota response", async () => {
    const primary = fake("openai", "quota");
    const alternate = fake("anthropic", "ok");
    const provider = new QuotaFailoverProvider(primary, [alternate]);

    await expect(provider.generateJson({} as never)).rejects.toThrow(
      /no credits|quota/i,
    );
    expect(primary.calls).toBe(1);
    expect(alternate.calls).toBe(0);
  });

  it("does not fail over a genuine bad request", async () => {
    const primary = fake("openai", "badRequest");
    const alternate = fake("anthropic", "ok");
    const provider = new QuotaFailoverProvider(primary, [alternate]);

    await expect(provider.generateText({ prompt: "x" } as never)).rejects.toThrow(
      /invalid model/,
    );
    expect(alternate.calls).toBe(0);
  });

  it("skips unconfigured and same-name alternates", async () => {
    const primary = fake("openai", "localBlock");
    const unconfigured = fake("anthropic", "ok", false);
    const sameName = fake("openai", "ok");
    const provider = new QuotaFailoverProvider(primary, [unconfigured, sameName]);

    await expect(provider.generateJson({} as never)).rejects.toBeInstanceOf(
      CreditGuardCircuitOpenError,
    );
    expect(unconfigured.calls).toBe(0);
    expect(sameName.calls).toBe(0);
  });

  it("surfaces the original local refusal when every alternate is also blocked", async () => {
    const primary = fake("openai", "localBlock");
    const alternate = fake("anthropic", "localBlock");
    const provider = new QuotaFailoverProvider(primary, [alternate]);

    await expect(provider.generateJson({} as never)).rejects.toThrow(
      /blocked this route/i,
    );
    expect(alternate.calls).toBe(1);
  });

  it("passes straight through when the primary works", async () => {
    const primary = fake("openai", "ok");
    const alternate = fake("anthropic", "ok");
    const provider = new QuotaFailoverProvider(primary, [alternate]);

    const output = await provider.generateText({ prompt: "x" } as never);

    expect(output.text).toContain("openai");
    expect(alternate.calls).toBe(0);
  });
});
