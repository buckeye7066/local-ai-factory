/**
 * extendedTransports.ts — admit the non-HTTP rotation pools, but ONLY when
 * they are provably BUILDABLE here.
 *
 * The extended transports are the local flat-rate CLIs (`claude-code`,
 * `codex-cli`) and `cursor`. They are capacity the metered/quota'd HTTP routes
 * cannot see, and each is its own quota ledger — a real POOL, which is the only
 * unit that spreads load. Rotating model NAMES inside one pool spreads nothing.
 *
 * THE DEFECT THIS MODULE EXISTS TO PREVENT
 * ----------------------------------------
 * FlexFactor's first draft guarded these routes with a PATH probe alone and
 * imported an adapter module that did not exist. Both binaries ARE on PATH on
 * this machine:
 *
 *     claude -> C:\Users\firer\.local\bin\claude.EXE
 *     codex  -> C:\Users\firer\AppData\Roaming\npm\codex.CMD
 *
 * so the filter ADMITTED the routes and the run raised ModuleNotFoundError on
 * selection — precisely the "unbuildable route reaches the rotator, fails at
 * call time, burns a cooldown" tour the filter exists to prevent.
 *
 * THE RULE, therefore:
 *
 *   A route may be admitted only if its adapter is provably IMPORTABLE and its
 *   provider CONSTRUCTIBLE — never merely because a binary exists on PATH.
 *
 *   And the buildability check returns a REASON, never throws, so one broken
 *   adapter cannot take the whole catalog filter down with it.
 *
 * The adapters are therefore loaded with a DYNAMIC import whose failure is
 * captured as a reason string. A static import would make a missing adapter a
 * module-graph failure that takes rotation — and the server boot — with it,
 * which is the same outage in a different coat.
 */
import type { CatalogRoute } from "../rotation/aitimeRotation.js";

// Type-only: erased at compile time, so deleting the file does NOT turn this
// into an unresolvable module reference at run time. That is the point.
type CliModule = typeof import("./cliProvider.js");
type CursorModule = typeof import("./cursorRouteProvider.js");

function describeLoadFailure(api: string, err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err;
  const msg =
    err instanceof Error ? err.message.split("\n")[0].slice(0, 160) : String(err);
  return `${api}: adapter unavailable (${name}: ${msg})`;
}

let cliModule: CliModule | null = null;
let cliLoadReason = "";
try {
  cliModule = await import("./cliProvider.js");
} catch (err) {
  cliLoadReason = describeLoadFailure("cli", err);
}

let cursorModule: CursorModule | null = null;
let cursorLoadReason = "";
try {
  cursorModule = await import("./cursorRouteProvider.js");
} catch (err) {
  cursorLoadReason = describeLoadFailure("cursor", err);
}

/** Every api id served by something other than a plain catalog HTTP call. */
export const EXTENDED_APIS: ReadonlySet<string> = new Set([
  "claude-code",
  "codex-cli",
  "cursor",
]);

export function isExtendedApi(api: string): boolean {
  return EXTENDED_APIS.has(
    String(api || "")
      .trim()
      .toLowerCase(),
  );
}

/**
 * True when the whole extended class is switched on for this process. Read
 * from the standalone switch module, NOT through an adapter — the answer must
 * still be available when an adapter has failed to load.
 */
export { extensionsEnabled as extendedTransportsEnabled } from "./extensionSwitch.js";

/**
 * Why this extended route cannot be served here, or "" when it can.
 *
 * NEVER THROWS. Every failure — a missing adapter module, a missing binary, a
 * disabled feature switch, an adapter that blows up during construction — comes
 * back as a human-readable reason the caller logs and tallies.
 */
export function extendedRouteUnusableReason(route: {
  api?: string;
  model?: string;
  wire_model?: string;
  base_url?: string;
  cost_class?: string;
}): string {
  const api = String(route.api || "")
    .trim()
    .toLowerCase();
  if (!EXTENDED_APIS.has(api)) return "";
  try {
    if (api === "cursor") {
      if (!cursorModule) return cursorLoadReason || "cursor: adapter unavailable";
      cursorModule.makeCursorRoute(route);
      return "";
    }
    if (!cliModule) return cliLoadReason || `${api}: adapter unavailable`;
    cliModule.makeCliProvider(route);
    return "";
  } catch (err) {
    const msg =
      err instanceof Error ? err.message.split("\n")[0].slice(0, 200) : String(err);
    return `${api}: ${msg}`;
  }
}

/** True for a CLI-backed route the rotating provider must serve by subprocess. */
export function isCliRoute(api: string): boolean {
  const key = String(api || "")
    .trim()
    .toLowerCase();
  return key === "claude-code" || key === "codex-cli";
}

/**
 * Serve one CLI-backed route. `input.system` already carries the run's
 * DIRECTED WORK THEME (ThemedProvider stamped it), and the adapter prepends it
 * to the piped body, so a rotated CLI call attacks the same open issue as
 * every HTTP route.
 *
 * Rejects on every failure — including EMPTY output — so a broken transport can
 * never be recorded as a completed turn.
 */
export async function serveCliRoute(
  route: CatalogRoute,
  input: { system: string; prompt: string },
  signal?: AbortSignal,
): Promise<string> {
  if (!cliModule) {
    throw new Error(cliLoadReason || `${route.api}: adapter unavailable`);
  }
  const provider = cliModule.makeCliProvider(route);
  return await provider.complete(
    { system: input.system, prompt: input.prompt },
    signal,
  );
}

/**
 * The route a `cursor` selection is actually called on: an OpenAI-compatible
 * endpoint, with Cursor's own (optional) token. Returns null for anything that
 * is not a Cursor route, so the caller uses the catalog route unchanged.
 */
export function effectiveHttpRoute(route: CatalogRoute): CatalogRoute | null {
  if (String(route.api).toLowerCase() !== "cursor" || !cursorModule) return null;
  const target = cursorModule.makeCursorRoute(route);
  return {
    ...route,
    api: "openai",
    base_url: target.baseUrl,
    auth_env: target.apiKey ? "FACTORY_CURSOR_API_KEY" : "",
    auth_kind: target.apiKey ? "bearer" : "none",
  };
}

// --------------------------------------------------------------------------
// Process-local pool synthesis
// --------------------------------------------------------------------------

/**
 * AI Time's catalog generator does not emit CLI or Cursor routes (verified
 * 2026-08-21: `aitime/catalog.py` only builds `openai`, `anthropic`, `ollama`
 * and `gemini` rows). Without synthesis these pools would be unreachable code
 * waiting on a catalog change — a feature that reports as shipped and does
 * nothing, which is the silent-no-op class this project keeps re-learning.
 *
 * So a consumer that CAN build them contributes them process-locally. This is
 * the exact mirror of the existing process-local credential filter: additions
 * and removals both stay in this process and are never written into the shared
 * catalog. Cooldowns still land in the shared rotation state under the pool's
 * own key, which is correct — the ledger really is machine-wide.
 */
const SYNTHETIC_SPECS: ReadonlyArray<{
  api: string;
  backend: string;
  label: string;
  model: string;
  pool: string;
  note: string;
}> = [
  {
    api: "claude-code",
    backend: "claude-code",
    label: "Claude Code CLI (subscription)",
    model: "claude-code-cli",
    // DELIBERATELY the same ledger AI Time assigns the Max-plan routes
    // (`assign_pool`: backend anthropic_sub -> "anthropic:max-plan"). The CLI
    // and the FCC proxy drain ONE subscription; minting a private pool for the
    // CLI would tell the rotator it had two independent ledgers and drain the
    // single real one twice as fast. It still earns its place: a distinct
    // TRANSPORT that keeps working when the proxy is wedged.
    pool: "anthropic:max-plan",
    note: "local flat-rate CLI; prompt over stdin, bounded, non-recursive",
  },
  {
    api: "codex-cli",
    backend: "codex-cli",
    label: "Codex CLI (subscription)",
    model: "codex-cli",
    // A genuinely separate ledger: the Codex plan, which no catalog route
    // reaches (AI Time's openai backends are the pay-as-you-go API and free
    // tiers). This one really is a new pool.
    pool: "codex:plan",
    note: "local flat-rate CLI; prompt over stdin, bounded, non-recursive",
  },
  {
    api: "cursor",
    backend: "cursor",
    label: "Cursor (subscription)",
    model: "cursor-default",
    pool: "cursor:subscription",
    note: "OpenAI-compatible endpoint on Cursor's own quota ledger",
  },
];

export interface SynthesisResult {
  routes: CatalogRoute[];
  /** reason -> how many candidate pools it excluded. Never silently empty. */
  skipped: Record<string, string>;
}

/**
 * Every extended pool this process can actually build, as catalog routes.
 *
 * Each candidate is admitted ONLY when {@link extendedRouteUnusableReason}
 * returns "" — the same buildability gate the catalog filter applies, so a
 * synthesized route can never be a route the filter would have rejected.
 */
export function synthesizeExtendedRoutes(): SynthesisResult {
  const routes: CatalogRoute[] = [];
  const skipped: Record<string, string> = {};
  for (const spec of SYNTHETIC_SPECS) {
    const candidate = {
      api: spec.api,
      model: spec.model,
      wire_model: spec.model,
      base_url: spec.api === "cursor" ? (cursorModule?.cursorBaseUrl() ?? "") : "",
      cost_class: "subscription",
    };
    const reason = extendedRouteUnusableReason(candidate);
    if (reason) {
      skipped[`${spec.api}/${spec.model}`] = reason;
      continue;
    }
    routes.push({
      id: `${spec.backend}/${spec.model}`,
      backend: spec.backend,
      backend_label: spec.label,
      model: spec.model,
      wire_model: spec.model,
      api: spec.api as CatalogRoute["api"],
      base_url: candidate.base_url,
      pool: spec.pool,
      auth_env: "",
      auth_kind: "none",
      // Flat-rate: never "paid-metered", so rotation's allowPaid=false gate
      // still lets these serve while continuing to refuse real spending.
      cost_class: "subscription",
      tier: "frontier",
      enabled: true,
      disabled_reason: "",
      quota_status: "ok",
      resets_at: null,
      note: spec.note,
      // Purpose sight: the CLI/Cursor transports front frontier coding
      // models. Declared, not measured -- the battery only covers Ollama.
      capabilities: ["code_author", "structured_json", "code_review"],
      capabilities_source: "declared",
    });
  }
  return { routes, skipped };
}
