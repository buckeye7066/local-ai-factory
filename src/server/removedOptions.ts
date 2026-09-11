/**
 * removedOptions.ts — options that were REMOVED from Factory Deck's owner
 * surface and must now fail loudly.
 *
 * Demo / dry-run / simulate / report-only are removed because each one lets an
 * owner request look like factory work without doing real work (owner order
 * 2026-08-13: "I don't want dry runs, I want work"). The internal `demo` run
 * flag survives only for hermetic unit tests; no owner surface can set it.
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
  "Factory Deck has no demo, dry-run, simulate, or report-only mode. " +
  "Omit the flag: every run does real work against real providers.";

/** Options removed from `POST /api/runs` and `POST /api/epics` `options`. */
export const REMOVED_RUN_OPTIONS: readonly RemovedOption[] = [
  { key: "demo", message: NO_SIMULATION },
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
