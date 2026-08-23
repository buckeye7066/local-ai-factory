/**
 * rotatingProvider.ts — an LLMProvider whose backing model changes on every
 * call, driven by the AI Time route catalog (see aitimeRotation.ts and
 * docs/rotation-contract.md v1).
 *
 * This is the $0 primary: it rotates across local-unlimited, subscription and
 * free-tier pools ONLY (allowPaid is never set by the registry wiring). Paid
 * spending remains exactly where it was — the FailoverProvider rescue tier,
 * behind canPayNow(). A rotator must never promote a call from a $0 class
 * into paid-metered on its own.
 *
 * The FCC proxy at 127.0.0.1:8082 is itself a rotating multi-provider proxy
 * and IS the free Anthropic Max route. It appears in the catalog as ONE
 * subscription route; when rotation selects it, this provider delegates to the
 * existing FreeProvider instance so all of its hard-won machinery (mandatory
 * streaming, idle-progress watchdog, liveness probes, cancel threading)
 * applies unchanged. Reaching around the proxy to api.anthropic.com would
 * convert flat-rate work into metered billing.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  CallIntent,
  LLMProvider,
  GenerateTextInput,
  GenerateTextResult,
  GenerateJsonInput,
} from "../../shared/types.js";
import {
  extractJson,
  generateJsonWithRepair,
  ProviderAbortError,
} from "../providers/types.js";
import type { FreeProvider } from "../providers/freeProvider.js";
import {
  unfitForCodeReason,
  rotationExcludedReason,
} from "../providers/routeFitness.js";
import {
  effectiveHttpRoute,
  extendedRouteUnusableReason,
  isCliRoute,
  isExtendedApi,
  serveCliRoute,
  synthesizeExtendedRoutes,
} from "../providers/extendedTransports.js";
import {
  Catalog,
  PinUnavailable,
  Rotator,
  type CatalogRoute,
  type Outcome,
  type Selection,
  type Tier,
  type QualitySignal,
  describeSelection,
  isFreeRoute,
  pinMatches,
  modelFamily,
} from "./aitimeRotation.js";

export type RotationLogger = (kind: "info" | "warn", message: string) => void;

/**
 * The RotatingProvider that most recently served an intent-bearing call.
 * The orchestrator reaches it through several wrappers (Counting -> Themed ->
 * Failover -> Rotating) and has no handle on the innermost one, so the result
 * of the work is reported here, the same way freeRoute's snapshotRoute()
 * exposes the live route. One rotating provider per process in practice.
 */
let liveRotating: RotatingProvider | null = null;

export async function reportRouteQuality(role: string, signal: QualitySignal): Promise<string | null> {
  if (!liveRotating) return null;
  return liveRotating.reportQuality(role, signal);
}

/**
 * The default fetch User-Agent is Cloudflare-blocked (error 1010) at Groq and
 * Cerebras, and the resulting 403 looks identical to a revoked key. Always
 * send a real UA.
 */
const USER_AGENT =
  "local-ai-factory/1.0 (Factory Deck rotation; +https://github.com/buckeye7066/local-ai-factory)";

/** Per-attempt wall clock for a rotated HTTP call. Rotation makes long
 * patience pointless — another pool deserves the time instead. */
function callTimeoutMs(): number {
  const raw = Number(process.env.AI_ROTATE_CALL_TIMEOUT_MS || "");
  return Number.isFinite(raw) && raw > 0 ? raw : 180_000;
}

/** A route names a credential env var that is not set in this process. */
export class MissingRouteCredentialError extends Error {
  constructor(route: CatalogRoute) {
    super(
      `route ${route.id} needs ${route.auth_env || "a credential"} which is not ` +
        `set in this environment`,
    );
    this.name = "MissingRouteCredentialError";
  }
}

interface HttpCallResult {
  text: string;
  status?: number;
}

class RouteCallError extends Error {
  readonly status?: number;
  readonly retryAfterSeconds?: number;
  constructor(message: string, status?: number, retryAfterSeconds?: number) {
    super(message);
    this.name = "RouteCallError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function authHeaders(route: CatalogRoute): Record<string, string> {
  if (route.auth_kind === "none" || !route.auth_env) return {};
  const value = process.env[route.auth_env];
  if (!value) throw new MissingRouteCredentialError(route);
  switch (route.auth_kind) {
    case "x-api-key":
      return { "x-api-key": value };
    case "x-goog-api-key":
      return { "x-goog-api-key": value };
    case "anthropic-token":
      return { authorization: `Bearer ${value}` };
    case "bearer":
    default:
      return { authorization: `Bearer ${value}` };
  }
}

/**
 * Per-backend knobs that keep cloud THINKING models from spending the whole
 * output budget on reasoning. The FlexFactor twin's ledger (2026-08-23) showed
 * 8 of 20 failed calls were OutputBudgetError on OpenRouter free routes; the
 * local council measured the same lever on Ollama (think:false). Only the
 * backends whose wire shape is VERIFIED get a field — an unknown field can be
 * a fatal 400 elsewhere. FACTORY_CLOUD_REASONING=full restores full reasoning.
 */
export function cloudReasoningKnobs(route: CatalogRoute): Record<string, unknown> {
  if ((process.env.FACTORY_CLOUD_REASONING || "").trim().toLowerCase() === "full") return {};
  const base = String(route.base_url || "").toLowerCase();
  if (base.includes("openrouter.ai")) return { reasoning: { effort: "low" } };
  // Verified live on NIM deepseek-v4-flash: accepted.
  if (base.includes("integrate.api.nvidia.com")) return { chat_template_kwargs: { thinking: false } };
  return {};
}

function parseRetryAfter(res: Response): number | undefined {
  const raw = res.headers.get("retry-after");
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * One non-streaming chat call against a catalog route. Supports the three
 * HTTP-shaped APIs in the catalog (openai, ollama's OpenAI-compatible
 * endpoint, gemini). Anthropic-shaped routes are handled by delegation or by
 * the anthropic body shape below.
 */
async function callRoute(
  route: CatalogRoute,
  input: { system: string; prompt: string; temperature?: number; maxTokens?: number },
  signal: AbortSignal | undefined,
): Promise<HttpCallResult> {
  // Fail closed rather than guessing. The `default:` arm below speaks the
  // OpenAI wire shape, so an extended-transport route arriving here would be
  // POSTed as HTTP to a base_url that is empty (CLI) or unresolved (Cursor) —
  // a wrong call dressed up as a normal one. Callers must dispatch extended
  // apis before reaching this function.
  if (isExtendedApi(route.api)) {
    throw new RouteCallError(
      `route ${route.id}: api '${route.api}' is an extended transport and must ` +
        `not be called over plain HTTP`,
    );
  }
  const base = route.base_url.replace(/\/+$/, "");
  const maxTokens = input.maxTokens ?? 4096;
  let url: string;
  let body: Record<string, unknown>;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": USER_AGENT,
    ...authHeaders(route),
  };

  switch (route.api) {
    case "gemini": {
      url = `${base}/models/${route.wire_model}:generateContent`;
      body = {
        system_instruction: { parts: [{ text: input.system }] },
        contents: [{ role: "user", parts: [{ text: input.prompt }] }],
        generationConfig: {
          maxOutputTokens: maxTokens,
          ...(input.temperature !== undefined
            ? { temperature: input.temperature }
            : {}),
        },
      };
      break;
    }
    case "anthropic": {
      url = `${base}/v1/messages`;
      headers["anthropic-version"] = "2023-06-01";
      body = {
        model: route.wire_model,
        max_tokens: maxTokens,
        system: input.system,
        messages: [{ role: "user", content: input.prompt }],
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      };
      break;
    }
    case "ollama": {
      // NATIVE endpoint, not the OpenAI-compatible /v1. Measured 2026-08-23:
      // /v1 ignores `think:false` (deepseek-r1:8b still reasoned to
      // finish=length with empty content), while /api/chat honours it -- and
      // on this CPU-only box that is the difference between gemma4:26b never
      // finishing a planted off-by-one in 551 s of reasoning and fixing it in
      // 7 s. Local thinking models are therefore called with the reasoning
      // channel OFF in rotation (FACTORY_OLLAMA_THINK=1 restores it); cloud
      // routes are fast enough to keep thinking and are untouched.
      url = `${base.replace(/\/v1$/, "")}/api/chat`;
      body = {
        model: route.wire_model,
        stream: false,
        think: process.env.FACTORY_OLLAMA_THINK === "1",
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.prompt },
        ],
        options: {
          num_predict: maxTokens,
          ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        },
      };
      break;
    }
    case "openai":
    default: {
      url = `${base}/chat/completions`;
      body = {
        model: route.wire_model,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.prompt },
        ],
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        ...cloudReasoningKnobs(route),
      };
      break;
    }
  }

  const timeout = AbortSignal.timeout(callTimeoutMs());
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: combined,
    });
  } catch (err) {
    // The RUN's signal firing is a deliberate stop; the local per-attempt
    // timeout is a route failure worth rotating past.
    if (signal?.aborted) throw new ProviderAbortError();
    if (timeout.aborted) {
      throw new RouteCallError(
        `route ${route.id} timed out after ${Math.round(callTimeoutMs() / 1000)}s`,
      );
    }
    throw new RouteCallError(
      `route ${route.id} connection failed: ${
        err instanceof Error ? err.message.slice(0, 160) : String(err)
      }`,
    );
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 240);
    // Newer api.openai.com models (gpt-5*, o-series, chat-latest) reject the
    // classic `max_tokens` param with a 400 that NAMES the replacement
    // ("Use 'max_completion_tokens' instead"). Swap and re-POST inside the
    // SAME attempt so in auto mode the call's one paid round buys an answer,
    // not parameter discovery. (FlexFactor twin: _chat_create; run ledger
    // iplay-20260823-090034 entries 22/117.)
    if (
      res.status === 400 &&
      "max_tokens" in body &&
      detail.includes("max_completion_tokens") &&
      /unsupported[ _]parameter/i.test(detail)
    ) {
      body["max_completion_tokens"] = body["max_tokens"];
      delete body["max_tokens"];
      const retry = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: combined,
      }).catch(() => null);
      if (!retry || !retry.ok) {
        const retryDetail = retry
          ? (await retry.text().catch(() => "")).slice(0, 240)
          : detail;
        throw new RouteCallError(
          `route ${route.id} HTTP ${retry ? retry.status : res.status}: ${retryDetail}`,
          retry ? retry.status : res.status,
          retry ? parseRetryAfter(retry) : parseRetryAfter(res),
        );
      }
      res = retry;
    } else {
      throw new RouteCallError(
        `route ${route.id} HTTP ${res.status}: ${detail}`,
        res.status,
        parseRetryAfter(res),
      );
    }
  }

  const doc = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!doc) {
    throw new RouteCallError(`route ${route.id} returned a non-JSON body`);
  }

  let text = "";
  if (route.api === "gemini") {
    const candidates = (doc["candidates"] as Array<Record<string, unknown>>) ?? [];
    const parts =
      ((candidates[0]?.["content"] as Record<string, unknown>)?.["parts"] as Array<
        Record<string, unknown>
      >) ?? [];
    text = parts.map((p) => (typeof p["text"] === "string" ? p["text"] : "")).join("");
  } else if (route.api === "anthropic") {
    const content = (doc["content"] as Array<Record<string, unknown>>) ?? [];
    text = content
      .map((b) =>
        b["type"] === "text" && typeof b["text"] === "string" ? b["text"] : "",
      )
      .join("");
  } else if (route.api === "ollama") {
    // Native /api/chat shape: { message: { content, thinking? }, done_reason }.
    const message = doc["message"] as Record<string, unknown> | undefined;
    text = typeof message?.["content"] === "string" ? (message["content"] as string) : "";
    const thinking =
      typeof message?.["thinking"] === "string" ? (message["thinking"] as string) : "";
    if (!text.trim() && thinking.trim()) {
      throw new RouteCallError(
        `route ${route.id} spent its whole token budget reasoning and never ` +
          `answered (done_reason=${String(doc["done_reason"])}, ${thinking.length} ` +
          `chars of reasoning) -- raise maxTokens or shorten the prompt; this is a ` +
          `budget timeout, not an empty completion`,
        res.status,
      );
    }
  } else {
    const choices = (doc["choices"] as Array<Record<string, unknown>>) ?? [];
    const message = choices[0]?.["message"] as Record<string, unknown> | undefined;
    text =
      typeof message?.["content"] === "string" ? (message["content"] as string) : "";
    if (!text.trim()) {
      // Reasoning models (measured 2026-08-22: meta/muse-glimmer-30b on NVIDIA
      // NIM) put their chain of thought in a SEPARATE field and leave content
      // null when the token budget runs out before an answer. That is not an
      // empty completion -- the model worked and was cut off -- and calling it
      // one sends the next reader looking for a dead route instead of a small
      // max_tokens. Still retryable (another pool may finish), but named.
      const reasoning =
        (typeof message?.["reasoning_content"] === "string" &&
          (message["reasoning_content"] as string)) ||
        (typeof message?.["reasoning"] === "string" && (message["reasoning"] as string)) ||
        "";
      const finish = choices[0]?.["finish_reason"];
      if (reasoning.trim()) {
        throw new RouteCallError(
          `route ${route.id} spent its whole token budget reasoning and never ` +
            `answered (finish_reason=${String(finish)}, ${reasoning.length} chars ` +
            `of reasoning) -- raise maxTokens or shorten the prompt; this is a ` +
            `budget timeout, not an empty completion`,
          res.status,
        );
      }
    }
  }
  if (!text.trim()) {
    throw new RouteCallError(`route ${route.id} returned an empty completion`);
  }
  return { text, status: res.status };
}

// --------------------------------------------------------------------------
// Outcome classification — mirrors flexfactor_rotation._classify/_is_retryable
// --------------------------------------------------------------------------

const RETRYABLE_MARKERS = [
  "rate limit",
  "rate_limit",
  "429",
  "overloaded",
  "capacity",
  "timeout",
  "timed out",
  "502",
  "503",
  "504",
  "529",
  "insufficient",
  "quota",
  "credit",
  "billing",
  "connection",
  "fetch failed",
  "empty completion",
  "non-json body",
  "json", // a model that cannot produce the shape — a DIFFERENT model may
];

function statusOf(err: unknown): number | undefined {
  const s = (err as { status?: unknown })?.status;
  return typeof s === "number" ? s : undefined;
}

export function classifyOutcome(err: unknown): Outcome {
  const status = statusOf(err);
  const blob = `${(err as Error)?.name ?? typeof err} ${
    (err as Error)?.message ?? String(err)
  }`.toLowerCase();
  if (status === 429 || blob.includes("rate limit") || blob.includes("rate_limit")) {
    return "rate_limited";
  }
  if (["quota", "insufficient", "credit", "billing"].some((m) => blob.includes(m))) {
    return "quota_exhausted";
  }
  return "error";
}

export function retryAfterOf(err: unknown): number | undefined {
  const v = (err as { retryAfterSeconds?: unknown })?.retryAfterSeconds;
  return typeof v === "number" && v > 0 ? v : undefined;
}

/**
 * Whether another pool is worth trying. A programming error or a bad request
 * stays broken on every backend — rotating past it would burn every pool
 * reproducing the same bug and report it as "all providers failed".
 * A missing credential IS worth rotating past: only that one backend lacks it.
 */
export function isRetryableAcrossPools(err: unknown): boolean {
  if (err instanceof ProviderAbortError) return false;
  if (err instanceof MissingRouteCredentialError) return true;
  // A local transport failing (binary gone, non-zero exit, EMPTY output,
  // timeout) says nothing about the OTHER pools — and the whole point of
  // failing closed there is that the rotator gets a turn somewhere else
  // instead of the caller receiving a plausible empty answer.
  const errName = (err as Error)?.name;
  if (errName === "CliUnavailable" || errName === "CursorUnavailable") return true;
  // A schema-validation failure on a $0 route is a MODEL limitation, not a
  // caller bug: unlike the paid tier (where isNonRetryable treats ZodError as
  // final to stop re-billing 60k-token prompts), rotating to a different free
  // model costs nothing and frequently succeeds.
  if ((err as Error)?.name === "ZodError") return true;
  if (
    err instanceof TypeError ||
    err instanceof RangeError ||
    err instanceof ReferenceError ||
    err instanceof SyntaxError
  ) {
    return false;
  }
  const status = statusOf(err);
  if (status !== undefined && [400, 401, 403, 404, 422].includes(status)) {
    return false; // a bad request stays bad on every backend
  }
  if (status !== undefined) return true;
  const blob = `${(err as Error)?.name ?? typeof err} ${
    (err as Error)?.message ?? String(err)
  }`.toLowerCase();
  return RETRYABLE_MARKERS.some((m) => blob.includes(m));
}

// --------------------------------------------------------------------------
// Process-local catalog filtering
// --------------------------------------------------------------------------

/**
 * Drop routes whose credential env var is not set in THIS process. Such a
 * route can never serve here; leaving it in rotation makes every selection of
 * its pool a guaranteed miss. Crucially this filter is process-LOCAL: writing
 * "pool unusable" into the SHARED rotation state would wrongly bench the pool
 * for FlexFactor too, whose process may well hold the key.
 *
 * FCC-proxied routes are exempt — the FreeProvider delegate owns their auth
 * (FACTORY_FREE_AUTH_TOKEN), not the route's declared env var.
 *
 * Returns null when nothing callable remains, with the reason logged by the
 * caller. Never a silent no-op.
 */
/**
 * Where this machine's provider keys actually live. Groq / Cerebras / Gemini /
 * OpenRouter / NVIDIA NIM credentials are provisioned for the FCC proxy in its
 * env file, NOT as persisted user environment variables (measured 2026-08-23:
 * all five exist in ~/.fcc/.env, none in user/machine/process env of a deck
 * started by scripts/start-factory.ps1). Without hydration the launcher-started
 * deck dropped 513 of ~650 catalog routes as "credential env not set" and
 * rotated only the local ollama pool — the 100x-faster free cloud routes that
 * the rotation contract exists for never engaged. FlexFactor already hydrates
 * the same way (`_hydrate_route_credentials`); this closes the parity drift.
 */
export function fccEnvFile(): string {
  const fccHome = process.env.FCC_HOME?.trim() || path.join(os.homedir(), ".fcc");
  return path.join(fccHome, ".env");
}

/**
 * Fill MISSING catalog auth_env vars from the FCC env file, read-only.
 *
 * Never overwrites a variable that is already set (the live environment is
 * authoritative). An empty-string value counts as unset, matching the
 * `process.env[r.auth_env]` truthiness test below. Values are never logged;
 * the returned NAMES are what the caller says out loud.
 */
export function hydrateRouteCredentials(
  routes: readonly CatalogRoute[],
  file: string = fccEnvFile(),
): string[] {
  const wanted = new Set<string>();
  for (const r of routes) {
    if (r.auth_env && !process.env[r.auth_env]) wanted.add(r.auth_env);
  }
  if (wanted.size === 0) return [];
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return [];
  }
  const loaded: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const eq = line.indexOf("=");
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (wanted.has(key) && value && !process.env[key]) {
      process.env[key] = value;
      loaded.push(key);
    }
  }
  return loaded.sort();
}

export function filterRoutableCatalog(
  rotator: Rotator,
  fccBaseUrl: string,
  log: RotationLogger = () => {},
): Rotator | null {
  const norm = (u: string) => u.replace(/\/+$/, "").toLowerCase();
  const fcc = fccBaseUrl ? norm(fccBaseUrl) : "";
  const missing = new Set<string>();
  const extendedDropped: Record<string, number> = {};

  const hydrated = hydrateRouteCredentials(rotator.catalog.routes);
  if (hydrated.length) {
    log(
      "info",
      `[rotate] credentials loaded from ${fccEnvFile()}: ${hydrated.join(", ")}`,
    );
  }

  // A DELIBERATE pin outranks the slow-route exclusion. Without this, pinning
  // Glimmer would drop it here and then fail in resolvePin with "matches no
  // route in the catalog" — the operator asks for a route by name and is told
  // it does not exist. Standalone use is exactly what the exclusion is meant
  // to leave open, so honour the pin and let rotation keep skipping it.
  let activePin: string | null = null;
  try {
    activePin = process.env.AI_ROTATE_PIN || rotator.store.getPin(rotator.app);
  } catch {
    activePin = process.env.AI_ROTATE_PIN || null;
  }
  let unfitSkipped = 0;
  const excludedReasons: Record<string, number> = {};
  let excludedSkipped = 0;
  const kept = rotator.catalog.routes.filter((r) => {
    if (unfitForCodeReason(r.id) || unfitForCodeReason(r.model)) {
      unfitSkipped += 1;
      return false;
    }
    // Real, free and code-capable, but too slow to be ROTATED into on this
    // machine (see rotationExcludedReason). Standalone use is unaffected:
    // pinning or an explicit model never comes through this filter.
    const excluded =
      rotationExcludedReason(r.id) || rotationExcludedReason(r.model);
    if (excluded && !(activePin && pinMatches(r, activePin))) {
      excludedReasons[excluded] = (excludedReasons[excluded] ?? 0) + 1;
      excludedSkipped += 1;
      return false;
    }
    // EXTENDED TRANSPORTS must prove they are BUILDABLE here — importable and
    // constructible — not merely that a binary exists on PATH. This filter's
    // entire job is that an unbuildable route never reaches the rotator: one
    // that does gets selected, fails at call time and burns a cooldown on a
    // pool that was never broken. `claude` and `codex` are both on PATH on
    // this machine, so a PATH-only guard would admit routes whose adapter is
    // missing and turn the first sweep into an error tour.
    if (isExtendedApi(r.api)) {
      const why = extendedRouteUnusableReason(r);
      if (why) {
        extendedDropped[why] = (extendedDropped[why] ?? 0) + 1;
        return false;
      }
      // A CLI/Cursor route carries no HTTP credential of its own.
      return true;
    }
    if (r.auth_kind === "none" || !r.auth_env) return true;
    if (fcc && norm(r.base_url) === fcc) return true;
    if (process.env[r.auth_env]) return true;
    missing.add(r.auth_env);
    return false;
  });

  // Contribute the extended pools this process can build. AI Time's catalog
  // does not emit them (its generator only produces openai/anthropic/ollama/
  // gemini rows), so without this the transports would be code that never
  // runs. Process-local, exactly like the removals above: nothing is written
  // back to the shared catalog.
  const keptFromCatalog = kept.length;
  const extendedCatalogDropped = Object.values(extendedDropped).reduce(
    (a, b) => a + b,
    0,
  );
  const synthesized = synthesizeExtendedRoutes();
  const alreadyPresent = new Set(kept.map((r) => r.id));
  for (const r of synthesized.routes) {
    if (!alreadyPresent.has(r.id)) kept.push(r);
  }
  if (synthesized.routes.length > 0) {
    log(
      "info",
      `[rotate] ${synthesized.routes.length} extended transport pool(s) added: ` +
        synthesized.routes.map((r) => `${r.id} (${r.pool})`).join(", "),
    );
  }
  for (const [id, why] of Object.entries(synthesized.skipped)) {
    extendedDropped[`${id}: ${why}`] = (extendedDropped[`${id}: ${why}`] ?? 0) + 1;
  }
  if (Object.keys(extendedDropped).length > 0) {
    log(
      "warn",
      `[rotate] extended transport(s) not admitted: ` +
        Object.entries(extendedDropped)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([why, n]) => (n > 1 ? `${n}x ${why}` : why))
          .join("; "),
    );
  }
  if (unfitSkipped > 0) {
    log(
      "warn",
      `[rotate] ${unfitSkipped} catalog route(s) skipped: unfit for code work ` +
        `(guard/TTS/vision/embed/media models).`,
    );
  }
  if (excludedSkipped > 0) {
    // Said out loud, never silently: a route that vanished from rotation with
    // no explanation is indistinguishable from a route that was never in the
    // catalog, and the difference matters when someone asks "why isn't it
    // being used?".
    log(
      "info",
      `[rotate] ${excludedSkipped} catalog route(s) held out of rotation — ` +
        Object.entries(excludedReasons)
          .map(([why, n]) => `${why} x${n}`)
          .join("; ") +
        `. Run them standalone (pnpm glimmer) or clear FACTORY_ROTATION_EXCLUDE.`,
    );
  }
  if (missing.size > 0) {
    // Counted against what the CATALOG offered, so synthesized additions
    // cannot mask (or inflate) how many real rows were dropped for credentials.
    // Every skip category must be subtracted here or its routes get miscounted
    // as credential failures.
    const dropped =
      rotator.catalog.routes.length -
      keptFromCatalog -
      unfitSkipped -
      excludedSkipped -
      extendedCatalogDropped;
    log(
      "warn",
      `[rotate] ${dropped} catalog route(s) skipped: credential env not set in ` +
        `this process (${[...missing].sort().join(", ")}). They stay available ` +
        `to other consumers.`,
    );
  }
  if (!kept.some((r) => r.enabled)) {
    log(
      "warn",
      `[rotate] no callable route remains after credential filtering — ` +
        `rotation disabled for this process.`,
    );
    return null;
  }
  const catalog = rotator.catalog;
  return new Rotator(
    new Catalog(kept, catalog.generatedAt, catalog.ageSeconds, catalog.path),
    rotator.store,
    rotator.app,
  );
}

// --------------------------------------------------------------------------
// The rotating provider
// --------------------------------------------------------------------------

export interface RotatingProviderOpts {
  /**
   * The existing FCC FreeProvider. Routes whose base_url is the FCC proxy are
   * served through it (streaming watchdog and all); it is also the "is
   * anything configured at all" backstop.
   */
  fccDelegate: FreeProvider | null;
  /** config.free.baseUrl, to recognise catalog routes that ARE the proxy. */
  fccBaseUrl: string;
  /** Capability tier for this consumer's calls. Builds want frontier. */
  tier?: Tier;
  log?: RotationLogger;
  signal?: AbortSignal;
  onRoute?: (selection: Selection) => void;
}

export class RotatingProvider implements LLMProvider {
  /**
   * Reported identity is the $0 primary, same convention as FailoverProvider:
   * every route this provider will select costs nothing. Which route actually
   * served each call is logged per hop.
   */
  readonly name = "free" as const;

  /** The LAST route used — truthful logging, never a hardcoded guess. */
  model = "rotating";

  private readonly tier: Tier;
  private readonly log: RotationLogger;

  constructor(
    private readonly rotator: Rotator,
    private readonly opts: RotatingProviderOpts,
  ) {
    const envTier = (process.env.AI_ROTATE_TIER || "").trim() as Tier;
    this.tier =
      envTier === "frontier" || envTier === "strong" || envTier === "light"
        ? envTier
        : (opts.tier ?? "frontier");
    this.log = opts.log ?? (() => {});
  }

  isConfigured(): boolean {
    return (
      this.rotator.catalog.enabled().some((r) => isFreeRoute(r)) ||
      Boolean(this.opts.fccDelegate?.isConfigured())
    );
  }

  /** FailoverProvider calls this between free attempts after a failure. */
  resetTransport(): void {
    this.opts.fccDelegate?.resetTransport();
  }

  private isFccRoute(route: CatalogRoute): boolean {
    const norm = (u: string) => u.replace(/\/+$/, "").toLowerCase();
    return (
      Boolean(this.opts.fccBaseUrl) &&
      norm(route.base_url) === norm(this.opts.fccBaseUrl)
    );
  }

  private freePoolCount(): number {
    const pools = new Set(
      this.rotator.catalog
        .enabled()
        .filter((r) => isFreeRoute(r))
        .map((r) => r.pool),
    );
    return pools.size;
  }

  /**
   * One rotated attempt per healthy pool, then give up honestly.
   *
   * Bounded by the number of distinct $0 pools rather than a fixed retry
   * count: retrying the same ledger cannot help, and every other ledger
   * deserves a turn before the call is declared impossible. When every pool
   * has failed, the error propagates to FailoverProvider, whose existing
   * policy (patient free retries, then budget-gated paid rescue) applies.
   */
  /**
   * Purpose sight. Set once per run with the program purpose and any
   * capability the purpose itself demands (a UI-heavy purpose adds vision);
   * every call's intent is completed with it so the journal can say which
   * program goal each route served. Twin of flexfactor's set_purpose.
   */
  setPurpose(purpose: string, needs: NonNullable<CallIntent["needs"]> = []): void {
    this.purpose = String(purpose || "").slice(0, 80);
    this.purposeNeeds = [...new Set(needs)];
  }

  private purpose = "";
  private purposeNeeds: NonNullable<CallIntent["needs"]> = [];
  private readonly lastFamily = new Map<string, string>();
  private readonly lastSelection = new Map<string, Selection>();

  /**
   * Attribute a work result to the route that last served `role`. Callers
   * know whether a build verified, QA rejected, or nothing changed; they do
   * not know which route authored it. This provider does. Returns the
   * cooldown note when one was triggered, else null.
   */
  async reportQuality(role: string, signal: QualitySignal): Promise<string | null> {
    const sel = this.lastSelection.get(role);
    if (!sel) return null;
    const note = await this.rotator.reportQuality(sel.route, signal, sel.purpose ?? "");
    if (note) this.opts.log?.("warn", `[rotate] ${note}`);
    return note;
  }

  private completeIntent(intent?: CallIntent): CallIntent | undefined {
    if (!intent && !this.purpose) return undefined;
    const out: CallIntent = { ...(intent ?? {}) };
    if (this.purpose && !out.purpose) out.purpose = this.purpose;
    // Purpose-derived needs attach to the VISION role only; see
    // flexfactor_rotation._complete_intent for the live-run reason.
    if (this.purposeNeeds.length > 0 && out.role === "vision") {
      out.needs = [...new Set([...(out.needs ?? []), ...this.purposeNeeds])];
    }
    // A reviewer must never be the author's own family when an alternative
    // exists. Automatic: the last author's family is remembered per provider.
    if (out.role === "reviewer" && !out.avoidFamily) {
      const fam = this.lastFamily.get("author");
      if (fam) out.avoidFamily = fam;
    }
    return out;
  }

  private async run<T>(
    label: string,
    invoke: (serve: (input: GenerateTextInput) => Promise<string>) => Promise<T>,
    rawIntent?: CallIntent,
  ): Promise<T> {
    const intent = this.completeIntent(rawIntent);
    const attempts = Math.max(1, this.freePoolCount());
    let lastError: unknown = null;

    for (let attempt = 0; attempt < attempts; attempt++) {
      let selection: Selection;
      try {
        selection = await this.rotator.nextRoute({
          tier: this.tier,
          allowPaid: false, // NEVER auto-promote to a paid cost class here.
          intent,
        });
      } catch (err) {
        // A pinned-and-unavailable target must fail THIS call loudly — never
        // silently substitute another route (and failoverProvider.ts knows not
        // to paid-rescue a PinUnavailable). "No route at all" also surfaces:
        // the failover chain's own policy decides what happens next.
        if (err instanceof PinUnavailable) throw err;
        if (lastError) throw err instanceof Error ? err : new Error(String(err));
        throw err;
      }
      const route = selection.route;
      this.model = route.model;
      if (intent?.role) {
        this.lastFamily.set(intent.role, modelFamily(route.model));
        this.lastSelection.set(intent.role, selection);
        liveRotating = this;
      }
      this.opts.onRoute?.(selection);
      if (selection.catalogStale) {
        this.log(
          "warn",
          `[rotate] ${label}: route catalog is stale (>3h old) — still routing; ` +
            `refresh with \`python -m aitime.catalog\`.`,
        );
      }
      this.log("info", `[rotate] ${label}: ${describeSelection(selection)}`);

      try {
        const result = await invoke((input) => this.serveOn(route, input));
        await this.rotator.report(route, "ok");
        return result;
      } catch (err) {
        // A deliberate abort says nothing about route health: rethrow without
        // reporting, so a cancelled run does not cool a healthy pool.
        if (err instanceof ProviderAbortError) throw err;
        lastError = err;
        await this.rotator.report(route, classifyOutcome(err), retryAfterOf(err));
        if (!isRetryableAcrossPools(err)) throw err;
        this.log(
          "warn",
          `[rotate] ${label}: ${route.id} failed (${
            err instanceof Error ? err.message.slice(0, 160) : String(err)
          }); rotating to the next pool [${attempt + 1}/${attempts}].`,
        );
      }
    }

    throw new Error(
      `every ${this.tier} pool failed this call; last error was ` +
        `${lastError instanceof Error ? `${lastError.name}: ${lastError.message.slice(0, 200)}` : String(lastError)}`,
    );
  }

  /** Serve one text-shaped call on a specific route. */
  private async serveOn(
    route: CatalogRoute,
    input: GenerateTextInput,
  ): Promise<string> {
    if (this.isFccRoute(route)) {
      const fcc = this.opts.fccDelegate;
      if (!fcc || !fcc.isConfigured()) {
        throw new RouteCallError(
          `route ${route.id} is the FCC proxy but the free provider is not configured`,
        );
      }
      const result = await fcc.generateText(input);
      return result.text;
    }
    if (isCliRoute(route.api)) {
      // Bounded local subprocess, prompt over stdin. `input.system` already
      // carries the DIRECTED WORK THEME (ThemedProvider stamped it upstream),
      // and the adapter prepends it to the piped body, so a rotated CLI call
      // attacks the same open issue as every HTTP route.
      return await serveCliRoute(route, input, this.opts.signal);
    }
    // Cursor resolves to a concrete OpenAI-compatible endpoint; everything
    // else is called exactly as the catalog describes it.
    const wire = (isExtendedApi(route.api) ? effectiveHttpRoute(route) : null) ?? route;
    const { text } = await callRoute(wire, input, this.opts.signal);
    return text;
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
    const text = await this.run("generateText", (serve) => serve(input), input.intent);
    return { text, provider: "free" };
  }

  async generateJson<T>(input: GenerateJsonInput<T>): Promise<T> {
    const system = `${input.system}

You MUST respond with a single valid JSON object matching the "${input.schemaName}" shape.
Do not include markdown fences, comments, or any prose outside the JSON.`;

    // The whole repair loop runs on ONE selected route per rotation attempt:
    // repair feedback only makes sense against the model that produced the
    // malformed output. If the route fails hard, run() rotates pools.
    return this.run("generateJson", (serve) =>
      generateJsonWithRepair({
        input,
        attempts: 3,
        baseMaxTokens: input.maxTokens ?? 8192,
        call: async (prompt, maxTokens) => {
          const text = await serve({
            system,
            prompt,
            maxTokens,
            temperature: input.temperature,
          });
          return extractJson(text);
        },
      }),
      input.intent,
    );
  }
}
