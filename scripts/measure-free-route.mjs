#!/usr/bin/env node
/**
 * measure-free-route.mjs — sample the FREE route's real latency distribution on
 * THIS machine and write the calibration Factory Deck derives its stall
 * thresholds from.
 *
 * Why this exists: a hand-picked timeout constant is the bug. The free route's
 * healthy latency here spans two orders of magnitude (a warm turn answers in
 * seconds; a cold or queued one has been measured at ~295-307s), so any single
 * constant either fails over on healthy calls (and silently spends money) or is
 * so large that a genuine wedge is unbearable.
 *
 * The fix is to measure two DIFFERENT things, because they behave differently:
 *   - firstTokenMs : silence BEFORE the first token. Cold start + queue live
 *                    here. Huge and highly variable. Not evidence of a wedge.
 *   - gapMs        : silence BETWEEN tokens once the model is emitting. Small
 *                    and stable. A large gap here IS evidence of a wedge.
 *
 * Usage:
 *   node scripts/measure-free-route.mjs [--samples 5] [--concurrent 2]
 *
 * Writes .factory/free-route-calibration.json. Costs $0 — every call goes
 * through the local FCC proxy on the free tier.
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, ".factory", "free-route-calibration.json");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
}

const SAMPLES = arg("samples", 5);
const CONCURRENT = arg("concurrent", 2);
const BASE_URL = process.env.FACTORY_FREE_BASE_URL || "http://127.0.0.1:8082";
const TOKEN = process.env.FACTORY_FREE_AUTH_TOKEN || "freecc";
const MODEL = process.env.FACTORY_FREE_MODEL || "claude-sonnet-4-5";

/**
 * One streamed call, instrumented. Returns {firstTokenMs, gaps[], totalMs, ok}.
 * Reads the SSE body by hand so timing reflects bytes off the socket rather
 * than anything an SDK might buffer.
 */
async function sample(prompt) {
  const started = Date.now();
  let firstTokenMs = null;
  let lastEventAt = started;
  const gaps = [];

  const res = await fetch(new URL("/v1/messages", BASE_URL), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 160,
      stream: true,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    return { ok: false, status: res.status, totalMs: Date.now() - started };
  }

  const reader = res.body.getReader();
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const now = Date.now();
    bytes += value.length;
    if (firstTokenMs === null) {
      firstTokenMs = now - started;
    } else {
      gaps.push(now - lastEventAt);
    }
    lastEventAt = now;
  }
  return {
    ok: true,
    firstTokenMs: firstTokenMs ?? Date.now() - started,
    gaps,
    bytes,
    totalMs: Date.now() - started,
  };
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[i];
}

function stats(values) {
  const s = [...values].sort((a, b) => a - b);
  return {
    n: s.length,
    p50: pct(s, 50),
    p95: pct(s, 95),
    p99: pct(s, 99),
    max: s.length ? s[s.length - 1] : 0,
  };
}

const PROMPTS = [
  "Reply with exactly: OK",
  "List three prime numbers, comma separated.",
  "In one sentence, what is a unit test?",
  "Name two HTTP status codes for rate limiting.",
  "Write a one-line JavaScript function that doubles a number.",
];

async function main() {
  console.log(
    `Sampling free route: ${SAMPLES} sequential + ${CONCURRENT} concurrent @ ${BASE_URL} (model ${MODEL})`,
  );
  const results = [];

  for (let i = 0; i < SAMPLES; i++) {
    const r = await sample(PROMPTS[i % PROMPTS.length]);
    results.push({ ...r, mode: "sequential" });
    console.log(
      `  [seq ${i + 1}/${SAMPLES}] ok=${r.ok} firstToken=${r.firstTokenMs ?? "-"}ms ` +
        `gaps=${r.gaps?.length ?? 0} maxGap=${r.gaps?.length ? Math.max(...r.gaps) : 0}ms total=${r.totalMs}ms`,
    );
  }

  // Concurrency deliberately exceeds the proxy's PROVIDER_MAX_CONCURRENCY so we
  // observe what QUEUED (not wedged) actually looks like from the client side.
  if (CONCURRENT > 1) {
    const batch = await Promise.all(
      Array.from({ length: CONCURRENT }, (_, i) => sample(PROMPTS[i % PROMPTS.length])),
    );
    for (const r of batch) {
      results.push({ ...r, mode: "concurrent" });
      console.log(
        `  [con] ok=${r.ok} firstToken=${r.firstTokenMs ?? "-"}ms ` +
          `gaps=${r.gaps?.length ?? 0} maxGap=${r.gaps?.length ? Math.max(...r.gaps) : 0}ms total=${r.totalMs}ms`,
      );
    }
  }

  const good = results.filter((r) => r.ok);
  const firstToken = stats(good.map((r) => r.firstTokenMs));
  const gap = stats(good.flatMap((r) => r.gaps ?? []));
  const total = stats(good.map((r) => r.totalMs));

  // Merge with any prior calibration so thresholds keep adapting instead of
  // being re-derived from one lucky afternoon.
  let prior = null;
  if (existsSync(OUT)) {
    try {
      prior = JSON.parse(readFileSync(OUT, "utf8"));
    } catch {
      /* corrupt prior calibration is simply replaced */
    }
  }
  const observedFirstTokenMax = Math.max(
    firstToken.max,
    prior?.observed?.firstTokenMs?.max ?? 0,
  );
  const observedGapMax = Math.max(gap.max, prior?.observed?.gapMs?.max ?? 0);

  const out = {
    schema: 1,
    updatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    model: MODEL,
    samples: good.length + (prior?.samples ?? 0),
    observed: {
      firstTokenMs: { ...firstToken, max: observedFirstTokenMax },
      gapMs: { ...gap, max: observedGapMax },
      totalMs: total,
    },
    failures: results.filter((r) => !r.ok),
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${OUT}`);
  console.log(JSON.stringify(out.observed, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
