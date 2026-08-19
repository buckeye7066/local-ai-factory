/**
 * aitimeRotation.ts — pool-first rotation across every model this machine can
 * call. TypeScript twin of `C:\Users\firer\flexfactor\flexfactor_rotation.py`.
 *
 * Implements `C:\Users\firer\AITime\docs\rotation-contract.md` v1. AI Time
 * publishes the route catalog (`python -m aitime.catalog`); this module decides
 * which route goes next and records what happened. If the policy changes here
 * it changes in the Python twin in the same commit.
 *
 * The one idea worth holding on to
 * --------------------------------
 * Rotating across MODELS does not spread quota. Rotating across POOLS does.
 * `gpt-4o` and `gpt-4o-2024-08-06` are two model ids drawing on one OpenAI
 * bucket; alternating between them exhausts it at exactly the same rate as
 * hammering one. So selection walks POOLS, and only picks a model once a pool
 * is chosen.
 *
 * The other idea worth holding on to
 * ----------------------------------
 * A $0 call must never silently become a paid one. `allowPaid` defaults false,
 * and when a tier runs dry the router demotes DOWN a capability tier — it
 * never promotes UP a cost class to keep working. Spending money stays a
 * decision the caller's budget gate makes explicitly.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SCHEMA = 1;

export type Tier = "frontier" | "strong" | "light";
export type CostClass =
  | "local-unlimited"
  | "subscription"
  | "free-tier"
  | "paid-metered";

export const TIER_CHAIN: readonly Tier[] = ["frontier", "strong", "light"];
export const FREE_COST_CLASSES: ReadonlySet<string> = new Set([
  "local-unlimited",
  "subscription",
  "free-tier",
]);
/** Cheapest first — the within-pool tiebreak after least-recently-used. */
const COST_ORDER: Record<string, number> = {
  "local-unlimited": 0,
  subscription: 1,
  "free-tier": 2,
  "paid-metered": 3,
};

// Cooldowns, in seconds. Same constants as the Python twin.
const DEFAULT_RATE_LIMIT_COOLDOWN = 60;
const DEFAULT_QUOTA_COOLDOWN = 3600;
const ROUTE_ERROR_COOLDOWN = 30;
const POOL_STRIKE_COOLDOWN = 300;
const STRIKES_BEFORE_POOL_COOLDOWN = 3;

/**
 * A catalog older than this is stale. Consumers warn and keep routing rather
 * than blocking a build on a refresh — a 4-hour-old catalog is still
 * overwhelmingly correct, and a hard stop here would take the factory down.
 */
export const CATALOG_MAX_AGE_S = 3 * 3600;

const LOCK_STALE_MS = 30_000;
const LOCK_ACQUIRE_TIMEOUT_MS = 5_000;

/** No route could be produced. Carries why each pool was skipped. */
export class RotationError extends Error {
  readonly reasons: Record<string, string>;
  constructor(message: string, reasons: Record<string, string> = {}) {
    super(message);
    this.name = "RotationError";
    this.reasons = reasons;
  }
}

/**
 * The operator pinned a target and it cannot serve.
 *
 * Deliberately its own error, and deliberately fatal by default. Silently
 * routing a pinned job somewhere else is the "reported success, did something
 * else" failure this codebase keeps re-learning; if the operator said Grok,
 * either Grok runs or the run stops and says why.
 */
export class PinUnavailable extends RotationError {
  constructor(message: string, reasons: Record<string, string> = {}) {
    super(message, reasons);
    this.name = "PinUnavailable";
  }
}

// --------------------------------------------------------------------------
// Paths
// --------------------------------------------------------------------------

export function stateDir(): string {
  return (
    process.env.AITIME_STATE_DIR ||
    path.join(process.env.LOCALAPPDATA || os.homedir(), "AITime")
  );
}

export function catalogPath(): string {
  return process.env.AI_ROTATE_CATALOG || path.join(stateDir(), "routes.json");
}

export function rotationStatePath(): string {
  return process.env.AI_ROTATE_STATE || path.join(stateDir(), "rotation-state.json");
}

// --------------------------------------------------------------------------
// Catalog
// --------------------------------------------------------------------------

export interface CatalogRoute {
  id: string;
  backend: string;
  backend_label: string;
  model: string;
  wire_model: string;
  api: "anthropic" | "openai" | "ollama" | "gemini";
  base_url: string;
  /** The quota ledger this route actually drains. */
  pool: string;
  /** Env var NAME holding the credential — never the value itself. */
  auth_env: string;
  auth_kind: string;
  cost_class: CostClass;
  tier: Tier;
  enabled: boolean;
  disabled_reason: string;
  quota_status: string;
  /** ISO timestamp of the next quota reset, when the backend reports one. */
  resets_at: string | null;
  note: string;
}

export function isFreeRoute(route: CatalogRoute): boolean {
  return FREE_COST_CLASSES.has(route.cost_class);
}

function routeFromJson(raw: Record<string, unknown>): CatalogRoute {
  const id = raw["id"];
  if (typeof id !== "string" || !id) throw new TypeError("route without id");
  const str = (k: string, dflt = ""): string =>
    typeof raw[k] === "string" ? (raw[k] as string) : dflt;
  const backend = str("backend");
  return {
    id,
    backend,
    backend_label: str("backend_label"),
    model: str("model"),
    wire_model: str("wire_model"),
    api: (str("api", "openai") || "openai") as CatalogRoute["api"],
    base_url: str("base_url"),
    // A route with no pool would look like its own private ledger and win
    // every least-recently-used race. Fall back to the backend, which is the
    // coarsest correct grouping.
    pool: str("pool") || `${backend || "unknown"}:pool`,
    auth_env: str("auth_env"),
    auth_kind: str("auth_kind", "bearer") || "bearer",
    cost_class: (str("cost_class", "paid-metered") || "paid-metered") as CostClass,
    tier: (str("tier", "light") || "light") as Tier,
    enabled: raw["enabled"] === undefined ? true : Boolean(raw["enabled"]),
    disabled_reason: str("disabled_reason"),
    quota_status: str("quota_status", "unknown") || "unknown",
    resets_at:
      typeof raw["resets_at"] === "string" ? (raw["resets_at"] as string) : null,
    note: str("note"),
  };
}

export class Catalog {
  constructor(
    readonly routes: CatalogRoute[],
    readonly generatedAt: string = "",
    readonly ageSeconds: number = 0,
    readonly path: string = "",
  ) {}

  get isStale(): boolean {
    return this.ageSeconds > CATALOG_MAX_AGE_S;
  }

  enabled(): CatalogRoute[] {
    return this.routes.filter((r) => r.enabled);
  }
}

/**
 * Read the catalog, or null when it is missing or unreadable.
 *
 * Null is a normal answer, not an error: the caller falls back to its existing
 * provider chain. Rotation is an optimisation, never a dependency. But it is
 * never a SILENT answer either — callers log {@link unavailableReason}.
 */
export function loadCatalog(file?: string): Catalog | null {
  const target = file || catalogPath();
  let raw: unknown;
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(target).mtimeMs;
    raw = JSON.parse(fs.readFileSync(target, "utf8"));
  } catch {
    return null;
  }
  if (
    typeof raw !== "object" ||
    raw === null ||
    (raw as Record<string, unknown>)["schema"] !== SCHEMA
  ) {
    return null;
  }
  const doc = raw as { routes?: unknown; generated_at?: unknown };
  const routes: CatalogRoute[] = [];
  for (const entry of Array.isArray(doc.routes) ? doc.routes : []) {
    try {
      routes.push(routeFromJson(entry as Record<string, unknown>));
    } catch {
      continue; // one malformed row must not void the catalog
    }
  }
  return new Catalog(
    routes,
    typeof doc.generated_at === "string" ? doc.generated_at : "",
    Math.max(0, (Date.now() - mtimeMs) / 1000),
    target,
  );
}

// --------------------------------------------------------------------------
// Shared state — %LOCALAPPDATA%\AITime\rotation-state.json
// --------------------------------------------------------------------------

interface PoolStats {
  calls: number;
  last_used_at: number;
}

export interface RotationState {
  schema: number;
  /** Monotonic per-tier call counter. DIAGNOSTIC ONLY — never an index. */
  cursor: Record<string, number>;
  pools: Record<string, PoolStats>;
  /** Epoch-seconds until which a pool (or `route:<id>`) is cooling. */
  cooldowns: Record<string, number>;
  strikes: Record<string, number>;
  pin: Record<string, string | null>;
}

function emptyState(): RotationState {
  return { schema: SCHEMA, cursor: {}, pools: {}, cooldowns: {}, strikes: {}, pin: {} };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * `fs.renameSync` onto an open target throws EPERM on Windows while AV or a
 * concurrent reader holds it — retry briefly instead of surfacing the error.
 */
function replaceWithRetry(src: string, dst: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(src, dst);
      return;
    } catch (err) {
      if (attempt >= 5) {
        try {
          fs.rmSync(src, { force: true });
        } catch {
          /* best effort tmp cleanup */
        }
        throw err;
      }
      const until = Date.now() + 15 * (attempt + 1);
      while (Date.now() < until) {
        /* short synchronous backoff; the section is deliberately sync */
      }
    }
  }
}

/**
 * The cross-process shared state store. `update()` runs read → mutate →
 * atomic replace as ONE critical section under the sidecar lock.
 *
 * Splitting it — read unlocked, select, then stamp under the lock — lets two
 * workers read the same "least recently used" pool and both pick it, so a
 * burst of concurrent calls stampedes one ledger while the state file stays
 * perfectly well-formed and the whole thing looks balanced.
 */
export class StateStore {
  readonly file: string;

  constructor(file?: string) {
    this.file = file || rotationStatePath();
  }

  read(): RotationState {
    try {
      const doc = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return { ...emptyState(), ...doc };
    } catch {
      return emptyState();
    }
  }

  private lockFile(): string {
    return this.file + ".lock";
  }

  /**
   * Acquire the sidecar lock. The holder writes its PID into the lock so a
   * survivor can be identified; the mtime is the lease. A lock older than 30s
   * may be broken — safe here because the critical section is a single read
   * plus one atomic replace, so a half-applied update is not representable.
   */
  private async acquire(): Promise<void> {
    const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
    for (;;) {
      try {
        const fd = fs.openSync(this.lockFile(), "wx");
        fs.writeFileSync(fd, String(process.pid));
        fs.closeSync(fd);
        return;
      } catch {
        try {
          const age = Date.now() - fs.statSync(this.lockFile()).mtimeMs;
          if (age > LOCK_STALE_MS) {
            fs.rmSync(this.lockFile(), { force: true });
            continue;
          }
        } catch {
          continue; // lock vanished between open and stat — retry immediately
        }
        if (Date.now() > deadline) {
          throw new RotationError(
            `could not acquire ${this.lockFile()} within ${LOCK_ACQUIRE_TIMEOUT_MS / 1000}s — ` +
              `another rotation consumer is wedged, or the lock is orphaned`,
          );
        }
        await sleep(10 + Math.random() * 25);
      }
    }
  }

  private release(): void {
    fs.rmSync(this.lockFile(), { force: true });
  }

  async update(mutate: (state: RotationState) => void): Promise<RotationState> {
    await this.acquire();
    try {
      const state = this.read();
      mutate(state);
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + `.tmp.${process.pid}.${Math.floor(Math.random() * 1e6)}`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
      replaceWithRetry(tmp, this.file);
      return state;
    } finally {
      this.release();
    }
  }

  async setPin(target: string | null, app = "global"): Promise<void> {
    await this.update((state) => {
      if (target) state.pin[app] = target;
      else delete state.pin[app];
    });
  }

  getPin(app = "global"): string | null {
    const pins = this.read().pin ?? {};
    return pins[app] ?? pins["global"] ?? null;
  }
}

// --------------------------------------------------------------------------
// Selection
// --------------------------------------------------------------------------

export interface Selection {
  route: CatalogRoute;
  pool: string;
  tier: Tier;
  requestedTier: Tier;
  demotedFrom: Tier | null;
  pinned: boolean;
  catalogStale: boolean;
  consideredPools: number;
}

export function describeSelection(s: Selection): string {
  const bits = [`${s.route.id} [${s.route.cost_class}/${s.tier}]`];
  if (s.pinned) bits.push("pinned");
  if (s.demotedFrom) bits.push(`demoted from ${s.demotedFrom}`);
  if (s.catalogStale) bits.push("stale catalog");
  return bits.join(" ");
}

function cooling(state: RotationState, key: string, now: number): boolean {
  const until = state.cooldowns?.[key];
  return Boolean(until) && Number(until) > now;
}

/** A pin may name a route id, a backend, a pool, or a bare model id. */
function pinMatches(route: CatalogRoute, pin: string): boolean {
  const p = pin.trim();
  return (
    p === route.id ||
    p === route.backend ||
    p === route.pool ||
    p === route.model ||
    p === route.wire_model
  );
}

export type Outcome = "ok" | "rate_limited" | "quota_exhausted" | "error";

export interface NextRouteOpts {
  tier?: Tier;
  allowPaid?: boolean;
  pin?: string;
  pinStrict?: boolean;
  /** Epoch seconds, injectable for tests. */
  now?: number;
}

/**
 * Picks the next route and records what the call did.
 *
 * Holds no clients and issues no calls — the caller maps a {@link Selection}
 * onto its own provider classes. That keeps this whole file testable offline.
 */
export class Rotator {
  constructor(
    readonly catalog: Catalog,
    readonly store: StateStore = new StateStore(),
    readonly app: string = "factory-deck",
  ) {}

  /**
   * Choose the next route, and stamp the choice in the same breath.
   *
   * Read, select and stamp happen inside ONE held lock (see
   * {@link StateStore.update}).
   */
  async nextRoute(opts: NextRouteOpts = {}): Promise<Selection> {
    const requested: Tier = TIER_CHAIN.includes(opts.tier as Tier)
      ? (opts.tier as Tier)
      : opts.tier === undefined
        ? "frontier"
        : "light";
    const allowPaid = opts.allowPaid ?? false;
    const pinStrict = opts.pinStrict ?? true;
    const reasons: Record<string, string> = {};
    let selection: Selection | null = null;

    await this.store.update((state) => {
      // The clock is read INSIDE the held lock, not at call entry. Concurrent
      // callers queue on the lock in an order unrelated to when they were
      // invoked; a timestamp captured before acquisition lets a later-queued
      // worker stamp an EARLIER time onto its pool, inverting the LRU order
      // and skewing the rotation (caught live by the CI fairness test —
      // one pool absorbed 4 of 6 concurrent picks).
      const now = opts.now ?? Date.now() / 1000;
      const resolvedPin =
        opts.pin ||
        process.env.AI_ROTATE_PIN ||
        state.pin?.[this.app] ||
        state.pin?.["global"] ||
        null;
      if (resolvedPin) {
        selection = this.resolvePin(
          resolvedPin,
          state,
          now,
          pinStrict,
          requested,
          allowPaid,
          reasons,
        );
        if (selection) this.stamp(state, selection, now);
        return;
      }

      const start = TIER_CHAIN.indexOf(requested);
      for (let i = start; i < TIER_CHAIN.length; i++) {
        const candidateTier = TIER_CHAIN[i];
        const picked = this.pickInTier(candidateTier, allowPaid, state, now, reasons);
        if (!picked) continue;
        picked.requestedTier = requested;
        if (i > start) picked.demotedFrom = requested;
        picked.catalogStale = this.catalog.isStale;
        this.stamp(state, picked, now);
        selection = picked;
        return;
      }
    });

    if (!selection) {
      throw new RotationError(
        this.noRouteMessage(requested, allowPaid, reasons),
        reasons,
      );
    }
    return selection;
  }

  /**
   * Runs INSIDE the state lock. The non-strict fallback therefore inlines a
   * tier walk instead of recursing into nextRoute (which would re-enter the
   * lock and deadlock).
   */
  private resolvePin(
    pin: string,
    state: RotationState,
    now: number,
    strict: boolean,
    tier: Tier,
    allowPaid: boolean,
    reasons: Record<string, string>,
  ): Selection | null {
    const matches = this.catalog.routes.filter((r) => pinMatches(r, pin));
    if (matches.length === 0) {
      throw new PinUnavailable(
        `pinned target "${pin}" matches no route in the catalog ` +
          `(${this.catalog.routes.length} routes known). Refresh with ` +
          `\`python -m aitime.catalog\`, or clear the pin.`,
      );
    }

    const usable = matches.filter(
      (r) =>
        r.enabled &&
        !cooling(state, r.pool, now) &&
        !cooling(state, `route:${r.id}`, now),
    );
    if (usable.length === 0) {
      if (strict) {
        const why = matches
          .slice(0, 4)
          .map((r) => `${r.id}: ${r.disabled_reason || "cooling down"}`)
          .join("; ");
        throw new PinUnavailable(
          `pinned target "${pin}" cannot serve right now — ${why}. ` +
            `Unset the pin to let rotation choose, or wait for the reset.`,
        );
      }
      const start = TIER_CHAIN.indexOf(tier);
      for (let i = start; i < TIER_CHAIN.length; i++) {
        const fallback = this.pickInTier(TIER_CHAIN[i], allowPaid, state, now, reasons);
        if (fallback) {
          fallback.requestedTier = tier;
          if (i > start) fallback.demotedFrom = tier;
          fallback.catalogStale = this.catalog.isStale;
          return fallback;
        }
      }
      return null;
    }

    usable.sort((a, b) => this.routeLastUsed(state, a) - this.routeLastUsed(state, b));
    const route = usable[0];
    return {
      route,
      pool: route.pool,
      tier: route.tier,
      requestedTier: tier,
      demotedFrom: null,
      pinned: true,
      catalogStale: this.catalog.isStale,
      consideredPools: 0,
    };
  }

  private pickInTier(
    tier: Tier,
    allowPaid: boolean,
    state: RotationState,
    now: number,
    reasons: Record<string, string>,
  ): Selection | null {
    const candidates: CatalogRoute[] = [];
    for (const route of this.catalog.routes) {
      if (route.tier !== tier) continue;
      if (!route.enabled) {
        reasons[route.pool] ??= route.disabled_reason || "disabled";
        continue;
      }
      if (!allowPaid && !isFreeRoute(route)) {
        reasons[route.pool] ??= "paid-metered, and allowPaid is off";
        continue;
      }
      if (cooling(state, route.pool, now)) {
        reasons[route.pool] = "pool cooling down";
        continue;
      }
      if (cooling(state, `route:${route.id}`, now)) continue;
      candidates.push(route);
    }
    if (candidates.length === 0) return null;

    // Group by the ledger each route actually drains. THIS is the rotation.
    const pools = new Map<string, CatalogRoute[]>();
    for (const route of candidates) {
      const bucket = pools.get(route.pool);
      if (bucket) bucket.push(route);
      else pools.set(route.pool, [route]);
    }

    // Least-recently-used ordering IS the rotation, and it is sufficient on
    // its own: picking the oldest pool and stamping it moves that pool to the
    // back of the queue, so the next call necessarily lands elsewhere.
    //
    // An earlier draft of the contract also advanced a per-tier cursor and
    // indexed into this list. That double-rotated — the stamp moved the chosen
    // pool to the end AND the cursor stepped past it, landing back on the same
    // pool every time. Two rotation mechanisms are one too many; the cursor
    // survives in state as a monotonic call counter for diagnostics only.
    const ordered = [...pools.keys()].sort((a, b) => {
      return (
        this.poolLastUsed(state, a) - this.poolLastUsed(state, b) ||
        this.poolCalls(state, a) - this.poolCalls(state, b) ||
        a.localeCompare(b)
      );
    });
    const pool = ordered[0];
    const routes = pools.get(pool)!.sort((a, b) => {
      return (
        this.routeLastUsed(state, a) - this.routeLastUsed(state, b) ||
        (COST_ORDER[a.cost_class] ?? 9) - (COST_ORDER[b.cost_class] ?? 9) ||
        a.id.localeCompare(b.id)
      );
    });
    return {
      route: routes[0],
      pool,
      tier,
      requestedTier: tier,
      demotedFrom: null,
      pinned: false,
      catalogStale: false,
      consideredPools: ordered.length,
    };
  }

  private poolLastUsed(state: RotationState, pool: string): number {
    return Number(state.pools?.[pool]?.last_used_at ?? 0);
  }

  private poolCalls(state: RotationState, pool: string): number {
    return Number(state.pools?.[pool]?.calls ?? 0);
  }

  private routeLastUsed(state: RotationState, route: CatalogRoute): number {
    return Number(state.pools?.[`route:${route.id}`]?.last_used_at ?? 0);
  }

  /**
   * Mark the pool and route as just-used, in the caller's held lock.
   *
   * Stamped at SELECTION time, not on success: a call that is still in flight
   * has already committed that pool's capacity, and waiting for the result
   * would let every concurrent worker choose the same idle pool.
   */
  private stamp(state: RotationState, selection: Selection, now: number): void {
    state.cursor[selection.tier] = (state.cursor[selection.tier] ?? 0) + 1;
    const entry = (state.pools[selection.pool] ??= { calls: 0, last_used_at: 0 });
    entry.last_used_at = now;
    // Count the call here, optimistically, rather than waiting for
    // report("ok"). Measured on this machine every filesystem operation costs
    // 11–70ms (real-time AV scanning), so a full locked transaction is ~68ms;
    // doing two per routed call doubled that for no benefit. Counting at
    // selection lets the success path — overwhelmingly the common one —
    // finish without a second write. A call that then fails is corrected by
    // report(), which has to write anyway to record the cooldown.
    entry.calls += 1;
    const routeEntry = (state.pools[`route:${selection.route.id}`] ??= {
      calls: 0,
      last_used_at: 0,
    });
    routeEntry.last_used_at = now;
  }

  /**
   * Record what a call did so the next pick is better informed.
   */
  async report(
    route: CatalogRoute,
    outcome: Outcome,
    retryAfterSeconds?: number,
    now: number = Date.now() / 1000,
  ): Promise<void> {
    // A clean success on a route with no history changes nothing: the call was
    // already counted and stamped at selection. Skipping the locked write here
    // removes one ~68ms transaction from the common path. The unlocked
    // pre-check can race, but only ever costs a redundant write.
    if (outcome === "ok") {
      const snapshot = this.store.read();
      const hasStrikes = route.id in (snapshot.strikes ?? {});
      const hasCooldown = `route:${route.id}` in (snapshot.cooldowns ?? {});
      if (!hasStrikes && !hasCooldown) return;
    }

    await this.store.update((state) => {
      const entry = (state.pools[route.pool] ??= { calls: 0, last_used_at: 0 });

      switch (outcome) {
        case "ok":
          entry.last_used_at = now;
          delete state.strikes[route.id];
          delete state.cooldowns[`route:${route.id}`];
          return;
        case "rate_limited":
          state.cooldowns[route.pool] =
            now + (retryAfterSeconds ?? DEFAULT_RATE_LIMIT_COOLDOWN);
          return;
        case "quota_exhausted":
          state.cooldowns[route.pool] =
            now +
            (retryAfterSeconds ??
              secondsUntil(route.resets_at, now) ??
              DEFAULT_QUOTA_COOLDOWN);
          return;
        case "error": {
          // Plain error: blame the route first. Only after it keeps failing do
          // we assume the whole pool is sick — one bad model id must not take
          // a healthy provider out of rotation.
          state.cooldowns[`route:${route.id}`] = now + ROUTE_ERROR_COOLDOWN;
          const count = (state.strikes[route.id] ?? 0) + 1;
          state.strikes[route.id] = count;
          if (count >= STRIKES_BEFORE_POOL_COOLDOWN) {
            state.cooldowns[route.pool] = now + POOL_STRIKE_COOLDOWN;
            delete state.strikes[route.id];
          }
          return;
        }
      }
    });
  }

  private noRouteMessage(
    tier: Tier,
    allowPaid: boolean,
    reasons: Record<string, string>,
  ): string {
    if (this.catalog.routes.length === 0) {
      return (
        "rotation has no routes: the catalog is empty. Run " +
        "`python -m aitime.catalog` to build it."
      );
    }
    const paidWaiting = this.catalog.routes.filter(
      (r) => r.enabled && !isFreeRoute(r) && r.tier === tier,
    );
    let head =
      `no ${tier} route available ` +
      `(${this.catalog.enabled().length} enabled routes in catalog)`;
    if (!allowPaid && paidWaiting.length > 0) {
      head +=
        `; ${paidWaiting.length} paid-metered ${tier} routes were held back ` +
        `because allowPaid is off — the budget gate decides that, not rotation`;
    }
    const entries = Object.entries(reasons).sort(([a], [b]) => a.localeCompare(b));
    if (entries.length > 0) {
      head +=
        ". Pools skipped: " +
        entries
          .slice(0, 6)
          .map(([p, why]) => `${p} (${why})`)
          .join("; ");
    }
    return head;
  }
}

function secondsUntil(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const delta = ms / 1000 - now;
  return delta > 0 ? delta : null;
}

// --------------------------------------------------------------------------
// Construction helpers
// --------------------------------------------------------------------------

/** Rotation is the default; AI_ROTATE=off restores prior behaviour exactly. */
export function rotationEnabled(): boolean {
  const v = (process.env.AI_ROTATE || "on").trim().toLowerCase();
  return !["off", "0", "false", "no"].includes(v);
}

/**
 * Return a Rotator, or null when rotation is off or unusable.
 *
 * Null is the honest answer when there is nothing to rotate over — the caller
 * keeps its existing provider selection. It is never a silent no-op: callers
 * log the reason via {@link unavailableReason}.
 */
export function buildRotator(
  app = "factory-deck",
  catalogFile?: string,
  stateFile?: string,
): Rotator | null {
  if (!rotationEnabled()) return null;
  const catalog = loadCatalog(catalogFile);
  if (!catalog || catalog.enabled().length === 0) return null;
  return new Rotator(catalog, new StateStore(stateFile), app);
}

/** Human-readable explanation for why {@link buildRotator} returned null. */
export function unavailableReason(catalogFile?: string): string {
  if (!rotationEnabled()) return "AI_ROTATE=off";
  const target = catalogFile || catalogPath();
  const catalog = loadCatalog(target);
  if (!catalog) {
    if (!fs.existsSync(target)) {
      return `no route catalog at ${target} — run \`python -m aitime.catalog\``;
    }
    return `route catalog at ${target} is unreadable or has the wrong schema`;
  }
  if (catalog.enabled().length === 0) {
    return (
      `route catalog at ${target} has ${catalog.routes.length} routes but ` +
      `none are enabled`
    );
  }
  return "";
}
