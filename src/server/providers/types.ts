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
 * Run an async LLM call with bounded exponential backoff.
 * Logs are intentionally generic — we never log prompts, keys, or responses.
 */
export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  let lastErr: unknown;
  let used = 0;
  for (let i = 0; i < attempts; i++) {
    try {
      used = i + 1;
      return await fn();
    } catch (err) {
      lastErr = err;
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
