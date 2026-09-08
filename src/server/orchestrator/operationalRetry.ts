import type { OperationalRetry, RunRecord } from "../../shared/schemas.js";

/** Persist backoff rather than keeping retry intent only in a process timer. */
export function nextOperationalRetry(
  stage: OperationalRetry["stage"],
  previous?: OperationalRetry,
  now = Date.now(),
): OperationalRetry {
  const attempt = Math.min((previous?.attempt ?? 0) + 1, 30);
  return {
    stage,
    attempt,
    nextAttemptAt: now + Math.min(30_000 * 2 ** (attempt - 1), 15 * 60_000),
  };
}

/** A cancelled/terminal/unverified run cannot be made runnable by a retry ticket. */
export function operationalRetryDue(run: RunRecord, now = Date.now()): boolean {
  return (
    run.status === "failed" &&
    run.resumable === true &&
    run.recovery !== undefined &&
    run.recovery.nextAttemptAt <= now
  );
}

/** A sealed artifact with no deployment target cannot be repaired by retrying. */
export function deploymentOperationalRetry(
  result: { target: "railway" | "vercel" | null },
  previous?: OperationalRetry,
  now = Date.now(),
): OperationalRetry | undefined {
  return result.target === null
    ? undefined
    : nextOperationalRetry("deployment", previous, now);
}
