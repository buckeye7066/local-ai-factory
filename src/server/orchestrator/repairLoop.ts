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
  /** Refresh executable command/test evidence after files are repaired. */
  verify?: () => Promise<void>;
  /** Re-run QA after verification and return the new report. */
  reverify: () => Promise<QaReport>;
  /** Called at the start of each repair iteration (1-based). */
  onLoop?: (loopNumber: number) => void | Promise<void>;
  /** Re-evaluated before every paid repair; true stops without spending another call. */
  shouldStop?: (qa: QaReport) => boolean;
}

export interface RepairLoopResult {
  loops: number;
  finalQa: QaReport;
  stoppedEarly: boolean;
}

export async function runRepairLoop(
  opts: RepairLoopOptions,
): Promise<RepairLoopResult> {
  let qa = opts.initialQa;
  let loops = 0;
  let stoppedEarly = false;

  while (!qa.passed && loops < opts.maxLoops) {
    if (opts.shouldStop?.(qa)) {
      stoppedEarly = true;
      break;
    }
    loops += 1;
    await opts.onLoop?.(loops);
    await opts.repair(qa);
    await opts.verify?.();
    qa = await opts.reverify();
  }

  return { loops, finalQa: qa, stoppedEarly };
}
