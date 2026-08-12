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

/**
 * One AbortController per run-with-an-observed-signal, lazily created by
 * {@link getCancelSignal}. This is what lets a cancel request reach INSIDE an
 * in-flight provider SDK call instead of only being caught at the next stage
 * boundary or model-call checkpoint (`throwIfCancelled` above stays the
 * cooperative check used between calls; this is the one used DURING a call).
 */
const controllers = new Map<string, AbortController>();

/** Raised inside a run when the user asked it to stop. */
export class RunCancelledError extends Error {
  constructor() {
    super("Run cancelled by user.");
    this.name = "RunCancelledError";
  }
}

export function requestCancel(runId: string): void {
  requested.add(runId);
  // Abort any in-flight call immediately; a controller only exists once
  // something has actually asked for this run's signal.
  controllers.get(runId)?.abort(new RunCancelledError());
}

export function isCancelRequested(runId: string): boolean {
  return requested.has(runId);
}

export function clearCancel(runId: string): void {
  requested.delete(runId);
  controllers.delete(runId);
}

/** Throw if the given run has a pending cancel request. */
export function throwIfCancelled(runId: string): void {
  if (requested.has(runId)) throw new RunCancelledError();
}

/**
 * The AbortSignal that fires the moment `requestCancel(runId)` is called for
 * this run. Combine it with a deadline signal and pass the result into every
 * paid-provider SDK call so a cancel can interrupt a call that is already in
 * flight, not just the gap before the next one starts.
 */
export function getCancelSignal(runId: string): AbortSignal {
  let controller = controllers.get(runId);
  if (!controller) {
    controller = new AbortController();
    controllers.set(runId, controller);
    // A cancel requested before anyone asked for the signal must still take
    // effect on the signal returned here.
    if (requested.has(runId)) controller.abort(new RunCancelledError());
  }
  return controller.signal;
}
