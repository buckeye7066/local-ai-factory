import type { RunRecord } from "../../shared/schemas.js";
import { getRunForExecution, listRuns, saveRun } from "../storage/runsStore.js";
import { listEpics, runEpic, isEpicActive, type EpicDeps } from "./epicRunner.js";
import { nextOperationalRetry, operationalRetryDue } from "./operationalRetry.js";
import { safeErrorMessage } from "../errors.js";
import { isCancelRequested } from "./cancellation.js";

export interface OperationalRecoveryDeps {
  epicDeps: () => EpicDeps;
  resumeRun: (id: string) => Promise<RunRecord>;
  onError?: (error: unknown) => void;
  now?: () => number;
}

/** Single-flight, serial recovery. Timers only wake it; durable tickets own intent. */
export function createOperationalRecovery(deps: OperationalRecoveryDeps) {
  let busy = false;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const now = deps.now ?? Date.now;
  const report = (err: unknown) => deps.onError?.(err);

  async function tick(): Promise<void> {
    if (busy || stopped) return;
    busy = true;
    try {
      const summaries = await listRuns();
      // Do not compete with the owner's already-running pipeline.
      if (summaries.some((r) => r.status === "running" || r.status === "queued"))
        return;
      const epics = await listEpics();
      if (epics.some((epic) => isEpicActive(epic.id))) return;
      const childIds = new Set(
        epics.flatMap((e) => e.slices.flatMap((s) => (s.runId ? [s.runId] : []))),
      );
      const dueEpics = epics
        .filter(
          (e) =>
            (e.status === "paused" || e.status === "failed") &&
            e.recovery &&
            e.recovery.nextAttemptAt <= now() &&
            !isEpicActive(e.id),
        )
        .sort((a, b) => a.recovery!.nextAttemptAt - b.recovery!.nextAttemptAt);
      // One job per tick keeps long queues fair and never launches overlapping epics.
      if (dueEpics[0] && !stopped) {
        await runEpic(dueEpics[0], deps.epicDeps(), { automatic: true });
        return;
      }
      for (const summary of summaries) {
        if (stopped) return;
        if (childIds.has(summary.id)) continue; // The parent exclusively drives its child.
        const run = await getRunForExecution(summary.id);
        if (!run || isCancelRequested(run.id) || !operationalRetryDue(run, now()))
          continue;
        // Reserve the next wakeup before a provider/credential/claim failure can throw.
        const ticket = run.recovery!;
        run.recovery = {
          ...nextOperationalRetry(ticket.stage, ticket, now()),
          attempt: ticket.attempt,
        };
        await saveRun(run);
        if (run.status !== "failed" || !run.recovery || isCancelRequested(run.id))
          return;
        try {
          await deps.resumeRun(run.id);
        } catch (err) {
          const current = await getRunForExecution(run.id);
          if (current?.status === "failed" && current.resumable && current.recovery) {
            current.recovery = nextOperationalRetry(
              current.recovery.stage,
              current.recovery,
              now(),
            );
            current.error = `Automatic recovery postponed: ${safeErrorMessage(err)}`;
            await saveRun(current);
          }
          report(err);
        }
        return;
      }
    } catch (err) {
      report(err);
    } finally {
      busy = false;
    }
  }

  return {
    tick,
    start() {
      if (timer || stopped) return;
      timer = setInterval(() => {
        void tick();
      }, 30_000);
      timer.unref();
      void tick();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

/** Cancel a parked retry without discarding the paid checkpoint or raw idea. */
export async function cancelOperationalRetry(runId: string): Promise<boolean> {
  const run = await getRunForExecution(runId);
  if (!run || run.status !== "failed" || !run.recovery || !run.resumable) return false;
  run.status = "cancelled";
  run.recovery = undefined;
  run.error = null;
  await saveRun(run);
  return true;
}
