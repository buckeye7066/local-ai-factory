import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { AppConfig, AppSecrets } from "../config.js";
import {
  isValidRunId,
  OperationalRetrySchema,
  type RunOptions,
  type RunRecord,
} from "../../shared/schemas.js";
import { EpicPlanSchema, type EpicPlan } from "../agents/epicPlannerAgent.js";
import { appendAuditEvent } from "../storage/auditLog.js";
import { getRunForExecution, writeFileContained } from "../storage/runsStore.js";
import { nextOperationalRetry } from "./operationalRetry.js";

/**
 * epicRunner — sequential slice execution for large evolutions.
 *
 * One slice at a time, each through the FULL normal pipeline (build → real
 * QA/tests → branch → PR → host CI → auto-release), each starting from a
 * fresh clone that already contains every previously merged slice. The epic
 * advances only on a slice that actually RELEASED (merged to main) — a slice
 * that completed but was held (paper-only, failed checks) PAUSES the epic
 * with the hold reason named, because later slices assume earlier ones are
 * real. No approval gates anywhere: the epic runs to the end or pauses on
 * evidence, and a paused epic is resumable after the cause is fixed.
 */

export const EpicSliceStateSchema = z.object({
  title: z.string(),
  goals: z.string(),
  wiringTargets: z.array(z.string()),
  acceptance: z.array(z.string()),
  status: z.enum(["pending", "running", "released", "held", "failed"]),
  runId: z.string().nullable().default(null),
  prUrl: z.string().nullable().default(null),
  mergedSha: z.string().nullable().default(null),
  detail: z.string().nullable().default(null),
});

export const EpicRecordSchema = z.object({
  id: z.string(),
  idea: z.string(),
  summary: z.string(),
  status: z.enum(["planning", "running", "paused", "completed", "failed"]),
  /** Why the epic paused/failed — always named, never silent. */
  statusReason: z.string().nullable().default(null),
  recovery: OperationalRetrySchema.optional(),
  slices: z.array(EpicSliceStateSchema),
  currentSlice: z.number().int().default(0),
  options: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type EpicRecord = z.infer<typeof EpicRecordSchema>;

const EPICS_DIR = () =>
  resolve(process.cwd(), process.env.FACTORY_DATA_DIR || ".factory", "epics");

const epicWrites = new Map<string, Promise<void>>();
const activeEpics = new Set<string>();
export const isEpicActive = (id: string): boolean => activeEpics.has(id);

export async function saveEpic(epic: EpicRecord): Promise<void> {
  if (!isValidRunId(epic.id)) throw new Error("Refused: invalid epic id.");
  epic.updatedAt = Date.now();
  // Snapshot before yielding and serialize concurrent saves of the same record.
  const data = JSON.stringify(EpicRecordSchema.parse(epic), null, 2);
  const dir = EPICS_DIR();
  const target = resolve(dir, `${epic.id}.json`);
  const previous = epicWrites.get(target) ?? Promise.resolve();
  const write = previous
    .catch(() => {})
    .then(async () => {
      await mkdir(dir, { recursive: true });
      await writeFileContained(target, data);
    });
  epicWrites.set(target, write);
  try {
    await write;
  } finally {
    if (epicWrites.get(target) === write) epicWrites.delete(target);
  }
}

export async function getEpic(id: string): Promise<EpicRecord | null> {
  if (!isValidRunId(id)) return null;
  let raw: string;
  try {
    raw = await readFile(resolve(EPICS_DIR(), `${id}.json`), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    const epic = EpicRecordSchema.parse(JSON.parse(raw));
    if (epic.id !== id) throw new Error("record identity does not match its filename");
    return epic;
  } catch (err) {
    // Corruption is an explicit error, never a silently missing job or a fresh run.
    throw new Error(
      `Epic ${id} is unreadable; its saved work was preserved: ${String(err)}`,
    );
  }
}

export async function listEpics(): Promise<EpicRecord[]> {
  let files: string[];
  try {
    files = await readdir(EPICS_DIR());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const epics: EpicRecord[] = [];
  for (const file of files.filter((f) => f.endsWith(".json"))) {
    const epic = await getEpic(file.replace(/\.json$/, ""));
    if (epic) epics.push(epic);
  }
  return epics.sort((a, b) => b.createdAt - a.createdAt);
}

/** One slice's goals rendered as a complete, self-contained run idea. */
export function sliceIdea(epic: EpicRecord, index: number): string {
  const slice = epic.slices[index]!;
  return [
    `Slice ${index + 1} of ${epic.slices.length} of a larger evolution: ${epic.summary}`,
    `ORIGINAL EPIC GOAL (authoritative for every slice): ${epic.idea}`,
    ``,
    `THIS SLICE — ${slice.title}:`,
    slice.goals,
    ``,
    `You MUST wire the changes into these real integration points: ${slice.wiringTargets.join(", ")}.`,
    `Acceptance criteria for this slice:`,
    ...slice.acceptance.map((a) => `- ${a}`),
    ``,
    `Deliver working, wired product behavior or finished runtime-consumed product content only. ` +
      `Documentation-only or test-only output fails this slice; placeholder-only, outline-only, generated-fallback, or sample-only output also fails. ` +
      `For curriculum/coursework work, the slice is not complete until its assigned courses contain substantive instructional material, ` +
      `the assessments and answer keys supported by the target product, required pacing/metadata, and pass the repository's content validators.`,
  ].join("\n");
}

export interface EpicDeps {
  /**
   * Executes one slice run to completion and returns the final RunRecord.
   * onStarted fires as soon as the run record exists, so the epic can persist
   * the runId while the slice is still alive (a crashed server used to leave
   * running slices with runId=null — unfindable).
   */
  executeSliceRun: (
    idea: string,
    options: RunOptions,
    onStarted?: (run: RunRecord) => void | Promise<void>,
  ) => Promise<RunRecord>;
  /**
   * Resume the same saved run from its checkpoint. A missing handler or any
   * failure pauses the epic without replacing the run or replaying paid work.
   */
  resumeSliceRun?: (runId: string, automatic?: boolean) => Promise<RunRecord>;
  plan: (idea: string, options: RunOptions) => Promise<EpicPlan>;
  config: AppConfig;
  secrets: AppSecrets;
}

/** Persist the shell immediately so the API can answer before planning. */
export async function createEpicShell(
  idea: string,
  options: RunOptions,
): Promise<EpicRecord> {
  const epic: EpicRecord = {
    id: randomUUID(),
    idea,
    summary: "",
    status: "planning",
    statusReason: null,
    slices: [],
    currentSlice: 0,
    options: options as Record<string, unknown>,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await saveEpic(epic);
  await appendAuditEvent({
    type: "epic.created",
    runId: epic.id,
    detail: idea.slice(0, 200),
  });
  return epic;
}

/**
 * Plan the shell's slices. Planning can take minutes on the free route, so
 * callers run this in the background; a failed plan lands on the record with
 * its reason instead of throwing into the void.
 */
export async function planEpic(epic: EpicRecord, deps: EpicDeps): Promise<EpicRecord> {
  try {
    const plan = EpicPlanSchema.parse(
      await deps.plan(epic.idea, epic.options as RunOptions),
    );
    epic.summary = plan.summary;
    epic.slices = plan.slices.map((s) => ({
      ...s,
      status: "pending" as const,
      runId: null,
      prUrl: null,
      mergedSha: null,
      detail: null,
    }));
    epic.status = "running";
  } catch (err) {
    epic.status = "failed";
    epic.statusReason = `planning failed: ${String((err as Error)?.message ?? err)}`;
  }
  await saveEpic(epic);
  return epic;
}

export async function createEpic(
  idea: string,
  options: RunOptions,
  deps: EpicDeps,
): Promise<EpicRecord> {
  const epic = await planEpic(await createEpicShell(idea, options), deps);
  if (epic.status === "failed") {
    throw new Error(epic.statusReason ?? "epic planning failed");
  }
  return epic;
}

/**
 * Boot-time recovery: an epic whose driving loop died with the process is
 * stuck "running"/"planning" forever with nothing advancing it. Mark such
 * orphans paused with the reason named — resumable, never silent.
 */
export async function recoverOrphanedEpics(): Promise<number> {
  let recovered = 0;
  for (const epic of await listEpics()) {
    if (
      isEpicActive(epic.id) ||
      (epic.status !== "running" && epic.status !== "planning")
    )
      continue;
    epic.status = "paused";
    epic.recovery = { stage: "restart", attempt: 0, nextAttemptAt: Date.now() };
    epic.statusReason =
      "interrupted by a server restart; automatic recovery will continue the saved current slice";
    const slice = epic.slices[epic.currentSlice];
    if (slice && slice.status === "running") slice.status = "pending";
    await saveEpic(epic);
    await appendAuditEvent({
      type: "epic.paused",
      runId: epic.id,
      detail: epic.statusReason,
    });
    recovered++;
  }
  return recovered;
}

/** One claim covers planning, resume, and every child, including API/worker races. */
export async function runEpic(
  epic: EpicRecord,
  deps: EpicDeps,
  options: { automatic?: boolean } = {},
): Promise<EpicRecord> {
  if (activeEpics.has(epic.id)) throw new Error("Epic is already executing.");
  activeEpics.add(epic.id);
  let canonicalLoaded = false;
  try {
    // Re-read under the claim: a stale API snapshot must not replay a finished epic.
    const saved = await getEpic(epic.id);
    if (!saved)
      throw new Error("Saved epic no longer exists; refusing to recreate it.");
    epic = saved;
    canonicalLoaded = true;
    if (epic.status === "completed") return epic;
    if (options.automatic && !epic.recovery) return epic;
    if (!options.automatic) epic.recovery = undefined;
    if (epic.slices.length === 0) {
      epic = await planEpic(epic, deps);
      if (epic.status === "failed") {
        if (options.automatic)
          epic.recovery = nextOperationalRetry("restart", epic.recovery);
        await saveEpic(epic);
        return epic;
      }
    }
    epic.status = "running";
    epic.statusReason = null;
    await saveEpic(epic);
    return await driveEpic(epic, deps, options.automatic === true);
  } catch (error) {
    // A failed save/audit outside the child loop must not strand an unclaimed
    // "running" epic. Keep the original slice identity and durable retry intent.
    if (canonicalLoaded && epic.status !== "completed") {
      epic.status = "paused";
      epic.statusReason = `Epic execution postponed: ${error instanceof Error ? error.message : String(error)}`;
      if (options.automatic && epic.recovery) {
        epic.recovery = nextOperationalRetry(epic.recovery.stage, epic.recovery);
      }
      await saveEpic(epic);
    }
    throw error;
  } finally {
    activeEpics.delete(epic.id);
  }
}

async function driveEpic(
  epic: EpicRecord,
  deps: EpicDeps,
  automatic: boolean,
): Promise<EpicRecord> {
  while (epic.currentSlice < epic.slices.length) {
    const i = epic.currentSlice;
    const slice = epic.slices[i]!;
    slice.status = "running";
    await saveEpic(epic);

    let run: RunRecord;
    try {
      // A saved run is continuity evidence, not permission to replace it.
      // Provider outages, active-run conflicts and unreadable checkpoints must
      // preserve that identity and pause with the real cause. Previously every
      // resume exception silently started a fresh run and overwrote the runId.
      const savedRunId = slice.runId;
      if (savedRunId) {
        // The child may have finished before the parent persisted advancement.
        // Completed children no longer have resumable checkpoints. Reconcile
        // their saved result and let the unchanged release gate decide below.
        const savedRun = await getRunForExecution(savedRunId);
        if (automatic && savedRun?.status === "cancelled") {
          // A user cancellation is never overridden by restart recovery.
          epic.recovery = undefined;
          throw new Error(
            "Saved slice was cancelled by the user; automatic recovery stopped.",
          );
        }
        if (automatic && savedRun?.status === "failed" && !savedRun.resumable) {
          epic.recovery = undefined;
          throw new Error(
            "Saved slice has a terminal hold; automatic recovery stopped.",
          );
        }
        if (savedRun?.status === "completed") {
          run = savedRun;
        } else {
          if (!deps.resumeSliceRun) {
            throw new Error(
              `Cannot resume saved slice run ${savedRunId}: no resume handler is available. The existing run was preserved.`,
            );
          }
          run = automatic
            ? await deps.resumeSliceRun(savedRunId, true)
            : await deps.resumeSliceRun(savedRunId);
        }
        if (run.id !== savedRunId) {
          throw new Error(
            `Resume returned a different run for saved slice ${savedRunId}. The existing slice identity was preserved.`,
          );
        }
      } else {
        run = await deps.executeSliceRun(
          sliceIdea(epic, i),
          { ...(epic.options as RunOptions) },
          async (started) => {
            slice.runId = started.id;
            await saveEpic(epic);
          },
        );
      }
    } catch (err) {
      slice.status = "failed";
      slice.detail = String((err as Error)?.message ?? err);
      epic.status = "paused";
      epic.statusReason = `Slice ${i + 1} (${slice.title}) failed to run: ${slice.detail}`;
      if (epic.recovery)
        epic.recovery = nextOperationalRetry(epic.recovery.stage, epic.recovery);
      await saveEpic(epic);
      await appendAuditEvent({
        type: "epic.paused",
        runId: epic.id,
        detail: epic.statusReason,
      });
      return epic;
    }

    slice.runId = run.id;
    if (run.status === "completed" && run.release?.released) {
      slice.status = "released";
      slice.prUrl = run.release.prUrl;
      slice.mergedSha = run.release.mergedSha;
      slice.detail = run.release.reason;
      epic.currentSlice = i + 1;
      await saveEpic(epic);
      await appendAuditEvent({
        type: "epic.slice.released",
        runId: epic.id,
        detail: `${i + 1}/${epic.slices.length} ${slice.title} → ${slice.mergedSha ?? "merged"}`,
      });
      continue;
    }

    // Completed-but-held or failed: pause with the real reason. Later slices
    // assume this one is merged, so continuing would compound the miss.
    slice.status = run.status === "completed" ? "held" : "failed";
    slice.detail =
      run.release?.reason ??
      run.error ??
      `run finished with status ${run.status} and no release`;
    epic.status = "paused";
    epic.statusReason = `Slice ${i + 1} (${slice.title}) ${slice.status}: ${slice.detail}`;
    epic.recovery = run.status === "failed" && run.resumable ? run.recovery : undefined;
    await saveEpic(epic);
    await appendAuditEvent({
      type: "epic.paused",
      runId: epic.id,
      detail: epic.statusReason,
    });
    return epic;
  }

  epic.status = "completed";
  epic.statusReason = null;
  epic.recovery = undefined;
  await saveEpic(epic);
  await appendAuditEvent({
    type: "epic.completed",
    runId: epic.id,
    detail: `${epic.slices.length} slice(s) released`,
  });
  return epic;
}
