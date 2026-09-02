import { spawn, execFileSync } from "node:child_process";
import { openSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ProviderName } from "../../shared/schemas.js";

/**
 * freeRoute.ts — everything that knows whether the FREE local route (the FCC
 * proxy that "Claude Code - FREE (Ollama)" turns on) is ALIVE, as distinct from
 * merely SLOW.
 *
 * ── The one failure this file exists to prevent ────────────────────────────
 * Factory Deck must never silently convert a free setup into a metered one by
 * mistaking a healthy-but-slow free route for a dead one. A deck that runs on
 * free and occasionally waits is a success. A deck that is snappy because it
 * quietly failed over to a paid provider is a failure.
 *
 * ── Why a timeout cannot implement that ────────────────────────────────────
 * A wall-clock deadline measures elapsed time, and elapsed time does not
 * distinguish "queued and progressing" from "wedged". Measured on this host:
 * a warm free turn answered in 4.6s; a cold/queued one took 294.8s and was
 * perfectly healthy (FlexFactor separately measured a healthy 307s ping). Any
 * constant below ~300s fails over on healthy calls and spends real money; any
 * constant far above it makes a genuine wedge unbearable. The constant is the
 * bug.
 *
 * ── What replaces it ───────────────────────────────────────────────────────
 * Evidence of liveness, from three independent sources:
 *
 *   1. IN-BAND PROGRESS (primary). The free route streams, so we run an
 *      idle-progress timer that resets on every byte off the socket — never a
 *      total-elapsed timer. Silence BEFORE the first token (cold start, queue)
 *      and silence BETWEEN tokens are budgeted separately, because they are
 *      different phenomena: the first is huge and normal, the second is small
 *      and stable. A 400s response that dribbles a token every 30s is healthy
 *      and must not fail over; 60s of dead air mid-stream is a wedge.
 *
 *   2. OUT-OF-BAND LIVENESS. Before declaring a stall we ask the backend
 *      directly: the FCC proxy's /health and /admin/api/status, and Ollama's
 *      /api/ps (is a model actually resident?). A slow response from a
 *      demonstrably working backend is not a failover condition.
 *
 *   3. QUEUE DEPTH. The proxy serves a bounded number of concurrent requests
 *      (PROVIDER_MAX_CONCURRENCY, 2 on this host). If our own calls are queued
 *      behind each other, the expected wait scales with the queue, so the
 *      patience budget scales with it too. This is the documented
 *      "queue-not-hang" trap.
 *
 * Ambiguity resolves toward FREE: an inconclusive probe buys patience, never a
 * paid call. Only an affirmatively DEAD backend escalates immediately.
 *
 * ── The one deliberate exception, stated plainly ───────────────────────────
 * Bounded patience still expires even while the out-of-band probe says "alive".
 * That is intentional and is the real-world failure FlexFactor was built
 * around: the FCC keep-alive hang leaves /health answering 200 while the
 * stream never produces another byte. A strict "only escalate when in-band and
 * out-of-band agree it is dead" rule would hang forever on exactly that bug.
 * So patience is generous, derived from measurement, counted, and logged
 * loudly — but finite. Every expiry is recorded as a route event with the
 * measurement that caused it.
 */

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export interface StallMeasurement {
  /** Which silence tripped: before the first token, or between tokens. */
  phase: "first-token" | "inter-token" | "backstop";
  /** How long the route was silent, in ms. */
  silentMs: number;
  /** The budget that silence exceeded, in ms. */
  windowMs: number;
  /** Bytes received before the silence began. */
  bytesReceived: number;
  /** Total elapsed for the call when the stall was declared. */
  elapsedMs: number;
  /** Patience grants consumed before giving up. */
  patienceGrants: number;
  /** What the out-of-band probe said at the moment of the decision. */
  liveness: LivenessVerdict;
  livenessDetail: string;
  /** Our own in-flight free calls when the stall was declared. */
  queueDepth: number;
}

/**
 * Raised when the free route is judged WEDGED — silent past its measured
 * patience budget with no evidence of progress. This is the only free-route
 * error that may trigger a paid rescue and arm the hold window.
 */
export class FreeRouteStallError extends Error {
  readonly measurement: StallMeasurement;
  constructor(measurement: StallMeasurement) {
    super(
      `Free route stalled: ${Math.round(measurement.silentMs / 1000)}s of silence ` +
        `in the ${measurement.phase} phase (budget ${Math.round(
          measurement.windowMs / 1000,
        )}s, ${measurement.patienceGrants} patience grant(s) used, ` +
        `out-of-band liveness=${measurement.liveness}). Call abandoned.`,
    );
    this.name = "FreeRouteStallError";
    this.measurement = measurement;
  }
}

/**
 * Raised for "alive, come back shortly" conditions — 429, 503, queue-full,
 * model-loading, cold start. These retry on FREE with backoff and must NEVER
 * escalate to a paid provider.
 */
export class FreeRouteBackpressureError extends Error {
  readonly retryAfterMs: number;
  constructor(reason: string, retryAfterMs: number) {
    super(`Free route backpressure (${reason}); retrying on free.`);
    this.name = "FreeRouteBackpressureError";
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * True when an error means "the backend is alive but busy" rather than "the
 * backend is broken". Deliberately generous: misreading backpressure as
 * failure is the expensive mistake, misreading failure as backpressure only
 * costs a retry on a free call.
 */
export function isBackpressure(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  if (status === 429 || status === 503 || status === 502 || status === 504) {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /rate.?limit|too many requests|overloaded|capacity|queue.?full|model is loading|loading model|warming up|try again|temporarily unavailable|server is busy/i.test(
    msg,
  );
}

/* ------------------------------------------------------------------ */
/* Route state (observable — /api/health reads this)                   */
/* ------------------------------------------------------------------ */

export type RouteEventKind =
  | "failover"
  | "recovery"
  | "hold-armed"
  | "hold-expired"
  | "patience-granted"
  | "backpressure"
  | "proxy-restart"
  | "proxy-down"
  | "budget-refused";

export interface RouteEvent {
  ts: number;
  kind: RouteEventKind;
  from: ProviderName | null;
  to: ProviderName | null;
  reason: string;
}

export interface RouteSnapshot {
  /** First configured rung in the current automatic model ladder. */
  primary: ProviderName;
  /** Who served the most recent model call. null before the first call. */
  serving: ProviderName | null;
  holdActive: boolean;
  holdUntil: number | null;
  lastFailoverAt: number | null;
  lastFailoverReason: string | null;
  lastRecoveryAt: number | null;
  proxyUp: boolean | null;
  proxyLastProbeAt: number | null;
  proxyRestarts: number;
  /** Calls actually SERVED by each provider. The paid rows are the money line. */
  counts: Record<"free" | "anthropic" | "openai", number>;
  /**
   * SHADOW COUNTER. Times the deck came within one patience grant of paying,
   * then waited and was proved right. A threshold that is quietly too tight
   * shows up here as "we ALMOST paid N times" long before it shows up as a
   * bill.
   */
  wouldHaveFailedOver: number;
  /** Free-route calls that hit backpressure and patiently retried on free. */
  backpressureRetries: number;
  /** Free calls currently in flight — the queue-depth signal. */
  inFlightFree: number;
  events: RouteEvent[];
}

const MAX_EVENTS = 100;

interface MutableRouteState extends RouteSnapshot {
  holdUntilMonotonic: number;
}

function blank(): MutableRouteState {
  return {
    primary: "free",
    serving: null,
    holdActive: false,
    holdUntil: null,
    holdUntilMonotonic: 0,
    lastFailoverAt: null,
    lastFailoverReason: null,
    lastRecoveryAt: null,
    proxyUp: null,
    proxyLastProbeAt: null,
    proxyRestarts: 0,
    counts: { free: 0, anthropic: 0, openai: 0 },
    wouldHaveFailedOver: 0,
    backpressureRetries: 0,
    inFlightFree: 0,
    events: [],
  };
}

let state: MutableRouteState = blank();

/** Test seam — wipes all route state. */
export function resetRouteState(): void {
  state = blank();
  lastRestartAttempt = 0;
  restartInFlight = null;
}

function monotonicMs(): number {
  // performance.now() is monotonic. Date.now() is not: an NTP correction can
  // move it backwards and un-expire a hold, or forwards and expire one early.
  return Math.round(performance.now());
}

function pushEvent(
  kind: RouteEventKind,
  from: ProviderName | null,
  to: ProviderName | null,
  reason: string,
): void {
  state.events.push({ ts: Date.now(), kind, from, to, reason });
  if (state.events.length > MAX_EVENTS) {
    state.events.splice(0, state.events.length - MAX_EVENTS);
  }
}

/**
 * True while the free route is under a post-stall hold.
 *
 * Stored as a monotonic DEADLINE, never a sticky boolean. That single choice
 * is what guarantees a paid provider can never quietly become the primary:
 * every call re-evaluates the clock, and the first call after the window
 * lapses goes straight back to the free route with no extra bookkeeping.
 */
export function isHoldActive(): boolean {
  if (state.holdUntilMonotonic === 0) return false;
  if (monotonicMs() < state.holdUntilMonotonic) return true;
  state.holdUntilMonotonic = 0;
  state.holdUntil = null;
  state.holdActive = false;
  pushEvent(
    "hold-expired",
    null,
    "free",
    "hold window lapsed; re-probing free route",
  );
  return false;
}

/**
 * Arm the hold window. Called ONLY on a proven stall — never on backpressure,
 * an empty response, or a schema failure, because those cost one cheap retry
 * rather than a full patience budget and do not prove the backend is wedged.
 */
export function armHold(holdMs: number, reason: string): void {
  if (holdMs <= 0) return;
  state.holdUntilMonotonic = monotonicMs() + holdMs;
  state.holdUntil = Date.now() + holdMs;
  state.holdActive = true;
  pushEvent("hold-armed", "free", null, reason);
}

export function noteRoutePrimary(provider: ProviderName): void {
  state.primary = provider;
}

export function noteFailover(
  to: ProviderName,
  reason: string,
  from: ProviderName = "free",
): void {
  state.lastFailoverAt = Date.now();
  state.lastFailoverReason = reason;
  pushEvent("failover", from, to, reason);
}

export function noteServed(provider: ProviderName): void {
  const previous = state.serving;
  state.serving = provider;
  if (
    provider === "free" ||
    provider === "anthropic" ||
    provider === "openai"
  ) {
    state.counts[provider] += 1;
  }
  if (provider === "free" && previous !== null && previous !== "free") {
    state.lastRecoveryAt = Date.now();
    pushEvent("recovery", previous, "free", "free route healthy again");
  }
}

/** Record that we nearly paid, then waited instead. The early-warning signal. */
export function notePatienceGranted(detail: string): void {
  state.wouldHaveFailedOver += 1;
  pushEvent("patience-granted", "free", "free", detail);
}

export function noteBackpressure(detail: string): void {
  state.backpressureRetries += 1;
  pushEvent("backpressure", "free", "free", detail);
}

export function noteBudgetRefusal(detail: string): void {
  pushEvent("budget-refused", null, null, detail);
}

export function noteProxyProbe(up: boolean): void {
  const was = state.proxyUp;
  state.proxyUp = up;
  state.proxyLastProbeAt = Date.now();
  if (was === true && up === false) {
    pushEvent(
      "proxy-down",
      "free",
      null,
      "fcc-server /health stopped answering",
    );
  }
}

export function enterFreeCall(): void {
  state.inFlightFree += 1;
}
export function exitFreeCall(): void {
  state.inFlightFree = Math.max(0, state.inFlightFree - 1);
}
export function queueDepth(): number {
  return state.inFlightFree;
}

export function snapshotRoute(): RouteSnapshot {
  isHoldActive(); // fold an expired window down before reporting
  return {
    primary: state.primary,
    serving: state.serving,
    holdActive: state.holdActive,
    holdUntil: state.holdUntil,
    lastFailoverAt: state.lastFailoverAt,
    lastFailoverReason: state.lastFailoverReason,
    lastRecoveryAt: state.lastRecoveryAt,
    proxyUp: state.proxyUp,
    proxyLastProbeAt: state.proxyLastProbeAt,
    proxyRestarts: state.proxyRestarts,
    counts: { ...state.counts },
    wouldHaveFailedOver: state.wouldHaveFailedOver,
    backpressureRetries: state.backpressureRetries,
    inFlightFree: state.inFlightFree,
    events: state.events.map((e) => ({ ...e })),
  };
}

/* ------------------------------------------------------------------ */
/* Measured, adaptive thresholds                                       */
/* ------------------------------------------------------------------ */

export interface FreeRouteThresholds {
  /** Silence budget BEFORE the first token (cold start + queue live here). */
  firstTokenWindowMs: number;
  /** Silence budget BETWEEN tokens once the model is emitting. */
  idleGapWindowMs: number;
  /** Absolute outer backstop for one call. Never the primary trigger. */
  backstopMs: number;
  /** Extra silence windows granted while the backend looks alive. */
  maxPatienceGrants: number;
  source: "measured" | "defaults";
  basis: { firstTokenMaxMs: number; gapMaxMs: number; samples: number };
}

/**
 * Floors are chosen so that the WORST healthy behaviour ever observed on this
 * machine still passes comfortably:
 *   - 294.8s cold/queued first token (measured 2026-08-11) and FlexFactor's
 *     307s healthy ping both sit far under the 420s first-token floor.
 *   - Healthy inter-token gaps are sub-second; the 60s floor is ~2 orders of
 *     magnitude of headroom, so a model dribbling a token every 20-30s is
 *     never mistaken for a wedge.
 */
const FLOOR_FIRST_TOKEN_MS = 420_000;
const CEIL_FIRST_TOKEN_MS = 1_800_000;
const FLOOR_GAP_MS = 60_000;
const CEIL_GAP_MS = 300_000;
const FIRST_TOKEN_SAFETY = 2;
const GAP_SAFETY = 4;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

interface Calibration {
  samples?: number;
  observed?: {
    firstTokenMs?: { max?: number };
    gapMs?: { max?: number };
  };
}

let cachedThresholds: FreeRouteThresholds | null = null;

/** Test seam — forces the next read to re-derive from disk/env. */
export function resetThresholdCache(): void {
  cachedThresholds = null;
}

/**
 * Derive stall thresholds from measured latency rather than a hand-picked
 * constant. Reads .factory/free-route-calibration.json (written by
 * `node scripts/measure-free-route.mjs`) and scales the WORST observed healthy
 * value by a safety factor, then clamps into a sane band.
 *
 * With no calibration file the floors apply — and the floors are themselves
 * derived from measurement, so an uncalibrated deck is conservative, not
 * reckless.
 */
export function getThresholds(
  env: NodeJS.ProcessEnv = process.env,
): FreeRouteThresholds {
  if (cachedThresholds) return cachedThresholds;

  let cal: Calibration | null = null;
  const path = resolve(
    process.cwd(),
    env.FACTORY_DATA_DIR || ".factory",
    "free-route-calibration.json",
  );
  if (existsSync(path)) {
    try {
      cal = JSON.parse(readFileSync(path, "utf8")) as Calibration;
    } catch {
      cal = null;
    }
  }

  const firstTokenMax = cal?.observed?.firstTokenMs?.max ?? 0;
  const gapMax = cal?.observed?.gapMs?.max ?? 0;
  const samples = cal?.samples ?? 0;

  const numeric = (raw: string | undefined, fallback: number): number => {
    const n = Number.parseInt(raw ?? "", 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };

  cachedThresholds = {
    firstTokenWindowMs: numeric(
      env.FACTORY_FREE_FIRST_TOKEN_WINDOW_MS,
      clamp(
        firstTokenMax * FIRST_TOKEN_SAFETY,
        FLOOR_FIRST_TOKEN_MS,
        CEIL_FIRST_TOKEN_MS,
      ),
    ),
    idleGapWindowMs: numeric(
      env.FACTORY_FREE_IDLE_GAP_MS,
      clamp(gapMax * GAP_SAFETY, FLOOR_GAP_MS, CEIL_GAP_MS),
    ),
    backstopMs: numeric(env.FACTORY_FREE_BACKSTOP_MS, 3_600_000),
    maxPatienceGrants: numeric(env.FACTORY_FREE_PATIENCE_GRANTS, 3),
    source: samples > 0 ? "measured" : "defaults",
    basis: { firstTokenMaxMs: firstTokenMax, gapMaxMs: gapMax, samples },
  };
  return cachedThresholds;
}

/**
 * How many extra patience windows this call earns from queue depth.
 *
 * The proxy serves PROVIDER_MAX_CONCURRENCY requests at a time (2 here). Calls
 * beyond that are QUEUED, and a queued call is expected to be silent for
 * roughly as long as the work ahead of it takes. Budgeting a flat window for a
 * call that is provably third in line is the "queue-not-hang" trap.
 */
export function queueBonusGrants(
  depth: number,
  maxConcurrency: number,
  cap = 6,
): number {
  const queued = Math.max(0, depth - Math.max(1, maxConcurrency));
  return Math.min(cap, queued);
}

/* ------------------------------------------------------------------ */
/* Out-of-band liveness                                                */
/* ------------------------------------------------------------------ */

export type LivenessVerdict = "alive" | "dead" | "inconclusive";

export interface LivenessEvidence {
  verdict: LivenessVerdict;
  proxyHealth: boolean | null;
  proxyAdminStatus: string | null;
  ollamaUp: boolean | null;
  ollamaLoadedModels: string[];
  detail: string;
}

async function getJson(
  url: string,
  timeoutMs: number,
): Promise<{ ok: boolean; body: unknown } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, body: null };
    try {
      return { ok: true, body: await res.json() };
    } catch {
      return { ok: true, body: null };
    }
  } catch {
    return null; // could not reach it at all
  }
}

/**
 * Ask the backend directly whether it is alive, independently of the stalled
 * request. Three probes, any ONE of which proves life:
 *   - the FCC proxy's /health
 *   - the FCC proxy's /admin/api/status (also tells us which provider is live)
 *   - Ollama's /api/ps (a resident model means the local backend is working)
 *
 * A slow response from a backend that answers any of these is NOT a failover
 * condition.
 */
export async function probeLiveness(
  baseUrl: string,
  ollamaUrl: string,
  timeoutMs = 4000,
): Promise<LivenessEvidence> {
  let health: { ok: boolean; body: unknown } | null = null;
  let admin: { ok: boolean; body: unknown } | null = null;
  let ps: { ok: boolean; body: unknown } | null = null;
  try {
    [health, admin, ps] = await Promise.all([
      getJson(new URL("/health", baseUrl).toString(), timeoutMs),
      getJson(new URL("/admin/api/status", baseUrl).toString(), timeoutMs),
      getJson(new URL("/api/ps", ollamaUrl).toString(), timeoutMs),
    ]);
  } catch {
    /* Promise.all cannot reject here — getJson swallows — but be defensive */
  }

  const proxyHealth = health === null ? null : health.ok;
  noteProxyProbe(proxyHealth === true);

  const adminStatus =
    admin?.ok && admin.body && typeof admin.body === "object"
      ? (((admin.body as { status?: unknown }).status as string | undefined) ??
        null)
      : null;

  const loaded: string[] = [];
  if (ps?.ok && ps.body && typeof ps.body === "object") {
    const models = (ps.body as { models?: unknown }).models;
    if (Array.isArray(models)) {
      for (const m of models) {
        const name = (m as { name?: unknown })?.name;
        if (typeof name === "string") loaded.push(name);
      }
    }
  }
  const ollamaUp = ps === null ? null : ps.ok;

  const aliveSignals: string[] = [];
  if (proxyHealth === true) aliveSignals.push("proxy /health ok");
  if (adminStatus === "running")
    aliveSignals.push("proxy admin status=running");
  if (loaded.length > 0)
    aliveSignals.push(`ollama resident: ${loaded.join(",")}`);

  // "dead" requires every probe to have returned a definite negative — an
  // unreachable socket or a non-2xx. If we merely failed to interpret a probe,
  // that is inconclusive, and inconclusive buys patience rather than spend.
  const definiteNegative =
    (health === null || health.ok === false) &&
    (admin === null || admin.ok === false) &&
    (ps === null || ps.ok === false);

  let verdict: LivenessVerdict;
  if (aliveSignals.length > 0) verdict = "alive";
  else if (definiteNegative) verdict = "dead";
  else verdict = "inconclusive";

  return {
    verdict,
    proxyHealth,
    proxyAdminStatus: adminStatus,
    ollamaUp,
    ollamaLoadedModels: loaded,
    detail:
      verdict === "alive"
        ? aliveSignals.join("; ")
        : verdict === "dead"
          ? "no probe answered: proxy /health, proxy admin, and ollama /api/ps all failed"
          : "probes inconclusive (ambiguity resolves toward free)",
  };
}

/** Cheap single-shot proxy liveness for launcher/health use. */
export async function probeProxyHealth(
  baseUrl: string,
  timeoutMs = 3000,
): Promise<boolean> {
  const r = await getJson(new URL("/health", baseUrl).toString(), timeoutMs);
  const up = r !== null && r.ok;
  noteProxyProbe(up);
  return up;
}

/* ------------------------------------------------------------------ */
/* fcc-server auto-restart                                             */
/* ------------------------------------------------------------------ */

const RESTART_COOLDOWN_MS = 30_000;
const RESTART_WAIT_MS = 90_000;
const RESTART_POLL_MS = 1_000;

let restartInFlight: Promise<boolean> | null = null;
let lastRestartAttempt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Make sure the free backend is serving, restarting `fcc-server` if it died.
 *
 * Single-flight behind a 30s cooldown so several concurrent calls hitting a
 * dead proxy cannot spawn a stampede of servers. Never throws: a failure here
 * just means the next real call fails and escalates, which beats crashing.
 */
export async function ensureProxy(
  baseUrl: string,
  autoRestart: boolean,
): Promise<boolean> {
  if (await probeProxyHealth(baseUrl)) return true;
  if (!autoRestart) return false;
  if (restartInFlight) return restartInFlight;
  if (
    lastRestartAttempt !== 0 &&
    monotonicMs() - lastRestartAttempt < RESTART_COOLDOWN_MS
  ) {
    return probeProxyHealth(baseUrl);
  }
  lastRestartAttempt = monotonicMs();
  restartInFlight = doRestart(baseUrl).finally(() => {
    restartInFlight = null;
  });
  return restartInFlight;
}

/** Absolute path to fcc-server, or null when it is not installed. */
function resolveFccServer(): string | null {
  const direct = join(homedir(), ".local", "bin", "fcc-server.exe");
  if (existsSync(direct)) return direct;
  try {
    const out = execFileSync(process.platform === "win32" ? "where" : "which", [
      "fcc-server",
    ])
      .toString()
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    return out[0] ?? null;
  } catch {
    return null;
  }
}

async function doRestart(baseUrl: string): Promise<boolean> {
  const exe = resolveFccServer();
  if (!exe) return false;

  const fccHome = process.env.FCC_HOME?.trim() || join(homedir(), ".fcc");
  const logDir = join(fccHome, "logs");
  let out: "ignore" | number = "ignore";
  let err: "ignore" | number = "ignore";
  try {
    mkdirSync(logDir, { recursive: true });
    out = openSync(join(logDir, "server.stdout.log"), "a");
    err = openSync(join(logDir, "server.stderr.log"), "a");
  } catch {
    /* logging is best-effort */
  }

  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }

  try {
    const child = spawn(exe, [], {
      cwd: fccHome,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", out, err],
      env: {
        ...process.env,
        // Messaging startup blocks the FastAPI bind (documented FCC trap).
        MESSAGING_PLATFORM:
          process.env.FCC_ENABLE_MESSAGING === "1"
            ? (process.env.MESSAGING_PLATFORM ?? "none")
            : "none",
        HOST: url.hostname,
        PORT: url.port || "8082",
      },
    });
    child.on("error", () => {
      /* handled by the health poll below */
    });
    child.unref();
  } catch {
    return false;
  }

  const deadline = monotonicMs() + RESTART_WAIT_MS;
  while (monotonicMs() < deadline) {
    await sleep(RESTART_POLL_MS);
    if (await probeProxyHealth(baseUrl)) {
      state.proxyRestarts += 1;
      pushEvent(
        "proxy-restart",
        null,
        "free",
        "fcc-server restarted and healthy",
      );
      return true;
    }
  }
  return false;
}
