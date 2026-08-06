/**
 * cancellation.ts — cooperative cancellation for in-flight runs.
 *
 * A cancel request sets a flag; the orchestrator checks it at every stage
 * boundary and the CountingProvider checks it before every model call, so a
 * cancelled run stops within one model call at most. Nothing is force-killed:
 * the run winds down through the normal catch path and is persisted as
 * status "cancelled".
 */

const requested = new Set<string>();

/** Raised inside a run when the user asked it to stop. */
export class RunCancelledError extends Error {
  constructor() {
    super("Run cancelled by user.");
    this.name = "RunCancelledError";
  }
}

export function requestCancel(runId: string): void {
  requested.add(runId);
}

export function isCancelRequested(runId: string): boolean {
  return requested.has(runId);
}

export function clearCancel(runId: string): void {
  requested.delete(runId);
}

/** Throw if the given run has a pending cancel request. */
export function throwIfCancelled(runId: string): void {
  if (requested.has(runId)) throw new RunCancelledError();
}
