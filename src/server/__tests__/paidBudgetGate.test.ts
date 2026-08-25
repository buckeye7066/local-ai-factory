import { describe, it, expect, beforeEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  BudgetGatedProvider,
  PaidBudgetExhaustedError,
  loadLimits,
  paidBudgetStatus,
  recordPaidCall,
  resetPaidBudget,
} from "../providers/paidBudget.js";
import { dispatchConcurrent } from "../providers/concurrentDispatcher.js";
import { AnthropicProvider } from "../providers/anthropicProvider.js";
import { OpenAIProvider } from "../providers/openaiProvider.js";
import type { LLMProvider } from "../../shared/types.js";

// A ledger path exclusive to this file (not the suite-wide `.vitest-factory-data`)
// so these budget-exhaustion assertions can never race against another test
// file's own paid-rescue ledger writes (e.g. freeRouteFailover.test.ts).
const DATA_DIR = ".vitest-factory-data-paid-budget-gate";
process.env.FACTORY_DATA_DIR = DATA_DIR;
// Caps are OWNER-SET only (defaults are unlimited since 2026-08-16 — the
// invented $2/day guardrail was removed). These tests exercise the gate, so
// they set the limits explicitly, exactly as an owner would.
process.env.FACTORY_PAID_RESCUES_PER_HOUR = "6";
process.env.FACTORY_PAID_RESCUES_PER_DAY = "24";
process.env.FACTORY_PAID_MAX_USD_PER_DAY = "2";

/**
 * `resetPaidBudget()` only drops the IN-MEMORY cache so the next read hits
 * disk — it deliberately does not erase the ledger (that's correct for
 * production: a real crash-restart must not reset the day's spend). Tests
 * need the opposite — a truly empty ledger between cases — so wipe the file
 * on disk too.
 */
async function resetLedgerCompletely(): Promise<void> {
  await rm(resolve(process.cwd(), DATA_DIR), {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
  resetPaidBudget();
}

class AlwaysOkProvider implements LLMProvider {
  calls = 0;
  constructor(readonly name: "anthropic" | "openai" | "free") {}
  isConfigured() {
    return true;
  }
  async generateText() {
    this.calls += 1;
    return { text: "ok", provider: this.name };
  }
  async generateJson<T>() {
    this.calls += 1;
    return {} as T;
  }
}

describe("BudgetGatedProvider", () => {
  beforeEach(resetLedgerCompletely);

  it("leaves every admission cap unlimited unless the owner opts in", () => {
    const limits = loadLimits({});
    expect(limits.perHour).toBe(Infinity);
    expect(limits.perDay).toBe(Infinity);
    expect(limits.usdPerDay).toBe(Infinity);
  });

  it("passes calls through while the budget is open", async () => {
    const inner = new AlwaysOkProvider("anthropic");
    const gated = new BudgetGatedProvider(inner, "anthropic");
    await gated.generateText({ system: "", prompt: "" });
    expect(inner.calls).toBe(1);
  });

  it("refuses a call once the $/day ceiling is exhausted — the exact gap the live FutureU proof exposed", async () => {
    // A raw provider dispatched to directly (outside the failover chain's own
    // runPaid() budget check) previously had NO gate at all — this is the bug
    // a real concurrent-dispatch build against FutureU actually hit: 3 paid
    // calls landed in one burst and blew the $2/day ceiling before anything
    // checked. Simulate that by recording enough spend to exhaust a tiny cap.
    recordPaidCall("anthropic", 1_000_000, 1_000_000);
    const inner = new AlwaysOkProvider("anthropic");
    const gated = new BudgetGatedProvider(inner, "anthropic");
    await expect(gated.generateText({ system: "", prompt: "" })).rejects.toBeInstanceOf(
      PaidBudgetExhaustedError,
    );
    expect(inner.calls).toBe(0); // never reached the real (billable) call
  });

  it("re-checks on EVERY call, not just once — a burst exhausting mid-way is stopped mid-burst", async () => {
    const inner = new AlwaysOkProvider("anthropic");
    const gated = new BudgetGatedProvider(inner, "anthropic");
    // First call succeeds...
    await gated.generateText({ system: "", prompt: "" });
    expect(inner.calls).toBe(1);
    // ...then a big spend lands (as if a sibling concurrent call just posted its cost)...
    recordPaidCall("anthropic", 1_000_000, 1_000_000);
    // ...and the NEXT call on the SAME gated instance is refused, not silently allowed
    // through because "it was open when the pool was built".
    await expect(gated.generateText({ system: "", prompt: "" })).rejects.toBeInstanceOf(
      PaidBudgetExhaustedError,
    );
    expect(inner.calls).toBe(1);
  });

  it("atomically reserves capacity before concurrent paid calls reach the provider", async () => {
    const previousHour = process.env.FACTORY_PAID_RESCUES_PER_HOUR;
    const previousDay = process.env.FACTORY_PAID_RESCUES_PER_DAY;
    const previousUsd = process.env.FACTORY_PAID_MAX_USD_PER_DAY;
    process.env.FACTORY_PAID_RESCUES_PER_HOUR = "1";
    process.env.FACTORY_PAID_RESCUES_PER_DAY = "1";
    process.env.FACTORY_PAID_MAX_USD_PER_DAY = "999";
    try {
      let release!: () => void;
      const held = new Promise<void>((resolveHeld) => {
        release = resolveHeld;
      });
      const inner = new AlwaysOkProvider("anthropic");
      inner.generateText = async () => {
        inner.calls += 1;
        await held;
        return { text: "ok", provider: inner.name };
      };
      const gated = new BudgetGatedProvider(inner, "anthropic");
      const firstCall = gated.generateText({ system: "", prompt: "first" });
      const secondCall = gated.generateText({ system: "", prompt: "second" });
      await Promise.resolve();

      expect(inner.calls).toBe(1);
      expect(paidBudgetStatus().lastHour).toBe(1);
      release();
      const [first, second] = await Promise.allSettled([firstCall, secondCall]);

      expect(
        [first, second].filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const rejected = [first, second].find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      expect(rejected?.reason).toBeInstanceOf(PaidBudgetExhaustedError);
      expect(inner.calls).toBe(1);
      expect(paidBudgetStatus().lastHour).toBe(1);
    } finally {
      if (previousHour === undefined) delete process.env.FACTORY_PAID_RESCUES_PER_HOUR;
      else process.env.FACTORY_PAID_RESCUES_PER_HOUR = previousHour;
      if (previousDay === undefined) delete process.env.FACTORY_PAID_RESCUES_PER_DAY;
      else process.env.FACTORY_PAID_RESCUES_PER_DAY = previousDay;
      if (previousUsd === undefined) delete process.env.FACTORY_PAID_MAX_USD_PER_DAY;
      else process.env.FACTORY_PAID_MAX_USD_PER_DAY = previousUsd;
    }
  });

  it("reserves every raw SDK retry instead of letting one outer gate buy multiple calls", async () => {
    const previousHour = process.env.FACTORY_PAID_RESCUES_PER_HOUR;
    const previousDay = process.env.FACTORY_PAID_RESCUES_PER_DAY;
    const previousUsd = process.env.FACTORY_PAID_MAX_USD_PER_DAY;
    process.env.FACTORY_PAID_RESCUES_PER_HOUR = "1";
    process.env.FACTORY_PAID_RESCUES_PER_DAY = "1";
    process.env.FACTORY_PAID_MAX_USD_PER_DAY = "999";
    try {
      let sdkCalls = 0;
      const provider = new AnthropicProvider(
        "sk-test",
        "claude-test",
        () => {},
        undefined,
        true,
      );
      (
        provider as unknown as {
          client: {
            messages: {
              stream: () => { finalMessage: () => Promise<never> };
            };
          };
        }
      ).client = {
        messages: {
          stream: () => ({
            finalMessage: async () => {
              sdkCalls += 1;
              throw new Error("transient network failure");
            },
          }),
        },
      };

      await expect(
        provider.generateText({ system: "system", prompt: "prompt" }),
      ).rejects.toThrow(/Paid provider call refused/i);
      expect(sdkCalls).toBe(1);
      expect(paidBudgetStatus().lastHour).toBe(1);
    } finally {
      if (previousHour === undefined) delete process.env.FACTORY_PAID_RESCUES_PER_HOUR;
      else process.env.FACTORY_PAID_RESCUES_PER_HOUR = previousHour;
      if (previousDay === undefined) delete process.env.FACTORY_PAID_RESCUES_PER_DAY;
      else process.env.FACTORY_PAID_RESCUES_PER_DAY = previousDay;
      if (previousUsd === undefined) delete process.env.FACTORY_PAID_MAX_USD_PER_DAY;
      else process.env.FACTORY_PAID_MAX_USD_PER_DAY = previousUsd;
    }
  });

  it("reserves the OpenAI JSON format fallback as a separate SDK attempt", async () => {
    const previousHour = process.env.FACTORY_PAID_RESCUES_PER_HOUR;
    const previousDay = process.env.FACTORY_PAID_RESCUES_PER_DAY;
    const previousUsd = process.env.FACTORY_PAID_MAX_USD_PER_DAY;
    process.env.FACTORY_PAID_RESCUES_PER_HOUR = "1";
    process.env.FACTORY_PAID_RESCUES_PER_DAY = "1";
    process.env.FACTORY_PAID_MAX_USD_PER_DAY = "999";
    try {
      let sdkCalls = 0;
      const provider = new OpenAIProvider(
        "sk-test",
        "gpt-test",
        () => {},
        undefined,
        true,
      );
      (
        provider as unknown as {
          client: {
            responses: { create: () => Promise<never> };
          };
        }
      ).client = {
        responses: {
          create: async () => {
            sdkCalls += 1;
            throw Object.assign(new Error("unsupported text.format"), {
              status: 400,
            });
          },
        },
      };

      await expect(
        provider.generateJson({
          system: "system",
          prompt: "prompt",
          schema: z.object({ ok: z.boolean() }),
          schemaName: "Result",
        }),
      ).rejects.toThrow(/Paid provider call refused/i);
      expect(sdkCalls).toBe(1);
      expect(paidBudgetStatus().lastHour).toBe(1);
    } finally {
      if (previousHour === undefined) delete process.env.FACTORY_PAID_RESCUES_PER_HOUR;
      else process.env.FACTORY_PAID_RESCUES_PER_HOUR = previousHour;
      if (previousDay === undefined) delete process.env.FACTORY_PAID_RESCUES_PER_DAY;
      else process.env.FACTORY_PAID_RESCUES_PER_DAY = previousDay;
      if (previousUsd === undefined) delete process.env.FACTORY_PAID_MAX_USD_PER_DAY;
      else process.env.FACTORY_PAID_MAX_USD_PER_DAY = previousUsd;
    }
  });

  it("fails closed before persisting a non-finite output-token estimate", async () => {
    const inner = new AlwaysOkProvider("anthropic");
    const gated = new BudgetGatedProvider(inner, "anthropic");

    await expect(
      gated.generateText({
        system: "",
        prompt: "",
        maxTokens: Number.NaN,
      }),
    ).rejects.toThrow(/maxTokens must be a positive finite integer/i);
    expect(inner.calls).toBe(0);
    expect(paidBudgetStatus().lastHour).toBe(0);
  });

  it("fails closed when a finite-cap ledger has malformed entries", async () => {
    const directory = resolve(process.cwd(), DATA_DIR);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "paid-rescue-budget.json"),
      JSON.stringify({ schema: 1, entries: [{}] }),
      "utf8",
    );
    resetPaidBudget();
    const inner = new AlwaysOkProvider("anthropic");
    const gated = new BudgetGatedProvider(inner, "anthropic");

    await expect(gated.generateText({ system: "", prompt: "" })).rejects.toThrow(
      /ledger has an invalid shape/i,
    );
    expect(inner.calls).toBe(0);
    expect(Number.isFinite(paidBudgetStatus().usdLastDay)).toBe(true);
  });

  it("fails closed on an explicitly configured invalid call cap", async () => {
    const previous = process.env.FACTORY_PAID_RESCUES_PER_DAY;
    process.env.FACTORY_PAID_RESCUES_PER_DAY = "twenty";
    try {
      const inner = new AlwaysOkProvider("anthropic");
      const gated = new BudgetGatedProvider(inner, "anthropic");
      await expect(gated.generateText({ system: "", prompt: "" })).rejects.toThrow(
        /must be a non-negative integer/i,
      );
      expect(inner.calls).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.FACTORY_PAID_RESCUES_PER_DAY;
      else process.env.FACTORY_PAID_RESCUES_PER_DAY = previous;
    }
  });

  it("fails closed on an explicitly configured invalid estimate rate", async () => {
    const previous = process.env.FACTORY_PAID_USD_PER_MTOK_IN;
    process.env.FACTORY_PAID_USD_PER_MTOK_IN = "200usd";
    try {
      const inner = new AlwaysOkProvider("anthropic");
      const gated = new BudgetGatedProvider(inner, "anthropic");
      await expect(gated.generateText({ system: "", prompt: "" })).rejects.toThrow(
        /FACTORY_PAID_USD_PER_MTOK_IN must be/i,
      );
      expect(inner.calls).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.FACTORY_PAID_USD_PER_MTOK_IN;
      else process.env.FACTORY_PAID_USD_PER_MTOK_IN = previous;
    }
  });
});

describe("dispatchConcurrent — resilience when a worker's budget trips mid-burst", () => {
  beforeEach(resetLedgerCompletely);

  it("requeues a task that failed on a budget-exhausted paid worker onto the still-open free worker", async () => {
    recordPaidCall("anthropic", 1_000_000, 1_000_000); // pre-exhaust anthropic's gate
    const free = new AlwaysOkProvider("free");
    const anthropicRaw = new AlwaysOkProvider("anthropic");
    const anthropicGated = new BudgetGatedProvider(anthropicRaw, "anthropic");

    const tasks = Array.from({ length: 6 }, (_, i) => ({
      id: `t${i}`,
      run: async (p: LLMProvider) => {
        const r = await p.generateText({ system: "", prompt: "" });
        return r.provider;
      },
    }));

    const summary = await dispatchConcurrent([free, anthropicGated], tasks);

    // Every task eventually completed — none silently dropped because one
    // backend's budget tripped mid-run.
    expect(summary.outcomes.filter((o) => !o.error)).toHaveLength(6);
    // The gated (budget-exhausted) provider never actually served a task.
    expect(anthropicRaw.calls).toBe(0);
    // Free picked up everything, including the ones first handed to the gated worker.
    expect(free.calls).toBeGreaterThanOrEqual(6);
  });
});
