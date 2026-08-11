import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { FreeProvider } from "../providers/freeProvider.js";
import { FailoverProvider } from "../providers/failoverProvider.js";
import {
  resetRouteState,
  resetThresholdCache,
  snapshotRoute,
  getThresholds,
  isBackpressure,
  queueBonusGrants,
} from "../providers/freeRoute.js";
import { resetPaidBudget } from "../providers/paidBudget.js";
import { loadConfig } from "../config.js";
import { startFakeFreeBackend, type FakeBackend } from "./helpers/fakeFreeBackend.js";
import type {
  LLMProvider,
  GenerateTextInput,
  GenerateTextResult,
  GenerateJsonInput,
} from "../../shared/types.js";

/**
 * THE regression suite for the one failure this deck must never have:
 * silently converting a free setup into a metered one by mistaking a
 * healthy-but-slow free route for a dead one.
 *
 * Measured on this machine 2026-08-11 (scripts/measure-free-route.mjs, n=8
 * healthy calls through the real FCC proxy, 5 sequential + 3 concurrent):
 *
 *   first-token silence : p50 211,075ms   p95 302,265ms   max 302,265ms
 *   inter-token silence : p50      10ms   p95      41ms   max      244ms
 *
 * Those two distributions are separated by a factor of ~1,239. That is the
 * whole design: a call can legitimately be silent for five minutes BEFORE it
 * starts talking (cold start + queue), but once it is talking it never goes
 * quiet for more than a quarter of a second. So silence before the first token
 * is budgeted in minutes and proves nothing, while silence between tokens is
 * budgeted in seconds and is real evidence of a wedge.
 *
 * It also shows why a constant cannot work: a naive 120s timeout would have
 * failed over on 8 of those 8 healthy calls, and a 240s one on 5 of 8 —
 * spending real money every time while the backend was fine.
 *
 * The tests below drive a fake backend rather than the real proxy, because a
 * check that cannot fail proves nothing: you cannot make the real proxy hang
 * on demand, so both sides of the decision must be exercised against a
 * backend whose behaviour is chosen by the test.
 */

/** A paid tier that records every call it is asked to serve. */
class SpyPaidProvider implements LLMProvider {
  calls = 0;
  constructor(readonly name: "anthropic" | "openai") {}
  isConfigured(): boolean {
    return true;
  }
  async generateText(_input: GenerateTextInput): Promise<GenerateTextResult> {
    this.calls += 1;
    return { text: "PAID", provider: this.name };
  }
  async generateJson<T>(input: GenerateJsonInput<T>): Promise<T> {
    this.calls += 1;
    return input.schema.parse({ ok: true });
  }
}

/** A paid tier that is not configured — the "no credit card" deck. */
class AbsentPaidProvider implements LLMProvider {
  calls = 0;
  constructor(readonly name: "anthropic" | "openai") {}
  isConfigured(): boolean {
    return false;
  }
  async generateText(): Promise<GenerateTextResult> {
    this.calls += 1;
    throw new Error("not configured");
  }
  async generateJson<T>(): Promise<T> {
    this.calls += 1;
    throw new Error("not configured");
  }
}

interface Harness {
  free: FreeProvider;
  chain: FailoverProvider;
  anthropic: SpyPaidProvider;
  openai: SpyPaidProvider;
  logs: string[];
}

function harness(
  backend: FakeBackend,
  opts: {
    holdMs?: number;
    attempts?: number;
    retrySpacingMs?: number;
    maxBackpressureRetries?: number;
    ollamaUrl?: string;
    paid?: boolean;
  } = {},
): Harness {
  const free = new FreeProvider({
    baseUrl: backend.url,
    authToken: "test-token",
    model: "fake-free-model",
    // Point the out-of-band Ollama probe at the fake too, so a test can make
    // EVERY liveness signal fail at once (the genuine-wedge case).
    ollamaUrl: opts.ollamaUrl ?? backend.url,
    maxConcurrency: 2,
    backpressureRetryMs: 50,
    enabled: true,
  });
  const anthropic = new SpyPaidProvider("anthropic");
  const openai = new SpyPaidProvider("openai");
  const logs: string[] = [];
  const chain = new FailoverProvider(
    free,
    opts.paid === false
      ? (new AbsentPaidProvider("anthropic") as unknown as LLMProvider)
      : anthropic,
    opts.paid === false
      ? (new AbsentPaidProvider("openai") as unknown as LLMProvider)
      : openai,
    {
      holdMs: opts.holdMs ?? 400,
      attempts: opts.attempts ?? 2,
      retrySpacingMs: opts.retrySpacingMs ?? 20,
      maxBackpressureRetries: opts.maxBackpressureRetries ?? 5,
      baseUrl: backend.url,
      // MUST stay false in tests: a true value would try to spawn the real
      // fcc-server on the developer's machine.
      autoRestart: false,
    },
    (_kind, message) => logs.push(message),
  );
  return { free, chain, anthropic, openai, logs };
}

/**
 * Scale the real thresholds down so the suite runs in seconds while keeping
 * the RATIOS that matter faithful: the inter-token budget stays many times
 * larger than the dribble interval, exactly as 60,000ms is 246x the 244ms
 * worst healthy gap in production.
 */
function useTestThresholds(over: Record<string, string> = {}) {
  process.env.FACTORY_FREE_FIRST_TOKEN_WINDOW_MS = "2000";
  process.env.FACTORY_FREE_IDLE_GAP_MS = "1500";
  process.env.FACTORY_FREE_BACKSTOP_MS = "60000";
  process.env.FACTORY_FREE_PATIENCE_GRANTS = "2";
  Object.assign(process.env, over);
  resetThresholdCache();
}

function clearTestThresholds() {
  delete process.env.FACTORY_FREE_FIRST_TOKEN_WINDOW_MS;
  delete process.env.FACTORY_FREE_IDLE_GAP_MS;
  delete process.env.FACTORY_FREE_BACKSTOP_MS;
  delete process.env.FACTORY_FREE_PATIENCE_GRANTS;
  resetThresholdCache();
}

let backend: FakeBackend | null = null;

beforeEach(() => {
  resetRouteState();
  resetPaidBudget();
  clearTestThresholds();
});

afterEach(async () => {
  await backend?.close();
  backend = null;
  clearTestThresholds();
});

/* ================================================================== */
/* TEST A — slow but alive MUST NOT cost money                         */
/* ================================================================== */

describe("A. healthy-but-slow free route never fails over", () => {
  it("dribbles a token every 300ms for ~6s and is served entirely by FREE", async () => {
    backend = await startFakeFreeBackend({
      mode: "dribble",
      chunkEveryMs: 300,
      chunks: 20,
      livenessOk: true,
    });
    useTestThresholds();
    const h = harness(backend);

    const started = Date.now();
    const res = await h.chain.generateText({ system: "s", prompt: "p" });
    const elapsed = Date.now() - started;

    expect(res.text).toContain("OK");
    // The call really did take far longer than a naive total-elapsed timeout
    // would have allowed — this is the counterfactual the test exists to prove.
    expect(elapsed).toBeGreaterThan(4000);
    // ...and it cost nothing.
    expect(h.anthropic.calls).toBe(0);
    expect(h.openai.calls).toBe(0);
    const snap = snapshotRoute();
    expect(snap.serving).toBe("free");
    expect(snap.counts.anthropic).toBe(0);
    expect(snap.counts.openai).toBe(0);
    expect(snap.counts.free).toBe(1);
  }, 30_000);

  it("waits out a long pre-first-token silence while liveness is healthy", async () => {
    backend = await startFakeFreeBackend({
      mode: "slow-first",
      firstTokenDelayMs: 4500,
      livenessOk: true,
    });
    // First-token budget deliberately SHORTER than the delay, so the call can
    // only succeed by consulting the out-of-band probe and choosing to wait.
    useTestThresholds({ FACTORY_FREE_FIRST_TOKEN_WINDOW_MS: "1200" });
    const h = harness(backend);

    const res = await h.chain.generateText({ system: "s", prompt: "p" });

    expect(res.text).toContain("OK");
    expect(h.anthropic.calls).toBe(0);
    expect(h.openai.calls).toBe(0);
    // The shadow counter must record that we nearly paid and waited instead.
    const snap = snapshotRoute();
    expect(snap.wouldHaveFailedOver).toBeGreaterThan(0);
    expect(snap.serving).toBe("free");
    expect(snap.events.some((e) => e.kind === "patience-granted")).toBe(true);
  }, 30_000);
});

/* ================================================================== */
/* TEST B — a genuine wedge MUST fail over                             */
/* ================================================================== */

describe("B. genuinely wedged free route rescues to paid", () => {
  it("detects total silence with a dead out-of-band probe and pays once", async () => {
    backend = await startFakeFreeBackend({
      mode: "silent",
      livenessOk: false, // /health, /admin/api/status and /api/ps all fail
    });
    useTestThresholds();
    const h = harness(backend);

    const res = await h.chain.generateText({ system: "s", prompt: "p" });

    expect(res.text).toBe("PAID");
    expect(h.anthropic.calls).toBe(1);
    expect(h.openai.calls).toBe(0);

    const snap = snapshotRoute();
    expect(snap.serving).toBe("anthropic");
    expect(snap.holdActive).toBe(true);
    expect(snap.lastFailoverReason).toBeTruthy();
    // The failover must be loud and carry the measurement that caused it.
    const stallLog = h.logs.find((l) => l.includes("FREE ROUTE STALLED"));
    expect(stallLog).toBeTruthy();
    expect(stallLog).toContain("liveness=dead");
    expect(h.logs.some((l) => l.includes("PAYING"))).toBe(true);
  }, 30_000);

  it("bounds a MID-STREAM wedge even while the probe keeps claiming health", async () => {
    // The real FCC keep-alive hang: the stream emits a token, then goes quiet
    // forever while /health answers 200. Healthy inter-token gaps measured at
    // most 244ms here, so prolonged mid-stream silence is real evidence of a
    // wedge — patience is generous and counted, but finite.
    backend = await startFakeFreeBackend({
      mode: "stall-after-first",
      livenessOk: true,
    });
    useTestThresholds({ FACTORY_FREE_PATIENCE_GRANTS: "2" });
    const h = harness(backend);

    const res = await h.chain.generateText({ system: "s", prompt: "p" });

    expect(res.text).toBe("PAID");
    const snap = snapshotRoute();
    // It waited through every grant before spending.
    expect(snap.wouldHaveFailedOver).toBe(2);
    expect(snap.counts.anthropic).toBe(1);
    const stallLog = h.logs.find((l) => l.includes("FREE ROUTE STALLED"));
    expect(stallLog).toContain("inter-token");
  }, 40_000);

  it("tolerates pre-first-token silence until the OUTER BACKSTOP, not before", async () => {
    // No first token and a healthy probe is genuinely ambiguous: it looks
    // identical to being third in a queue, which measured 302s here. So the
    // deck waits, and only the far-outer backstop ends it. This is the
    // "ambiguity resolves toward free" rule made testable.
    backend = await startFakeFreeBackend({ mode: "silent", livenessOk: true });
    useTestThresholds({ FACTORY_FREE_BACKSTOP_MS: "5000" });
    const h = harness(backend);

    const started = Date.now();
    const res = await h.chain.generateText({ system: "s", prompt: "p" });
    const elapsed = Date.now() - started;

    expect(res.text).toBe("PAID");
    // It waited for the whole backstop rather than the 2s first-token window.
    expect(elapsed).toBeGreaterThanOrEqual(4500);
    const snap = snapshotRoute();
    expect(snap.wouldHaveFailedOver).toBeGreaterThan(1);
    const stallLog = h.logs.find((l) => l.includes("FREE ROUTE STALLED"));
    expect(stallLog).toContain("backstop");
  }, 40_000);
});

/* ================================================================== */
/* TEST C — recovery: a stall must never pin the deck to paid          */
/* ================================================================== */

describe("C. returns to free once the free route is healthy again", () => {
  it("rescues while wedged, then serves from FREE after the hold lapses", async () => {
    backend = await startFakeFreeBackend({ mode: "silent", livenessOk: false });
    useTestThresholds();
    const h = harness(backend, { holdMs: 300 });

    // 1. Wedged -> paid.
    const first = await h.chain.generateText({ system: "s", prompt: "p" });
    expect(first.text).toBe("PAID");
    expect(snapshotRoute().holdActive).toBe(true);

    // 2. Free backend comes back.
    backend.configure({ mode: "fast", livenessOk: true });

    // 3. Wait out the hold window; it is a timestamp, so nothing else is needed.
    await new Promise((r) => setTimeout(r, 400));
    expect(snapshotRoute().holdActive).toBe(false);

    // 4. The very next call goes back to free, with no explicit recovery step.
    const second = await h.chain.generateText({ system: "s", prompt: "p" });
    expect(second.text).toContain("OK");
    expect(h.anthropic.calls).toBe(1); // still just the one rescue

    const snap = snapshotRoute();
    expect(snap.serving).toBe("free");
    expect(snap.lastRecoveryAt).toBeTruthy();
    expect(snap.events.some((e) => e.kind === "recovery")).toBe(true);
  }, 30_000);
});

/* ================================================================== */
/* TEST D — backpressure is patience, never spend                      */
/* ================================================================== */

describe("D. backpressure retries on free and never escalates", () => {
  it("rides out repeated 429s and completes on FREE", async () => {
    backend = await startFakeFreeBackend({
      mode: "backpressure",
      backpressureCount: 3,
      livenessOk: true,
    });
    useTestThresholds();
    const h = harness(backend, { maxBackpressureRetries: 6 });

    const res = await h.chain.generateText({ system: "s", prompt: "p" });

    expect(res.text).toContain("OK");
    expect(h.anthropic.calls).toBe(0);
    expect(h.openai.calls).toBe(0);
    const snap = snapshotRoute();
    expect(snap.serving).toBe("free");
    expect(snap.backpressureRetries).toBe(3);
    // A 429 is "alive, come back shortly" and must never arm the hold.
    expect(snap.holdActive).toBe(false);
  }, 30_000);

  it("classifies the alive-but-busy conditions as backpressure", () => {
    expect(isBackpressure({ status: 429 })).toBe(true);
    expect(isBackpressure({ status: 503 })).toBe(true);
    expect(isBackpressure(new Error("model is loading, please wait"))).toBe(true);
    expect(isBackpressure(new Error("server is busy"))).toBe(true);
    expect(isBackpressure(new Error("Overloaded"))).toBe(true);
    // A genuine client error is NOT backpressure.
    expect(isBackpressure({ status: 400 })).toBe(false);
    expect(isBackpressure(new Error("invalid schema"))).toBe(false);
  });
});

/* ================================================================== */
/* Guardrails on the policy itself                                     */
/* ================================================================== */

describe("policy guardrails", () => {
  it("never defaults to a paid provider", () => {
    const cfg = loadConfig({} as NodeJS.ProcessEnv);
    expect(cfg.defaultCodeProvider).toBe("free");
    expect(cfg.defaultReviewProvider).toBe("free");
    expect(cfg.free.enabled).toBe(true);
  });

  it("keeps thresholds above the worst healthy latency measured on this host", () => {
    // Locks the floors against a future 'optimisation' that tightens them.
    // 302,265ms was the slowest HEALTHY first token ever measured here; 244ms
    // the largest healthy inter-token gap.
    const t = getThresholds({} as NodeJS.ProcessEnv);
    expect(t.firstTokenWindowMs).toBeGreaterThanOrEqual(420_000);
    expect(t.idleGapWindowMs).toBeGreaterThanOrEqual(60_000);
    expect(t.idleGapWindowMs).toBeGreaterThan(244 * 100);
  });

  it("grants extra patience when work is queued ahead of the call", () => {
    // The documented "queue-not-hang" trap: with a proxy concurrency of 2, the
    // 5th in-flight call is expected to be silent for longer, so it must be
    // budgeted for longer rather than judged by a flat window.
    expect(queueBonusGrants(1, 2)).toBe(0);
    expect(queueBonusGrants(2, 2)).toBe(0);
    expect(queueBonusGrants(5, 2)).toBe(3);
    expect(queueBonusGrants(100, 2)).toBe(6); // capped
  });

  it("keeps working on FREE when no paid rescue key exists", async () => {
    // A deck with no credit card must degrade to patience, not to an error.
    backend = await startFakeFreeBackend({ mode: "fast", livenessOk: true });
    useTestThresholds();
    const h = harness(backend, { paid: false });

    const res = await h.chain.generateText({ system: "s", prompt: "p" });
    expect(res.text).toContain("OK");
    expect(snapshotRoute().serving).toBe("free");
  }, 20_000);

  it("refuses to pay past the rescue cap and falls back to free", async () => {
    backend = await startFakeFreeBackend({ mode: "silent", livenessOk: false });
    useTestThresholds();
    process.env.FACTORY_PAID_RESCUES_PER_HOUR = "0";
    resetPaidBudget();
    try {
      const h = harness(backend);
      // Free is wedged and paying is forbidden, so the chain must retry free
      // rather than spend. The retry also fails, which surfaces as an error —
      // the point is that no paid call happened.
      await h.chain.generateText({ system: "s", prompt: "p" }).catch(() => undefined);
      expect(h.anthropic.calls).toBe(0);
      expect(h.openai.calls).toBe(0);
      expect(h.logs.some((l) => l.includes("PAID RESCUE REFUSED"))).toBe(true);
    } finally {
      delete process.env.FACTORY_PAID_RESCUES_PER_HOUR;
      resetPaidBudget();
    }
  }, 40_000);

  it("returns structured JSON through the chain", async () => {
    backend = await startFakeFreeBackend({
      mode: "fast",
      livenessOk: true,
      text: '{"answer":"yes"}',
    });
    useTestThresholds();
    const h = harness(backend);
    const out = await h.chain.generateJson({
      system: "s",
      prompt: "p",
      schema: z.object({ answer: z.string() }),
      schemaName: "Answer",
    });
    expect(out.answer).toBe("yes");
    expect(h.anthropic.calls).toBe(0);
  }, 20_000);
});
