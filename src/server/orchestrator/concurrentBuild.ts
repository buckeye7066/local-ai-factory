import type { LLMProvider } from "../../shared/types.js";
import type {
  FileBuild,
  ProductSpec,
  Architecture,
  TaskPlan,
} from "../../shared/schemas.js";
import {
  fileBuilderAgent,
  type ExistingRepoContext,
  type AdditionalSourceContext,
} from "../agents/fileBuilderAgent.js";
import type { ResearchFindings } from "../agents/researchAgent.js";
import {
  dispatchConcurrent,
  type DispatchTask,
} from "../providers/concurrentDispatcher.js";

/**
 * concurrentBuild.ts — the one place the multi-model concurrent-dispatch
 * principle actually touches the build pipeline for real.
 *
 * The task planner already groups work into independent categories
 * (frontend/backend/database/tests/docs). Those groups genuinely don't depend
 * on each other's OUTPUT within a single build pass, so when more than one
 * live backend is configured, this fires one fileBuilderAgent call per
 * category CONCURRENTLY, each pulled off a shared queue by whichever backend
 * is free — instead of picking one provider and leaving the rest idle. When
 * only one provider is configured, or there's only one category, this
 * degrades to exactly the original single-call behavior (no behavior change,
 * no new risk) — sequential stages elsewhere in the pipeline (spec before
 * architect before plan before build) are untouched.
 */

export interface ConcurrentBuildResult {
  build: FileBuild;
  /** How many category-groups each provider actually built — proof of real concurrency. */
  tasksByProvider: Record<string, number>;
  usedConcurrency: boolean;
  /** Category-level accounting: every planned category is built, failed (with
   * reason), or empty (schema-valid but produced no files) — never silent. */
  failures: { id: string; reason: string }[];
  empties: string[];
}

function groupTasksByCategory(plan: TaskPlan): Map<string, TaskPlan["tasks"]> {
  const groups = new Map<string, TaskPlan["tasks"]>();
  for (const task of plan.tasks) {
    const list = groups.get(task.category) ?? [];
    list.push(task);
    groups.set(task.category, list);
  }
  return groups;
}

export async function buildFilesConcurrently(
  /** The resilient default provider (e.g. the free->paid failover chain), used
   *  whenever concurrency isn't applicable — preserves that resilience instead
   *  of falling back to one arbitrary raw pool member. */
  primary: LLMProvider,
  /** Distinct raw backends (free/anthropic/openai — never the failover chain
   *  itself) to spread genuinely independent work across. */
  pool: LLMProvider[],
  spec: ProductSpec,
  arch: Architecture,
  plan: TaskPlan,
  existing: ExistingRepoContext | undefined,
  research?: ResearchFindings,
  additionalSources?: AdditionalSourceContext[],
): Promise<ConcurrentBuildResult> {
  const groups = groupTasksByCategory(plan);
  const configured = pool.filter((p) => p.isConfigured());

  if (configured.length < 2 || groups.size < 2) {
    const build = await fileBuilderAgent(
      { provider: primary },
      spec,
      arch,
      plan,
      existing,
      research,
      additionalSources,
    );
    return { build, tasksByProvider: {}, usedConcurrency: false, failures: [], empties: [] };
  }

  const tasks: DispatchTask<FileBuild>[] = [...groups.entries()].map(
    ([category, categoryTasks]) => ({
      id: category,
      run: (provider) =>
        fileBuilderAgent(
          { provider },
          spec,
          arch,
          { tasks: categoryTasks },
          existing,
          research,
          additionalSources,
        ),
    }),
  );

  const summary = await dispatchConcurrent(configured, tasks);
  const failed = summary.outcomes.filter((o) => o.error);
  if (failed.length === summary.outcomes.length) {
    // Every category failed — surface the first error rather than an empty build.
    throw failed[0].error instanceof Error
      ? failed[0].error
      : new Error(String(failed[0].error));
  }

  // NO SILENT SKIPS (owner doctrine): run f0077040 dispatched 30 tasks in 13
  // categories, 12 produced nothing, and the run marched to QA with a single
  // README as "the build". Every category is now accounted for by name.
  const failures = failed.map((o) => ({
    id: o.id,
    reason: String((o.error as Error)?.message ?? o.error).slice(0, 300),
  }));
  const empties = summary.outcomes
    .filter((o) => !o.error && (!o.result || o.result.files.length === 0))
    .map((o) => o.id);

  const files: FileBuild["files"] = [];
  const seenPaths = new Set<string>();
  for (const outcome of summary.outcomes) {
    if (!outcome.result) continue;
    for (const f of outcome.result.files) {
      // Later categories win on a path collision (rare — categories are meant
      // to be independent) rather than silently dropping a file.
      if (seenPaths.has(f.path)) {
        const idx = files.findIndex((x) => x.path === f.path);
        if (idx >= 0) files[idx] = f;
        continue;
      }
      seenPaths.add(f.path);
      files.push(f);
    }
  }
  return {
    build: { files },
    tasksByProvider: summary.tasksByProvider,
    usedConcurrency: true,
    failures,
    empties,
  };
}
