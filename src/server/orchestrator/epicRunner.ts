import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { AppConfig, AppSecrets } from "../config.js";
import type { RunOptions, RunRecord } from "../../shared/schemas.js";
import { EpicPlanSchema, type EpicPlan } from "../agents/epicPlannerAgent.js";
import { appendAuditEvent } from "../storage/auditLog.js";

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
  slices: z.array(EpicSliceStateSchema),
  currentSlice: z.number().int().default(0),
  options: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type EpicRecord = z.infer<typeof EpicRecordSchema>;

const EPICS_DIR = () =>
  resolve(process.cwd(), process.env.FACTORY_DATA_DIR || ".factory", "epics");

export async function saveEpic(epic: EpicRecord): Promise<void> {
  await mkdir(EPICS_DIR(), { recursive: true });
  epic.updatedAt = Date.now();
  await writeFile(
    resolve(EPICS_DIR(), `${epic.id}.json`),
    JSON.stringify(epic, null, 2),
    "utf8",
  );
}

export async function getEpic(id: string): Promise<EpicRecord | null> {
  try {
    const raw = await readFile(resolve(EPICS_DIR(), `${id}.json`), "utf8");
    return EpicRecordSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function listEpics(): Promise<EpicRecord[]> {
  try {
    const files = await readdir(EPICS_DIR());
    const epics: EpicRecord[] = [];
    for (const f of files.filter((f) => f.endsWith(".json"))) {
      const epic = await getEpic(f.replace(/\.json$/, ""));
      if (epic) epics.push(epic);
    }
    return epics.sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

/** One slice's goals rendered as a complete, self-contained run idea. */
export function sliceIdea(epic: EpicRecord, index: number): string {
  const slice = epic.slices[index]!;
  return [
    `Slice ${index + 1} of ${epic.slices.length} of a larger evolution: ${epic.summary}`,
    ``,
    `THIS SLICE — ${slice.title}:`,
    slice.goals,
    ``,
    `You MUST wire the changes into these real integration points: ${slice.wiringTargets.join(", ")}.`,
    `Acceptance criteria for this slice:`,
    ...slice.acceptance.map((a) => `- ${a}`),
    ``,
    `Deliver working, wired product behavior only — documentation-only or test-only output fails this slice.`,
  ].join("\n");
}

export interface EpicDeps {
  /** Executes one slice run to completion and returns the final RunRecord. */
  executeSliceRun: (idea: string, options: RunOptions) => Promise<RunRecord>;
  plan: (idea: string) => Promise<EpicPlan>;
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
  await appendAuditEvent({ type: "epic.created", runId: epic.id, detail: idea.slice(0, 200) });
  return epic;
}

/**
 * Plan the shell's slices. Planning can take minutes on the free route, so
 * callers run this in the background; a failed plan lands on the record with
 * its reason instead of throwing into the void.
 */
export async function planEpic(epic: EpicRecord, deps: EpicDeps): Promise<EpicRecord> {
  try {
    const plan = EpicPlanSchema.parse(await deps.plan(epic.idea));
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
 * Run the epic from its current slice until completion or pause. Never
 * throws — every outcome lands on the record with its reason.
 */
export async function runEpic(epic: EpicRecord, deps: EpicDeps): Promise<EpicRecord> {
  while (epic.currentSlice < epic.slices.length) {
    const i = epic.currentSlice;
    const slice = epic.slices[i]!;
    slice.status = "running";
    await saveEpic(epic);

    let run: RunRecord;
    try {
      run = await deps.executeSliceRun(sliceIdea(epic, i), {
        ...(epic.options as RunOptions),
      });
    } catch (err) {
      slice.status = "failed";
      slice.detail = String((err as Error)?.message ?? err);
      epic.status = "paused";
      epic.statusReason = `Slice ${i + 1} (${slice.title}) failed to run: ${slice.detail}`;
      await saveEpic(epic);
      await appendAuditEvent({ type: "epic.paused", runId: epic.id, detail: epic.statusReason });
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
    await saveEpic(epic);
    await appendAuditEvent({ type: "epic.paused", runId: epic.id, detail: epic.statusReason });
    return epic;
  }

  epic.status = "completed";
  epic.statusReason = null;
  await saveEpic(epic);
  await appendAuditEvent({
    type: "epic.completed",
    runId: epic.id,
    detail: `${epic.slices.length} slice(s) released`,
  });
  return epic;
}
