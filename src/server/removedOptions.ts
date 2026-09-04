/**
 * removedOptions.ts — options that were REMOVED from Factory Deck's owner
 * surface and must now fail loudly.
 *
 * Dry-run / simulate / report-only remain removed because they imply a real
 * run without doing one. demo:true is different: it is an explicit,
 * owner-visible zero-credit preview whose records are permanently marked
 * demo and whose delivery/readiness gates refuse production side effects.
 *
 * "Removed" means an invocation that names an old flag FAILS. It is never
 * silently ignored and never downgraded into a confirmation prompt.
 */

/** A removed option and the message explaining what to do instead. */
export interface RemovedOption {
  /** Dotted path as an owner would write it in the request body. */
  readonly key: string;
  readonly message: string;
}

const NO_SIMULATION =
  "Factory Deck does not support dry-run, simulate, or report-only no-ops. " +
  "Use options.demo=true for a clearly marked, zero-credit offline preview, " +
  "or omit the flag for real work.";

/** Options removed from `POST /api/runs` and `POST /api/epics` `options`. */
export const REMOVED_RUN_OPTIONS: readonly RemovedOption[] = [
  { key: "dryRun", message: NO_SIMULATION },
  { key: "simulate", message: NO_SIMULATION },
  { key: "reportOnly", message: NO_SIMULATION },
];

/** The rejection an API route should send, or null when the request is clean. */
export interface RemovedOptionRejection {
  readonly status: 400;
  readonly body: { error: string; removed: string };
}

/**
 * Inspect a request's `options` object for any removed flag.
 *
 * Presence is what matters, not the value: `{"demo": false}` still names a flag
 * that no longer exists, and answering it with a silent success would leave the
 * caller believing Factory Deck honoured an option it does not have.
 */
export function findRemovedRunOption(options: unknown): RemovedOptionRejection | null {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    return null;
  }
  const record = options as Record<string, unknown>;
  for (const removed of REMOVED_RUN_OPTIONS) {
    if (Object.prototype.hasOwnProperty.call(record, removed.key)) {
      return {
        status: 400,
        body: {
          error: `options.${removed.key} has been removed. ${removed.message}`,
          removed: `options.${removed.key}`,
        },
      };
    }
  }
  return null;
}
