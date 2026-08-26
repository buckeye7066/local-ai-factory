/**
 * removedOptions.ts — options that were REMOVED from Factory Deck's owner
 * surface and must now fail loudly.
 *
 * Owner order: there are no dry-run / simulate / report-only / test-mode
 * options in owner tooling. "Removed" means an invocation that names the old
 * flag FAILS. It is never silently ignored (that turns an owner's real request
 * into a no-op), and it is never downgraded into a confirmation prompt (that is
 * the same guardrail wearing a different hat).
 *
 * The mock/stub providers still exist, but ONLY as in-process fixtures for the
 * unit suite, which calls runFactory()/startRun() directly and never crosses
 * the HTTP boundary. Nothing an owner can reach may request simulated output.
 */

/** A removed option and the message explaining what to do instead. */
export interface RemovedOption {
  /** Dotted path as an owner would write it in the request body. */
  readonly key: string;
  readonly message: string;
}

const NO_SIMULATION =
  "Factory Deck has no demo, mock, or simulate mode — every run does real " +
  "work against real providers. Start the FREE route " +
  '("Claude Code - FREE (Ollama)") or set a paid ANTHROPIC_API_KEY / ' +
  "OPENAI_API_KEY.";

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
