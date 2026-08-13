import type { LLMProvider } from "../../shared/types.js";

/**
 * concurrentDispatcher.ts — generic multi-backend work-stealing scheduler.
 *
 * "Tie in every AI model available... dispatch across them CONCURRENTLY from
 * a shared work queue — each backend pulls its next task the moment it's
 * free" (not: pick one provider and leave the others idle). This is the
 * general-purpose mechanism; callers decide WHICH independent, parallelizable
 * work is safe to hand it (sequential pipeline stages must never go through
 * this — only genuinely independent units within a stage).
 */

export interface DispatchTask<T> {
  id: string;
  run: (provider: LLMProvider) => Promise<T>;
}

interface QueuedTask<T> extends DispatchTask<T> {
  /** Providers that have already failed this task — never retried on them again. */
  excluded: Set<string>;
}

export interface DispatchOutcome<T> {
  id: string;
  servedBy: string;
  result?: T;
  error?: unknown;
}

export interface DispatchSummary<T> {
  outcomes: DispatchOutcome<T>[];
  /** How many tasks each provider actually picked up — proves real concurrency. */
  tasksByProvider: Record<string, number>;
}

/**
 * Run `tasks` against `providers` as a shared queue: every provider loops
 * pulling the next unclaimed task until the queue is empty, so N providers
 * genuinely work in parallel rather than being tried one at a time.
 *
 * A task that fails is requeued for a DIFFERENT provider to try — never the
 * one that just failed it — rather than being dropped outright. This matters
 * because a failure here isn't always "this task is broken"; it can be "this
 * particular backend just became unusable mid-run" (a paid provider's budget
 * gate tripping partway through a burst is the concrete case this guards
 * against). A task is only recorded as failed once every distinct provider
 * in the pool has failed it.
 */
export async function dispatchConcurrent<T>(
  providers: LLMProvider[],
  tasks: DispatchTask<T>[],
): Promise<DispatchSummary<T>> {
  if (providers.length === 0) {
    throw new Error("dispatchConcurrent: no providers given.");
  }
  // De-dupe providers by name so the same backend isn't spun up twice.
  const seen = new Set<string>();
  const pool = providers.filter((p) => {
    if (seen.has(p.name)) return false;
    seen.add(p.name);
    return true;
  });

  const queue: QueuedTask<T>[] = tasks.map((t) => ({
    ...t,
    excluded: new Set<string>(),
  }));
  const outcomes: DispatchOutcome<T>[] = [];
  const tasksByProvider: Record<string, number> = {};

  async function worker(provider: LLMProvider): Promise<void> {
    for (;;) {
      // Synchronous find+remove — no `await` in between — so this is atomic
      // for the single-threaded event loop; two workers can never grab the
      // same queue slot.
      const idx = queue.findIndex((t) => !t.excluded.has(provider.name));
      if (idx === -1) return; // nothing left this provider hasn't already failed
      const [task] = queue.splice(idx, 1);
      tasksByProvider[provider.name] = (tasksByProvider[provider.name] ?? 0) + 1;
      try {
        const result = await task.run(provider);
        outcomes.push({ id: task.id, servedBy: provider.name, result });
      } catch (error) {
        task.excluded.add(provider.name);
        if (task.excluded.size < pool.length) {
          queue.push(task); // a different provider still hasn't tried this one
        } else {
          outcomes.push({ id: task.id, servedBy: provider.name, error });
        }
      }
    }
  }

  await Promise.all(pool.map((p) => worker(p)));
  return { outcomes, tasksByProvider };
}
