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
      if (isNonRetryable(err)) break;
      if (i < attempts - 1) {
        const backoff = Math.min(8000, 400 * 2 ** i);
        await sleep(backoff);
      }
    }
  }
  // Surface a sanitized error only — never include payloads.
  throw new Error(
    `${label} failed after ${used} attempt(s): ${
      lastErr instanceof Error ? lastErr.message : "unknown error"
    }`,
  );
}

/**
 * Best-effort extraction of a JSON object/array from a model's text response.
 * Models sometimes wrap JSON in prose or ```json fences; this strips both.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  // Strip code fences.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  // Find the first { or [ and the matching last } or ].
  const firstBrace = candidate.search(/[[{]/);
  if (firstBrace === -1) {
    return JSON.parse(candidate);
  }
  const lastBrace = Math.max(candidate.lastIndexOf("}"), candidate.lastIndexOf("]"));
  const sliced = candidate.slice(firstBrace, lastBrace + 1);
  return JSON.parse(sliced);
}
