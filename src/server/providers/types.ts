/**
 * providers/types.ts — re-export the shared provider contract so that every
 * concrete provider imports from one local path.
 */
export type {
  LLMProvider,
  GenerateTextInput,
  GenerateTextResult,
  GenerateJsonInput,
} from "../../shared/types.js";

export type { ProviderName } from "../../shared/schemas.js";

import type { GenerateJsonInput } from "../../shared/types.js";
import { ZodError } from "zod";
import { safeErrorMessage } from "../errors.js";

/** Small helper: sleep used by retry/backoff (kept here so all providers share it). */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * True when retrying cannot help: 4xx client errors other than rate limiting
 * (429) and request timeout (408). Bad model IDs, invalid params, and auth
 * failures should surface immediately instead of burning backoff time.
 */
export function isNonRetryable(err: unknown): boolean {
  // A schema-validation failure is NOT a transport fault. It escapes
  // generateJsonWithRepair only after that loop's own repair attempts (which
  // feed the model the exact Zod issues) are exhausted — re-running the whole
  // loop from scratch re-bills the full input for the same guess. Measured
  // 2026-08-16, live GrantFlow slice: one 60k-token competitive-selection
  // prompt x (2 repair attempts) x (3 withRetry attempts) = six paid calls,
  // ~$10, and the run still died on the identical missing field.
  if (err instanceof ZodError) return true;
  const status = (err as { status?: unknown })?.status;
  if (typeof status !== "number") return false; // network errors etc. → retry
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/**
 * Raised when a provider call is cut short by the caller-supplied
 * AbortSignal (the run's deadline or a cancel request) rather than by the
 * provider itself failing. This must never be retried and must never trigger
 * paid failover — retrying, or paying to rescue, a call the run has already
 * given up on would be exactly backwards. `failoverProvider.ts` checks for
 * this type specifically so it short-circuits instead of treating the abort
 * as a transient transport failure worth another attempt.
 */
export class ProviderAbortError extends Error {
  constructor(
    message = "Provider call aborted (run deadline exceeded or run cancelled).",
  ) {
    super(message);
    this.name = "ProviderAbortError";
  }
}

/**
 * Reject with {@link ProviderAbortError} the moment `signal` fires, whichever
 * settles first. This is the backstop that bounds a call even if the inner
 * SDK request never itself reacts to `signal` — belt-and-suspenders on top of
 * also passing `signal` to the SDK call itself (which is what actually tears
 * down the underlying HTTP request instead of leaving it running unused).
 */
function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new ProviderAbortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new ProviderAbortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/**
 * Run an async LLM call with bounded exponential backoff.
 * Logs are intentionally generic — we never log prompts, keys, or responses.
 *
 * `signal`, when given, bounds EACH attempt (not just the gaps between them):
 * a fired signal aborts an in-flight attempt immediately, skips any further
 * retries, and always surfaces as {@link ProviderAbortError} — never wrapped
 * in the generic "failed after N attempts" error below, so callers can tell
 * a deliberate abort apart from a real provider failure.
 */
export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 3,
  signal?: AbortSignal,
): Promise<T> {
  let lastErr: unknown;
  let used = 0;
  for (let i = 0; i < attempts; i++) {
    if (signal?.aborted) throw new ProviderAbortError();
    try {
      used = i + 1;
      return await raceAbort(fn(), signal);
    } catch (err) {
      lastErr = err;
      if (err instanceof ProviderAbortError) throw err;
      // A local economic boundary is a deliberate refusal, not a transient
      // transport fault. Preserve its exact type/message and never back off
      // into repeated attempts that cannot possibly be admitted.
      if ((err as { name?: unknown })?.name === "PaidBudgetExhaustedError") {
        throw err;
      }
      if (isNonRetryable(err)) break;
      if (i < attempts - 1) {
        const backoff = Math.min(8000, 400 * 2 ** i);
        await sleep(backoff);
      }
    }
  }
  // Surface a sanitized error only — never include payloads.
  throw new Error(
    `${label} failed after ${used} attempt(s): ${safeErrorMessage(lastErr, "unknown error")}`,
  );
}

/**
 * Raised when a response could not be read as JSON at all — neither by direct
 * parsing nor by truncation salvage.
 *
 * Typed on purpose: a provider must be able to tell "the model's TEXT was not
 * JSON" apart from "the transport failed". The first is worth one cheap retry
 * with a bigger output budget; the second must propagate untouched to the
 * failover layer, which owns the stall/backpressure/rescue policy.
 */
export class JsonExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonExtractionError";
  }
}

/**
 * Salvage a TRUNCATED JSON value — the response that stopped mid-structure
 * because the model hit its max_tokens ceiling.
 *
 * Walk the text tracking string/escape state, remember every index at which a
 * complete container just closed, then rebuild `prefix + missing closers` from
 * the LAST such point backwards until one parses. The trailing incomplete
 * element is dropped, so the result is deliberately PARTIAL.
 *
 * Ported from the proven `_salvage_truncated_json` in flexfactor.py.
 *
 * PARTIAL IS NOT AUTOMATICALLY OK. This is a recovery mechanism, not an
 * acceptance one: every caller still runs the salvaged value through its Zod
 * schema, so a half-built object that is missing required fields fails exactly
 * as loudly as it does today. What salvage buys is the common case where the
 * cut landed inside the LAST element of an already-satisfied array — the run
 * continues on real content instead of dying on a truncated stream.
 */
export function salvageTruncatedJson(text: string): unknown | undefined {
  if (!text) return undefined;
  let s = text.trim();
  // A truncated response can OPEN a ```json fence and never close it, so the
  // closing-fence-anchored strip used on well-formed text cannot apply here.
  // Only strip a fence the response actually STARTS with.
  const fence = /^```[a-zA-Z0-9_-]*[ \t]*\r?\n?/.exec(s);
  if (fence) s = s.slice(fence[0].length).trim();

  const starts = [s.indexOf("{"), s.indexOf("[")].filter((i) => i >= 0);
  if (!starts.length) return undefined;
  const start = Math.min(...starts);

  const closers: string[] = [];
  let inStr = false;
  let esc = false;
  /** (endIndex, suffix) pairs recorded each time a container closed cleanly. */
  const candidates: { end: number; suffix: string }[] = [];

  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') {
        inStr = false;
        // A string just closed cleanly. Inside a container that is also a safe
        // cut point — it rescues the very common `["a","b","cc<CUT>` shape,
        // where no nested container ever closes and container-close candidates
        // alone would salvage nothing. Cutting after a KEY string yields
        // invalid JSON (`{"a":1,"b"}`), which simply fails to parse and falls
        // through to an earlier candidate, so over-offering costs nothing.
        if (closers.length) {
          candidates.push({ end: i + 1, suffix: [...closers].reverse().join("") });
        }
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === "{" || ch === "[") {
      closers.push(ch === "{" ? "}" : "]");
    } else if (ch === "}" || ch === "]") {
      if (!closers.length || ch !== closers[closers.length - 1]) break; // malformed
      closers.pop();
      // A complete object/array just closed — a safe cut point. Only container
      // closes qualify: cutting mid-string or mid-number would salvage a
      // fragment element with most of its keys missing.
      candidates.push({ end: i + 1, suffix: [...closers].reverse().join("") });
      if (!closers.length) break; // top level closed — the rest is trailing junk
    }
  }

  for (let i = candidates.length - 1; i >= 0; i--) {
    const { end, suffix } = candidates[i];
    const frag = s.slice(start, end).replace(/\s+$/, "").replace(/,+$/, "");
    try {
      return JSON.parse(frag + suffix);
    } catch {
      /* try an earlier, shorter candidate */
    }
  }
  return undefined;
}

/**
 * Best-effort extraction of a JSON object/array from a model's text response.
 * Models sometimes wrap JSON in prose or ```json fences; this strips both. A
 * response cut off at the output-token ceiling is salvaged (see
 * {@link salvageTruncatedJson}) rather than thrown away.
 */
export function extractJson(text: string): unknown {
  try {
    return extractJsonStrict(text);
  } catch (err) {
    const salvaged = salvageTruncatedJson(text);
    if (salvaged !== undefined) return salvaged;
    throw new JsonExtractionError(
      err instanceof Error ? err.message : "Response was not JSON.",
    );
  }
}

/**
 * Widen an output budget for a repair round: a response that got cut off
 * needs room, and a response that narrated before answering needs room too.
 */
function widenBudget(current: number): number {
  return Math.min(Math.max(current * 2, 16_000), 32_000);
}

/**
 * Run a JSON generation with a bounded REPAIR LOOP, shared by every provider.
 *
 * THE BUG THIS EXISTS TO KILL (2026-08-13, three dead runs): the old shape was
 *
 *     const raw = await callOnce(prompt);      // extractJson THROWS here
 *     const first = schema.safeParse(raw);     // never reached
 *     ...one repair pass...                    // never reached
 *
 * Because `callOnce` ends in `extractJson`, a response containing NO JSON at
 * all ("I'll research the existing architecture before…") threw straight out of
 * generateJson. The repair round-trip — the one mechanism built to recover a
 * wandering free/local model — could only ever fire when extraction SUCCEEDED
 * and the schema then failed. So the single most common free-model failure mode
 * got zero retries and killed the run outright: the incognito run twice and the
 * iplay run once, all at the architect stage.
 *
 * Here BOTH failure modes are repairable and share one attempt budget:
 *  - no JSON in the response (prose, preamble, or a cut-off stream) → a repair
 *    prompt that names THAT problem, not a misleading "schema validation" one;
 *  - JSON that parsed but does not match the schema → the issue list, as before.
 * Each retry also widens the output budget, since burning the budget narrating
 * and then being truncated produces exactly the prose-only output above.
 *
 * A non-JSON error (transport, stall, abort) is NEVER caught here — it belongs
 * to the failover layer, which owns patience, backpressure and paid rescue.
 * The final attempt fails LOUDLY, naming the schema so the run log says which
 * stage gave up.
 */
/**
 * Render a Zod schema as the literal JSON shape the model must produce.
 *
 * THE MODEL WAS NEVER SHOWN THE FIELD NAMES (found 2026-08-16, live GrantFlow
 * slice). Every provider's system prompt said only 'match the "<schemaName>"
 * shape' — the name, not the shape. The model had to GUESS key names, and for
 * CompetitiveSelection it guessed everything except `selected[].element`,
 * failed validation identically on all six billed attempts (~$10), and killed
 * the run. Zod defaults had been masking the gap: most fields are `.default()`
 * so a wrong guess usually cost nothing — the required-without-default fields
 * are exactly where guessing dies.
 *
 * Deliberately a compact TS-ish rendering, not full JSON Schema: it goes in a
 * prompt, so field NAMES and requiredness matter, prose does not. `?` marks
 * optional-or-defaulted fields. Depth/length capped — a pathological schema
 * degrades to a truncated hint, never a prompt bomb.
 */
export function describeZodShape(schema: unknown, depth = 0): string {
  if (depth > 6) return "…";
  const def = (schema as { _def?: Record<string, unknown> })?._def;
  if (!def) return "any";
  const t = def.typeName as string | undefined;
  switch (t) {
    case "ZodObject": {
      const shapeRaw = def.shape;
      const shape: Record<string, unknown> =
        typeof shapeRaw === "function"
          ? (shapeRaw as () => Record<string, unknown>)()
          : ((shapeRaw as Record<string, unknown>) ?? {});
      const fields = Object.entries(shape).map(([key, sub]) => {
        const subDef = (sub as { _def?: { typeName?: string } })?._def;
        const optional =
          subDef?.typeName === "ZodOptional" || subDef?.typeName === "ZodDefault";
        return `"${key}"${optional ? "?" : ""}: ${describeZodShape(sub, depth + 1)}`;
      });
      return `{ ${fields.join(", ")} }`;
    }
    case "ZodArray":
      return `[${describeZodShape(def.type, depth + 1)}, …]`;
    case "ZodEnum":
      return (def.values as string[]).map((v) => JSON.stringify(v)).join(" | ");
    case "ZodLiteral":
      return JSON.stringify(def.value);
    case "ZodUnion":
      return (def.options as unknown[])
        .map((o) => describeZodShape(o, depth + 1))
        .join(" | ");
    case "ZodOptional":
    case "ZodDefault":
      return describeZodShape(def.innerType, depth + 1);
    case "ZodNullable":
      return `${describeZodShape(def.innerType, depth + 1)} | null`;
    case "ZodRecord":
      return `{ [key: string]: ${describeZodShape(def.valueType, depth + 1)} }`;
    case "ZodString":
      return "string";
    case "ZodNumber":
      return "number";
    case "ZodBoolean":
      return "boolean";
    default:
      return "any";
  }
}

/** Cap for the rendered shape inside a prompt. */
const MAX_SHAPE_CHARS = 4000;

export async function generateJsonWithRepair<T>(args: {
  input: GenerateJsonInput<T>;
  /** Perform one call and return the extracted value (may throw). */
  call: (prompt: string, maxTokens: number) => Promise<unknown>;
  /** Total attempts, INCLUDING the first. Free/local models want 3. */
  attempts: number;
  /** Output-token budget for the first attempt. */
  baseMaxTokens: number;
}): Promise<T> {
  const { input, call, attempts, baseMaxTokens } = args;
  // The shape rides on EVERY attempt (first and repairs alike): field names
  // are facts the model cannot be expected to guess. See describeZodShape.
  let shape = "";
  try {
    shape = describeZodShape(input.schema);
  } catch {
    shape = ""; // a shape we cannot render must never break the call itself
  }
  if (shape.length > MAX_SHAPE_CHARS) shape = shape.slice(0, MAX_SHAPE_CHARS) + "…";
  const basePrompt = shape
    ? `${input.prompt}

The "${input.schemaName}" JSON value must match EXACTLY this shape — the field
names are literal and required unless marked with "?":
${shape}`
    : input.prompt;
  let prompt = basePrompt;
  let maxTokens = baseMaxTokens;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const last = attempt === attempts;
    let raw: unknown;
    try {
      raw = await call(prompt, maxTokens);
    } catch (err) {
      // Only a JSON-level failure is repairable. Everything else propagates.
      if (!(err instanceof JsonExtractionError)) throw err;
      if (last) {
        throw new JsonExtractionError(
          `${input.schemaName}: the model returned no usable JSON after ${attempts} attempt(s). Last parse error: ${err.message}`,
        );
      }
      prompt = `${basePrompt}

Your previous response contained NO JSON and could not be parsed (${err.message}).
Do NOT explain what you are about to do. Do NOT write a preamble, a plan, or any
prose. Respond with the "${input.schemaName}" JSON value ONLY — your very first
character must be "{" and your very last character must be "}". Keep every string
short so the whole value fits comfortably in the response limit.`;
      maxTokens = widenBudget(maxTokens);
      continue;
    }

    const parsed = input.schema.safeParse(raw);
    if (parsed.success) return parsed.data;
    // Out of attempts: parse again so the caller gets the real ZodError.
    if (last) return input.schema.parse(raw);

    prompt = `${basePrompt}

Your previous JSON failed schema validation for "${input.schemaName}".
Issues (truncated): ${JSON.stringify(parsed.error.issues.slice(0, 12))}
Return the corrected JSON only — no prose, no markdown fences.`;
    maxTokens = widenBudget(maxTokens);
  }

  // Unreachable: the loop either returns or throws on its final iteration.
  throw new JsonExtractionError(`${input.schemaName}: repair loop exhausted.`);
}

/** The original, exact-parse path. Kept separate so salvage is a fallback only. */
function extractJsonStrict(text: string): unknown {
  const trimmed = text.trim();
  // Strip a code fence ONLY when the response itself is fenced (starts with
  // ```), anchored to the start/end. Models tag fences with whatever language
  // they judge the content to be (```json, ```bash, ```ts, or no tag) even
  // when asked for JSON only, so the tag itself is stripped too. Scanning the
  // whole text for ANY ``` pair (the old behavior) false-positived on JSON
  // whose string values legitimately contain markdown fences of their own --
  // e.g. a generated README.md's "```\nnpm install\n```" usage example --
  // which extracted that embedded snippet instead of the real JSON payload.
  let candidate = trimmed;
  if (trimmed.startsWith("```")) {
    const fenced = trimmed.match(/^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)```\s*$/);
    if (fenced) candidate = fenced[1].trim();
  }
  // Find the first { or [ and the matching last } or ].
  const firstBrace = candidate.search(/[[{]/);
  if (firstBrace === -1) {
    return JSON.parse(candidate);
  }
  const lastBrace = Math.max(candidate.lastIndexOf("}"), candidate.lastIndexOf("]"));
  const sliced = candidate.slice(firstBrace, lastBrace + 1);
  return JSON.parse(sliced);
}
