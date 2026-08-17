import { describe, it, expect, beforeEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  BudgetGatedProvider,
  PaidBudgetExhaustedError,
  loadLimits,
  paidBudgetStatus,
  recordPaidCall,
  releasePaidReservation,
  reservePaidCall,
  resetPaidBudget,
} from "../providers/paidBudget.js";
import { dispatchConcurrent } from "../providers/concurrentDispatcher.js";
import type { LLMProvider } from "../../shared/types.js";

// A ledger path exclusive to this file (not the suite-wide `.vitest-factory-data`)
// so these budget-exhaustion assertions can never race against another test
// file's own paid-rescue ledger writes (e.g. freeRouteFailover.test.ts).
const DATA_DIR = ".vitest-factory-data-paid-budget-gate";
process.env.FACTORY_DATA_DIR = DATA_DIR;
// Production defaults are deliberately finite and JSON-safe. Individual tests
// still pin values so a developer's shell cannot change their meaning.
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

beforeEach(() => {
  process.env.FACTORY_PAID_RESCUES_PER_HOUR = "6";
  process.env.FACTORY_PAID_RESCUES_PER_DAY = "24";
  process.env.FACTORY_PAID_MAX_USD_PER_DAY = "2";
});

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

class DeferredProvider extends AlwaysOkProvider {
  private finish!: () => void;
  private resolveStarted!: () => void;
  readonly started: Promise<void>;

  constructor(name: "anthropic" | "openai" | "free") {
    super(name);
    this.started = new Promise<void>((resolveStarted) => {
      this.resolveStarted = resolveStarted;
    });
  }

  release(): void {
    this.finish();
  }

  override async generateText() {
    this.calls += 1;
    this.resolveStarted();
    await new Promise<void>((resolveFinished) => {
      this.finish = resolveFinished;
    });
    return { text: "ok", provider: this.name };
  }
}

describe("paid budget limits and reservations", () => {
  beforeEach(resetLedgerCompletely);

  it("uses finite JSON-safe defaults", () => {
    const limits = loadLimits({});
    expect(limits).toMatchObject({ perHour: 6, perDay: 24, usdPerDay: 2 });
    expect(Object.values(limits).every(Number.isFinite)).toBe(true);
    expect(JSON.parse(JSON.stringify(limits))).toEqual(limits);
  });

  it("reserves the last concurrent slot before the first call starts", async () => {
    process.env.FACTORY_PAID_RESCUES_PER_HOUR = "1";
    const inner = new DeferredProvider("anthropic");
    const gated = new BudgetGatedProvider(inner, "anthropic");
    const first = gated.generateText({ system: "", prompt: "" });
    await inner.started;

    expect(paidBudgetStatus().reserved).toBe(1);
    await expect(gated.generateText({ system: "", prompt: "" })).rejects.toBeInstanceOf(
      PaidBudgetExhaustedError,
    );
    expect(inner.calls).toBe(1);

    inner.release();
    await expect(first).resolves.toMatchObject({ text: "ok" });
    expect(paidBudgetStatus().reserved).toBe(0);
  });

  it("fails closed on a corrupt ledger before reaching a billable provider", async () => {
    const budgetDir = resolve(process.cwd(), DATA_DIR);
    await mkdir(budgetDir, { recursive: true });
    await writeFile(resolve(budgetDir, "paid-rescue-budget.json"), "{bad", "utf8");
    resetPaidBudget();
    const inner = new AlwaysOkProvider("openai");

    await expect(
      new BudgetGatedProvider(inner, "openai").generateText({
        system: "",
        prompt: "",
      }),
    ).rejects.toBeInstanceOf(PaidBudgetExhaustedError);
    expect(inner.calls).toBe(0);
    expect(paidBudgetStatus().reason).toMatch(/unreadable/i);
  });

  it("retains a reservation when billing is uncertain after an error", async () => {
    const inner: LLMProvider = {
      name: "anthropic",
      isConfigured: () => true,
      generateText: async () => {
        throw new Error("connection lost after request was accepted");
      },
      async generateJson<T>(): Promise<T> {
        throw new Error("connection lost after request was accepted");
      },
    };
    await expect(
      new BudgetGatedProvider(inner, "anthropic").generateText({
        system: "",
        prompt: "",
      }),
    ).rejects.toThrow(/connection lost/i);
    expect(paidBudgetStatus().reserved).toBe(1);
  });

  it("releases the exact concurrent reservation instead of another call's slot", () => {
    const earlier = reservePaidCall("anthropic", 10, 10);
    const later = reservePaidCall("anthropic", 20, 20);

    // The later request completes first. Usage is appended independently and
    // the outer gate releases that request's exact reservation id.
    recordPaidCall("anthropic", 5, 5);
    expect(releasePaidReservation(later.id)).toBe(true);

    const duringEarlierCall = paidBudgetStatus();
    expect(duringEarlierCall.reserved).toBe(1);
    expect(duringEarlierCall.lastDay).toBe(2); // one settled + earlier reserve
    expect(releasePaidReservation(earlier.id)).toBe(true);
    expect(paidBudgetStatus().reserved).toBe(0);
  });
});

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
