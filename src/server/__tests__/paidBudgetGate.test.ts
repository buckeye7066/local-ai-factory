import { describe, it, expect, beforeEach } from "vitest";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  BudgetGatedProvider,
  PaidBudgetExhaustedError,
  recordPaidCall,
  resetPaidBudget,
} from "../providers/paidBudget.js";
import { dispatchConcurrent } from "../providers/concurrentDispatcher.js";
import type { LLMProvider } from "../../shared/types.js";

// A ledger path exclusive to this file (not the suite-wide `.vitest-factory-data`)
// so these budget-exhaustion assertions can never race against another test
// file's own paid-rescue ledger writes (e.g. freeRouteFailover.test.ts).
const DATA_DIR = ".vitest-factory-data-paid-budget-gate";
process.env.FACTORY_DATA_DIR = DATA_DIR;

/**
 * `resetPaidBudget()` only drops the IN-MEMORY cache so the next read hits
 * disk — it deliberately does not erase the ledger (that's correct for
 * production: a real crash-restart must not reset the day's spend). Tests
 * need the opposite — a truly empty ledger between cases — so wipe the file
 * on disk too.
 */
async function resetLedgerCompletely(): Promise<void> {
  await rm(resolve(process.cwd(), DATA_DIR), { recursive: true, force: true });
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
