import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import type {
  LLMProvider,
  GenerateTextInput,
  GenerateTextResult,
  GenerateJsonInput,
} from "../../shared/types.js";
import type { ProviderName } from "../../shared/schemas.js";

/**
 * paidBudget.ts — the blast radius around every paid provider call.
 *
 * Classification will sometimes be wrong. This file bounds the number of
 * admitted paid attempts per hour/day within one Node process. It also applies
 * a configurable USD estimate as an admission guard before each attempt.
 *
 * The ledger is persisted, so a restart loop cannot reset the day and quietly
 * multiply the cap.
 *
 * On the dollar figure, stated honestly: it is a local ESTIMATE computed from
 * token counts and global configurable rates. It is not an invoice or a hard
 * actual-spend cap: provider/model prices, cache/reasoning/tool charges, failed
 * requests, and multiple server processes can differ from this ledger. Use
 * provider-native account caps for a hard actual-dollar guarantee, and a
 * shared transactional store before running multiple Factory server processes.
 */

export interface PaidBudgetLimits {
  perHour: number;
  perDay: number;
  usdPerDay: number;
  /** Global rates for the local USD estimate; not provider billing data. */
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
  /** Present on calls reserved before billable I/O begins. */
  reservationId?: string;
  state?: "reserved" | "settled" | "unknown";
}

interface Ledger {
  schema: 1;
  entries: LedgerEntry[];
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface PaidCallEstimate {
  system: string;
  prompt: string;
  maxTokens?: number;
}

export interface PaidCallReservation {
  id: string;
  provider: string;
}

function optionalCap(raw: string | undefined, integer: boolean): number {
  if (raw === undefined) return Infinity;
  const trimmed = raw.trim();
  const value = Number(trimmed);
  return trimmed &&
    Number.isFinite(value) &&
    value >= 0 &&
    (!integer || Number.isInteger(value))
    ? value
    : 0;
}

function rate(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  const value = Number(trimmed);
  return trimmed && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function configurationFault(env: NodeJS.ProcessEnv): string | null {
  const specifications: Array<[string, boolean]> = [
    ["FACTORY_PAID_RESCUES_PER_HOUR", true],
    ["FACTORY_PAID_RESCUES_PER_DAY", true],
    ["FACTORY_PAID_MAX_USD_PER_DAY", false],
    ["FACTORY_PAID_USD_PER_MTOK_IN", false],
    ["FACTORY_PAID_USD_PER_MTOK_OUT", false],
  ];
  for (const [name, integer] of specifications) {
    const raw = env[name];
    if (raw === undefined) continue;
    const trimmed = raw.trim();
    const value = Number(trimmed);
    if (
      !trimmed ||
      !Number.isFinite(value) ||
      value < 0 ||
      (integer && !Number.isInteger(value))
    ) {
      return `${name} must be ${integer ? "a non-negative integer" : "a non-negative finite number"}`;
    }
  }
  return null;
}

/**
 * NO INVENTED SPEND CAPS (owner correction 2026-08-16: "I don't know where
 * the $2 a day cap came from. i never asked for it"). The 6/hour, 24/day and
 * $2/day defaults were self-imposed guardrails that silently blocked ordered
 * work - the banned class. Defaults are now UNLIMITED: the ledger still
 * records every paid call so spend can be reported honestly, but nothing is
 * refused unless the OWNER sets an explicit limit env var.
 */
export function loadLimits(env: NodeJS.ProcessEnv = process.env): PaidBudgetLimits {
  return {
    perHour: optionalCap(env.FACTORY_PAID_RESCUES_PER_HOUR, true),
    perDay: optionalCap(env.FACTORY_PAID_RESCUES_PER_DAY, true),
    usdPerDay: optionalCap(env.FACTORY_PAID_MAX_USD_PER_DAY, false),
    usdPerMtokIn: rate(env.FACTORY_PAID_USD_PER_MTOK_IN, 20),
    usdPerMtokOut: rate(env.FACTORY_PAID_USD_PER_MTOK_OUT, 100),
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
let ledgerFault: string | null = null;

/** Test seam — drops the in-memory ledger so the next read hits disk. */
export function resetPaidBudget(): void {
  cache = null;
  ledgerFault = null;
}

function readLedger(env: NodeJS.ProcessEnv = process.env): Ledger {
  if (cache) return cache;
  const path = ledgerPath(env);
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (validLedger(parsed)) {
        cache = { schema: 1, entries: parsed.entries };
        ledgerFault = null;
        return cache;
      }
      ledgerFault = "paid budget ledger has an invalid shape";
    } catch (error) {
      ledgerFault = `paid budget ledger is unreadable: ${String(
        (error as Error)?.message ?? error,
      )}`;
    }
  }
  cache = { schema: 1, entries: [] };
  return cache;
}

function validLedger(value: unknown): value is Ledger {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { schema?: unknown; entries?: unknown };
  if (candidate.schema !== 1 || !Array.isArray(candidate.entries)) return false;
  return candidate.entries.every((raw) => {
    if (!raw || typeof raw !== "object") return false;
    const entry = raw as Partial<LedgerEntry>;
    if (
      !Number.isFinite(entry.ts) ||
      Number(entry.ts) < 0 ||
      typeof entry.provider !== "string" ||
      entry.provider.length === 0 ||
      !Number.isFinite(entry.usd) ||
      Number(entry.usd) < 0 ||
      !Number.isFinite(entry.inTokens) ||
      Number(entry.inTokens) < 0 ||
      !Number.isFinite(entry.outTokens) ||
      Number(entry.outTokens) < 0
    ) {
      return false;
    }
    if (
      entry.reservationId !== undefined &&
      (typeof entry.reservationId !== "string" || !entry.reservationId)
    ) {
      return false;
    }
    return (
      entry.state === undefined ||
      entry.state === "reserved" ||
      entry.state === "settled" ||
      entry.state === "unknown"
    );
  });
}

function hasFiniteCap(env: NodeJS.ProcessEnv = process.env): boolean {
  const limits = loadLimits(env);
  return (
    Number.isFinite(limits.perHour) ||
    Number.isFinite(limits.perDay) ||
    Number.isFinite(limits.usdPerDay)
  );
}

function writeLedger(led: Ledger, env: NodeJS.ProcessEnv = process.env): boolean {
  const path = ledgerPath(env);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporary, JSON.stringify(led, null, 2), { mode: 0o600 });
    renameSync(temporary, path);
    ledgerFault = null;
    return true;
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary may never have been created.
    }
    ledgerFault = `paid budget ledger cannot be persisted: ${String(
      (error as Error)?.message ?? error,
    )}`;
    return false;
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
  if (
    !Number.isFinite(inTokens) ||
    inTokens < 0 ||
    !Number.isFinite(outTokens) ||
    outTokens < 0
  ) {
    throw new RangeError("paid usage tokens must be finite and non-negative");
  }
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
  const configFault = configurationFault(env);
  if (configFault) {
    reason = `${configFault}; paid calls fail closed`;
  } else if (ledgerFault && hasFiniteCap(env)) {
    reason = `${ledgerFault}; finite paid caps fail closed`;
  } else if (lastHour >= limits.perHour) {
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
  led.entries.push({
    ts: Date.now(),
    provider,
    usd,
    inTokens,
    outTokens,
    state: "settled",
  });
  prune(led);
  writeLedger(led, env);
  return usd;
}

/** Raised when a paid rescue is refused because a cap is exhausted. */
export class PaidBudgetExhaustedError extends Error {
  readonly status = 402;

  constructor(reason: string) {
    super(
      `Paid provider call refused — ${reason}. This refused attempt did not reach the provider; ` +
        `earlier attempts, if any, remain recorded. ` +
        `raise FACTORY_PAID_RESCUES_PER_HOUR / _PER_DAY / FACTORY_PAID_MAX_USD_PER_DAY to allow more.`,
    );
    this.name = "PaidBudgetExhaustedError";
  }
}

/**
 * Reserve one billable call before any provider I/O begins.
 *
 * The check, append, and persisted write are deliberately synchronous. The
 * backend is a single Node process, so this makes reservation atomic across
 * concurrent HTTP/run tasks: a second caller observes the first reservation
 * before it can reach a paid SDK. Dollar reservations use a conservative
 * upper estimate (UTF-8 bytes as input tokens, plus protocol overhead and the
 * requested output ceiling) so the local estimated-spend guard refuses a
 * burst whose admission estimate is already above its configured threshold.
 */
export function reservePaidCall(
  provider: string,
  input: PaidCallEstimate,
  env: NodeJS.ProcessEnv = process.env,
): PaidCallReservation {
  const led = readLedger(env);
  prune(led);
  const limits = loadLimits(env);
  const configFault = configurationFault(env);
  if (configFault) {
    throw new PaidBudgetExhaustedError(`${configFault}; paid calls fail closed`);
  }
  if (ledgerFault && hasFiniteCap(env)) {
    throw new PaidBudgetExhaustedError(`${ledgerFault}; finite paid caps fail closed`);
  }
  const now = Date.now();
  const lastHour = led.entries.filter((entry) => entry.ts >= now - HOUR_MS).length;
  const dayEntries = led.entries.filter((entry) => entry.ts >= now - DAY_MS);
  const lastDay = dayEntries.length;
  const usdLastDay = dayEntries.reduce((sum, entry) => sum + entry.usd, 0);
  const requestedMaxTokens = input.maxTokens ?? 8_192;
  if (
    !Number.isFinite(requestedMaxTokens) ||
    !Number.isInteger(requestedMaxTokens) ||
    requestedMaxTokens <= 0
  ) {
    throw new PaidBudgetExhaustedError(
      "maxTokens must be a positive finite integer; paid calls fail closed",
    );
  }
  const inTokens = Math.max(
    1,
    Buffer.byteLength(input.system, "utf8") +
      Buffer.byteLength(input.prompt, "utf8") +
      1_024,
  );
  const outTokens = requestedMaxTokens;
  const usd = estimateUsd(inTokens, outTokens, limits);

  let reason: string | null = null;
  if (lastHour >= limits.perHour) {
    reason = `paid-rescue cap reached: ${lastHour}/${limits.perHour} in the last hour`;
  } else if (lastDay >= limits.perDay) {
    reason = `paid-rescue cap reached: ${lastDay}/${limits.perDay} in the last 24h`;
  } else if (usdLastDay + usd > limits.usdPerDay) {
    reason = `paid-rescue spend ceiling would be exceeded: est. $${usdLastDay.toFixed(
      4,
    )} + $${usd.toFixed(4)} of $${limits.usdPerDay.toFixed(2)} in the last 24h`;
  }
  if (reason) throw new PaidBudgetExhaustedError(reason);

  const reservation: PaidCallReservation = {
    id: randomUUID(),
    provider,
  };
  led.entries.push({
    ts: now,
    provider,
    usd,
    inTokens,
    outTokens,
    reservationId: reservation.id,
    state: "reserved",
  });
  if (!writeLedger(led, env) && hasFiniteCap(env)) {
    throw new PaidBudgetExhaustedError(
      `${ledgerFault ?? "paid budget ledger cannot be persisted"}; finite paid caps fail closed`,
    );
  }
  return reservation;
}

/** Replace an in-flight reservation with the call's actual usage estimate. */
export function settlePaidCall(
  reservation: PaidCallReservation,
  usage?: { inTokens: number; outTokens: number },
  env: NodeJS.ProcessEnv = process.env,
): number {
  const led = readLedger(env);
  const entry = led.entries.find(
    (candidate) => candidate.reservationId === reservation.id,
  );
  const validUsage =
    usage !== undefined &&
    Number.isFinite(usage.inTokens) &&
    usage.inTokens >= 0 &&
    Number.isFinite(usage.outTokens) &&
    usage.outTokens >= 0;
  if (!entry) {
    return validUsage
      ? recordPaidCall(reservation.provider, usage!.inTokens, usage!.outTokens, env)
      : 0;
  }
  if (usage && !validUsage) {
    entry.state = "unknown";
    writeLedger(led, env);
    return entry.usd;
  }
  const actualUsd = validUsage
    ? estimateUsd(usage!.inTokens, usage!.outTokens, loadLimits(env))
    : entry.usd;
  if (validUsage) {
    entry.inTokens = usage!.inTokens;
    entry.outTokens = usage!.outTokens;
    // The conservative amount protects admission only while in-flight. Once
    // usage is known, report the real estimate so health/spend displays do not
    // turn a temporary reservation into permanent phantom spend.
    entry.usd = actualUsd;
  }
  entry.state = "settled";
  writeLedger(led, env);
  return actualUsd;
}

/** Keep a failed/aborted billable attempt conservatively charged as unknown. */
export function abandonPaidCall(
  reservation: PaidCallReservation,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const led = readLedger(env);
  const entry = led.entries.find(
    (candidate) => candidate.reservationId === reservation.id,
  );
  if (!entry) return;
  entry.state = "unknown";
  writeLedger(led, env);
}

/**
 * Wraps a PAID raw provider (anthropic/openai) with a per-call budget check.
 *
 * `FailoverProvider.runPaid()` already checks `canPayNow()` before every paid
 * call it makes — but that gate lives INSIDE the failover chain. Any caller
 * that reaches a raw paid provider directly (bypassing the chain — which is
 * exactly what dispatching concurrent work across a pool of distinct
 * backends does) would spend with no gate at all. This wrapper closes that
 * gap for unmanaged/test providers at the one choke point their raw calls go
 * through. Production SDK providers reserve each actual request themselves so
 * retries and format fallbacks cannot share one admission.
 *
 * Re-checks on EVERY call (not once when the pool is built) so a burst of
 * concurrent calls that would collectively blow the cap gets stopped
 * mid-burst rather than only refused on the NEXT dispatch.
 */
export class BudgetGatedProvider implements LLMProvider {
  constructor(
    private inner: LLMProvider,
    readonly name: ProviderName,
  ) {}

  isConfigured(): boolean {
    return this.inner.isConfigured();
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
    const reservation = reservePaidCall(this.name, input);
    try {
      const result = await this.inner.generateText(input);
      settlePaidCall(reservation);
      return result;
    } catch (error) {
      abandonPaidCall(reservation);
      throw error;
    }
  }

  async generateJson<T>(input: GenerateJsonInput<T>): Promise<T> {
    const reservation = reservePaidCall(this.name, input);
    try {
      const result = await this.inner.generateJson(input);
      settlePaidCall(reservation);
      return result;
    } catch (error) {
      abandonPaidCall(reservation);
      throw error;
    }
  }
}
