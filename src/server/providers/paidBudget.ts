import {
  closeSync,
  constants as FS,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
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
 * paidBudget.ts — durable, fail-closed authorization for billable calls.
 *
 * A paid call reserves both one call slot and a conservative maximum token
 * estimate before any SDK request starts. Reservations are written atomically
 * and included in every status calculation, so concurrent workers cannot all
 * observe the same final slot and overspend it. Billed usage is recorded as an
 * independent settled entry; the outer gate releases its exact reservation ID
 * only after the logical call succeeds.
 */

export interface PaidBudgetLimits {
  perHour: number;
  perDay: number;
  usdPerDay: number;
  usdPerMtokIn: number;
  usdPerMtokOut: number;
}

export interface PaidBudgetStatus {
  lastHour: number;
  lastDay: number;
  usdLastDay: number;
  reserved: number;
  limits: PaidBudgetLimits;
  exhausted: boolean;
  reason: string | null;
}

type LedgerState = "reserved" | "settled";

interface LedgerEntry {
  id: string;
  state: LedgerState;
  ts: number;
  provider: string;
  usd: number;
  inTokens: number;
  outTokens: number;
}

interface Ledger {
  schema: 2;
  entries: LedgerEntry[];
  /** In-memory only. A corrupt durable ledger blocks paid work. */
  fault?: string;
}

interface LegacyLedger {
  schema?: 1;
  entries?: Array<{
    ts?: unknown;
    provider?: unknown;
    usd?: unknown;
    inTokens?: unknown;
    outTokens?: unknown;
  }>;
}

export interface PaidCallReservation {
  id: string;
  provider: string;
  reservedUsd: number;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function num(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Defaults must be finite and JSON-safe. Infinity serialized to null in
 * /api/health, hid the fact that hundreds of paid calls were unrestricted,
 * and also failed the shared Zod health contract.
 */
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
let cachePath: string | null = null;

/** Test seam — drops the in-memory ledger so the next read hits disk. */
export function resetPaidBudget(): void {
  cache = null;
  cachePath = null;
}

function finiteNonnegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function decodeLedger(raw: unknown): Ledger {
  if (!raw || typeof raw !== "object") throw new Error("ledger is not an object");
  const parsed = raw as { schema?: unknown; entries?: unknown };
  if (!Array.isArray(parsed.entries)) throw new Error("ledger entries are missing");

  if (parsed.schema === 2) {
    const entries = parsed.entries.map((candidate) => {
      if (!candidate || typeof candidate !== "object") {
        throw new Error("ledger entry is not an object");
      }
      const entry = candidate as Partial<LedgerEntry>;
      const ts = finiteNonnegative(entry.ts);
      const usd = finiteNonnegative(entry.usd);
      const inTokens = finiteNonnegative(entry.inTokens);
      const outTokens = finiteNonnegative(entry.outTokens);
      if (
        typeof entry.id !== "string" ||
        (entry.state !== "reserved" && entry.state !== "settled") ||
        typeof entry.provider !== "string" ||
        ts === null ||
        usd === null ||
        inTokens === null ||
        outTokens === null
      ) {
        throw new Error("ledger entry has an invalid shape");
      }
      return {
        id: entry.id,
        state: entry.state,
        provider: entry.provider,
        ts,
        usd,
        inTokens,
        outTokens,
      };
    });
    return { schema: 2, entries };
  }

  // Schema 1 contained settled usage only. Migrate it in memory; the next
  // reservation/settlement writes schema 2 atomically.
  if (parsed.schema === 1 || parsed.schema === undefined) {
    const legacyEntries = parsed.entries as NonNullable<LegacyLedger["entries"]>;
    const entries = legacyEntries.map((candidate) => {
      const ts = finiteNonnegative(candidate.ts);
      const usd = finiteNonnegative(candidate.usd);
      const inTokens = finiteNonnegative(candidate.inTokens);
      const outTokens = finiteNonnegative(candidate.outTokens);
      if (
        typeof candidate.provider !== "string" ||
        ts === null ||
        usd === null ||
        inTokens === null ||
        outTokens === null
      ) {
        throw new Error("legacy ledger entry has an invalid shape");
      }
      return {
        id: randomUUID(),
        state: "settled" as const,
        provider: candidate.provider,
        ts,
        usd,
        inTokens,
        outTokens,
      };
    });
    return { schema: 2, entries };
  }
  throw new Error(`unsupported ledger schema ${String(parsed.schema)}`);
}

function readLedger(env: NodeJS.ProcessEnv = process.env): Ledger {
  const path = ledgerPath(env);
  if (cache && cachePath === path) return cache;
  cachePath = path;
  if (!existsSync(path)) {
    cache = { schema: 2, entries: [] };
    return cache;
  }
  try {
    cache = decodeLedger(JSON.parse(readFileSync(path, "utf8")));
  } catch (err) {
    cache = {
      schema: 2,
      entries: [],
      fault:
        "paid budget ledger is unreadable; paid calls are blocked until it is repaired",
    };
  }
  return cache;
}

function writeLedgerAtomically(
  led: Ledger,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const path = ledgerPath(env);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(temp, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL, 0o600);
    writeFileSync(fd, JSON.stringify({ schema: 2, entries: led.entries }, null, 2));
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temp, path);
    try {
      const dirFd = openSync(dirname(path), FS.O_RDONLY);
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {
      // Windows does not permit fsync on directories. The file itself was
      // synced and rename remains the atomic commit point.
    }
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore cleanup error; original write error wins
      }
    }
    rmSync(temp, { force: true });
  }
}

function cloneLedger(led: Ledger): Ledger {
  return {
    schema: 2,
    entries: led.entries.map((entry) => ({ ...entry })),
    ...(led.fault ? { fault: led.fault } : {}),
  };
}

function prune(led: Ledger): void {
  const cutoff = Date.now() - 2 * DAY_MS;
  led.entries = led.entries.filter((entry) => entry.ts >= cutoff);
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
  const hourEntries = led.entries.filter((entry) => entry.ts >= now - HOUR_MS);
  const dayEntries = led.entries.filter((entry) => entry.ts >= now - DAY_MS);
  const lastHour = hourEntries.length;
  const lastDay = dayEntries.length;
  const usdLastDay = dayEntries.reduce((sum, entry) => sum + entry.usd, 0);
  const reserved = dayEntries.filter((entry) => entry.state === "reserved").length;

  let reason: string | null = led.fault ?? null;
  if (!reason && lastHour >= limits.perHour) {
    reason = `paid-rescue cap reached: ${lastHour}/${limits.perHour} in the last hour`;
  } else if (!reason && lastDay >= limits.perDay) {
    reason = `paid-rescue cap reached: ${lastDay}/${limits.perDay} in the last 24h`;
  } else if (!reason && usdLastDay >= limits.usdPerDay) {
    reason = `paid-rescue spend ceiling reached: est. $${usdLastDay.toFixed(
      4,
    )} of $${limits.usdPerDay.toFixed(2)} in the last 24h`;
  }

  return {
    lastHour,
    lastDay,
    usdLastDay,
    reserved,
    limits,
    exhausted: reason !== null,
    reason,
  };
}

export function canPayNow(env: NodeJS.ProcessEnv = process.env): {
  ok: boolean;
  reason: string | null;
} {
  const status = paidBudgetStatus(env);
  return { ok: !status.exhausted, reason: status.reason };
}

/** Raised before a paid call when authorization cannot be durably reserved. */
export class PaidBudgetExhaustedError extends Error {
  constructor(reason: string) {
    super(
      `Paid call refused — ${reason}. Raise the explicit FACTORY_PAID_* limits only if you authorize the additional spend.`,
    );
    this.name = "PaidBudgetExhaustedError";
  }
}

/**
 * Atomically reserve one concurrent paid call. The input estimate uses UTF-8
 * bytes as a conservative token ceiling; output uses the request's maxTokens.
 */
export function reservePaidCall(
  provider: string,
  estimatedInTokens: number,
  maxOutTokens: number,
  env: NodeJS.ProcessEnv = process.env,
): PaidCallReservation {
  const limits = loadLimits(env);
  const status = paidBudgetStatus(env);
  if (status.exhausted) {
    throw new PaidBudgetExhaustedError(status.reason ?? "budget exhausted");
  }

  const reservedUsd = estimateUsd(
    Math.max(0, Math.ceil(estimatedInTokens)),
    Math.max(0, Math.ceil(maxOutTokens)),
    limits,
  );
  if (status.usdLastDay + reservedUsd > limits.usdPerDay) {
    throw new PaidBudgetExhaustedError(
      `next call reserves est. $${reservedUsd.toFixed(4)}, which would exceed the $${limits.usdPerDay.toFixed(2)} daily ceiling`,
    );
  }

  const current = readLedger(env);
  if (current.fault) throw new PaidBudgetExhaustedError(current.fault);
  const next = cloneLedger(current);
  const reservation: PaidCallReservation = {
    id: randomUUID(),
    provider,
    reservedUsd,
  };
  next.entries.push({
    id: reservation.id,
    state: "reserved",
    ts: Date.now(),
    provider,
    usd: reservedUsd,
    inTokens: Math.max(0, Math.ceil(estimatedInTokens)),
    outTokens: Math.max(0, Math.ceil(maxOutTokens)),
  });
  prune(next);
  try {
    writeLedgerAtomically(next, env);
  } catch (err) {
    throw new PaidBudgetExhaustedError(
      `budget reservation could not be persisted: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  cache = next;
  cachePath = ledgerPath(env);
  return reservation;
}

/**
 * Release an unbilled reservation. Failure intentionally leaves it in place:
 * an uncertain ledger must over-count rather than authorize extra spend.
 */
export function releasePaidReservation(
  reservationId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const current = readLedger(env);
  const index = current.entries.findIndex(
    (entry) => entry.id === reservationId && entry.state === "reserved",
  );
  if (index < 0) return false; // already settled
  const next = cloneLedger(current);
  next.entries.splice(index, 1);
  try {
    writeLedgerAtomically(next, env);
    cache = next;
    cachePath = ledgerPath(env);
    return true;
  } catch {
    return false;
  }
}

/**
 * Record one billed SDK request.
 *
 * Usage callbacks do not carry the outer logical reservation id, and matching
 * merely by provider is unsafe under concurrency: a later call can finish
 * first and accidentally consume an earlier call's reservation. Append the
 * settled usage independently; BudgetGatedProvider releases its own exact id
 * only after the logical call succeeds. The brief overlap intentionally
 * double-counts in-flight usage rather than opening an overspend window.
 */
export function recordPaidCall(
  provider: string,
  inTokens: number,
  outTokens: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const limits = loadLimits(env);
  const usd = estimateUsd(inTokens, outTokens, limits);
  const current = readLedger(env);
  const next = cloneLedger(current);
  next.entries.push({
    id: randomUUID(),
    state: "settled",
    ts: Date.now(),
    provider,
    usd,
    inTokens: Math.max(0, inTokens),
    outTokens: Math.max(0, outTokens),
  });
  prune(next);
  try {
    writeLedgerAtomically(next, env);
    cache = next;
    cachePath = ledgerPath(env);
  } catch {
    // Keep the prior durable/in-memory reservation. It is more restrictive
    // than losing the actual charge and therefore fail-closed.
  }
  return usd;
}

function conservativeInputTokens(input: { system?: string; prompt?: string }): number {
  return Buffer.byteLength(`${input.system ?? ""}\n${input.prompt ?? ""}`, "utf8");
}

/** Wrap one concrete paid provider with a per-logical-call reservation. */
export class BudgetGatedProvider implements LLMProvider {
  constructor(
    private inner: LLMProvider,
    readonly name: ProviderName,
  ) {}

  isConfigured(): boolean {
    return this.inner.isConfigured();
  }

  private reserve(
    input: { system?: string; prompt?: string; maxTokens?: number },
    defaultMaxTokens: number,
  ): PaidCallReservation {
    return reservePaidCall(
      this.name,
      conservativeInputTokens(input),
      input.maxTokens ?? defaultMaxTokens,
    );
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
    const reservation = this.reserve(input, 4096);
    try {
      const result = await this.inner.generateText(input);
      releasePaidReservation(reservation.id);
      return result;
    } catch (err) {
      // The transport may have failed after the upstream accepted/billed the
      // request but before usage reached our sink. Keep the reservation when
      // billing is uncertain; operators can reconcile it explicitly instead
      // of the deck silently reopening spend capacity.
      throw err;
    }
  }

  async generateJson<T>(input: GenerateJsonInput<T>): Promise<T> {
    const reservation = this.reserve(input, 8192);
    try {
      const result = await this.inner.generateJson(input);
      releasePaidReservation(reservation.id);
      return result;
    } catch (err) {
      throw err;
    }
  }
}
