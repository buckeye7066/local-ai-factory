/**
 * rotationWorker.ts — child-process worker for the cross-process rotation
 * fairness test. Reads AITIME_STATE_DIR from env (pointed at a throwaway
 * fixture dir by the test), performs N selections against the shared state
 * file, and prints one chosen pool per line. Launched with
 * `node --import tsx` by aitimeRotation.test.ts; not a test file itself.
 */
import { buildRotator, unavailableReason } from "../../rotation/aitimeRotation.js";

async function main(): Promise<void> {
  const picks = Number(process.env.ROTATION_WORKER_PICKS || "6");
  const rotator = buildRotator("fairness-worker");
  if (!rotator) {
    console.error(`no rotator: ${unavailableReason()}`);
    process.exit(1);
  }
  for (let i = 0; i < picks; i++) {
    const selection = await rotator.nextRoute({});
    process.stdout.write(selection.pool + "\n");
    // A short random pause interleaves the workers for real contention.
    await new Promise((r) => setTimeout(r, Math.random() * 30));
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  process.exit(1);
});
