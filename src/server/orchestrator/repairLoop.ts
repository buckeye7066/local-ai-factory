import type { QaReport } from "../../shared/schemas.js";

/**
 * repairLoop.ts — the bounded repair loop, isolated so it is trivially
 * testable. It re-verifies after each repair and STOPS as soon as QA passes
 * or the loop count hits `maxLoops`. There is no way for it to run forever.
 */
export interface RepairLoopOptions {
  maxLoops: number;
  initialQa: QaReport;
  /** Apply a repair for the current QA report (writes files). */
  repair: (qa: QaReport) => Promise<void>;
  /** Re-run QA after a repair and return the new report. */
  reverify: () => Promise<QaReport>;
  /** Called at the start of each repair iteration (1-based). */
  onLoop?: (loopNumber: number) => void;
}

export interface RepairLoopResult {
  loops: number;
  finalQa: QaReport;
}

export async function runRepairLoop(
  opts: RepairLoopOptions,
): Promise<RepairLoopResult> {
  let qa = opts.initialQa;
  let loops = 0;

  while (!qa.passed && loops < opts.maxLoops) {
    loops += 1;
    opts.onLoop?.(loops);
    await opts.repair(qa);
    qa = await opts.reverify();
  }

  return { loops, finalQa: qa };
}
