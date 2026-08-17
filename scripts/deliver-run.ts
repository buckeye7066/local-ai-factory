/**
 * Legacy post-run delivery is intentionally disabled.
 *
 * Completed pre-receipt runs do not carry immutable verification evidence.
 * Refuse before reading logs, changing git remotes, committing, or pushing.
 */
const runId = process.argv[2];
if (!runId) {
  console.error("usage: tsx scripts/deliver-run.ts <runId>");
  process.exit(2);
}

console.error(
  "Refusing legacy recovery delivery: this run has no immutable verification receipt. " +
    "Re-run Factory Deck so the exact delivered bytes are checked and receipt-bound before any git mutation.",
);
process.exit(1);
