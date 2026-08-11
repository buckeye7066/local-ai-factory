import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * paidBudget.ts — the blast radius around the paid rescue.
 *
 * Classification will sometimes be wrong. This file makes "wrong" cheap: even
 * if every stall detector misfires at once, the deck cannot run up a bill,
 * because paid rescues are capped per hour, per day, and by an estimated
 * dollar ceiling that ABORTS rather than exceeds.
 *
 * The ledger is persisted, so a restart loop cannot reset the day and quietly
 * multiply the cap.
 *
 * On the dollar figure, stated honestly: it is an ESTIMATE computed from token
 * usage times a configurable rate. The default rates are deliberately set
 * ABOVE current list prices so the ceiling trips early rather than late — a
 * budget that errs toward stopping is the only kind worth having here. Set
 * FACTORY_PAID_USD_PER_MTOK_* to your real rates for an accurate ledger.
 */

export interface PaidBudgetLimits {
  perHour: number;
  perDay: number;
  usdPerDay: number;
  /** Deliberately high default rates — see the note above. */
  usdPerMtokIn: number;
  usdPerMtokOut: number;
}

export interface PaidBudgetStatus {
  lastHour: number;
  lastDay: number;
  usdLastDay: number;
  limits: PaidBudgetLimits;
  /** True when at least one cap is exhausted and paid rescue is refused. */
  exhausted: boolean;
  reason: string | null;
}

interface LedgerEntry {
  ts: number;
  provider: string;
  usd: number;
  inTokens: number;
  outTokens: number;
}

interface Ledger {
  schema: 1;
  entries: LedgerEntry[];
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function num(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function loadLimits(env: NodeJS.ProcessEnv = process.env): PaidBudgetLimits {
  return {
    perHour: num(env.FACTORY_PAID_RESCUES_PER_HOUR, 6),
    perDay: num(env.FACTORY_PAID_RESCUES_PER_DAY, 24),
    usdPerDay: num(env.FACTORY_PAID_MAX_USD_PER_DAY, 2),
    usdPerMtokIn: num(env.FACTORY_PAID_USD_PER_MTOK_IN, 20),
    usdPerMtokOut: num(env.FACTORY_PAID_USD_PER_MTOK_OUT, 100),
  };
}

function ledgerPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(
    process.cwd(),
    env.FACTORY_DATA_DIR || ".factory",
    "paid-rescue-budget.json",
  );
}

let cache: Ledger | null = null;

/** Test seam — drops the in-memory ledger so the next read hits disk. */
export function resetPaidBudget(): void {
  cache = null;
}

function readLedger(env: NodeJS.ProcessEnv = process.env): Ledger {
  if (cache) return cache;
  const path = ledgerPath(env);
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Ledger;
      if (parsed && Array.isArray(parsed.entries)) {
        cache = { schema: 1, entries: parsed.entries };
        return cache;
      }
    } catch {
      /* a corrupt ledger must not disable the cap — start a fresh one */
    }
  }
  cache = { schema: 1, entries: [] };
  return cache;
}

function writeLedger(led: Ledger, env: NodeJS.ProcessEnv = process.env): void {
  const path = ledgerPath(env);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(led, null, 2));
  } catch {
    /* an unwritable ledger still enforces the cap in-memory for this process */
  }
}

function prune(led: Ledger): void {
  const cutoff = Date.now() - 2 * DAY_MS;
  led.entries = led.entries.filter((e) => e.ts >= cutoff);
}

export function estimateUsd(
  inTokens: number,
  outTokens: number,
  limits: PaidBudgetLimits,
): number {
  return (
    (inTokens / 1_000_000) * limits.usdPerMtokIn +
    (outTokens / 1_000_000) * limits.usdPerMtokOut
  );
}

export function paidBudgetStatus(
  env: NodeJS.ProcessEnv = process.env,
): PaidBudgetStatus {
  const limits = loadLimits(env);
  const led = readLedger(env);
  prune(led);
  const now = Date.now();
  const lastHour = led.entries.filter((e) => e.ts >= now - HOUR_MS).length;
  const dayEntries = led.entries.filter((e) => e.ts >= now - DAY_MS);
  const lastDay = dayEntries.length;
  const usdLastDay = dayEntries.reduce((a, e) => a + e.usd, 0);

  let reason: string | null = null;
  if (lastHour >= limits.perHour) {
    reason = `paid-rescue cap reached: ${lastHour}/${limits.perHour} in the last hour`;
  } else if (lastDay >= limits.perDay) {
    reason = `paid-rescue cap reached: ${lastDay}/${limits.perDay} in the last 24h`;
  } else if (usdLastDay >= limits.usdPerDay) {
    reason = `paid-rescue spend ceiling reached: est. $${usdLastDay.toFixed(
      4,
    )} of $${limits.usdPerDay.toFixed(2)} in the last 24h`;
  }

  return { lastHour, lastDay, usdLastDay, limits, exhausted: reason !== null, reason };
}

/** True when another paid rescue is permitted right now. */
export function canPayNow(env: NodeJS.ProcessEnv = process.env): {
  ok: boolean;
  reason: string | null;
} {
  const s = paidBudgetStatus(env);
  return { ok: !s.exhausted, reason: s.reason };
}

/** Record one paid rescue. Returns the estimated cost of THIS call. */
export function recordPaidCall(
  provider: string,
  inTokens: number,
  outTokens: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const limits = loadLimits(env);
  const usd = estimateUsd(inTokens, outTokens, limits);
  const led = readLedger(env);
  led.entries.push({ ts: Date.now(), provider, usd, inTokens, outTokens });
  prune(led);
  writeLedger(led, env);
  return usd;
}

/** Raised when a paid rescue is refused because a cap is exhausted. */
export class PaidBudgetExhaustedError extends Error {
  constructor(reason: string) {
    super(
      `Paid rescue refused — ${reason}. The free route stays primary; ` +
        `raise FACTORY_PAID_RESCUES_PER_HOUR / _PER_DAY / FACTORY_PAID_MAX_USD_PER_DAY to allow more.`,
    );
    this.name = "PaidBudgetExhaustedError";
  }
}
