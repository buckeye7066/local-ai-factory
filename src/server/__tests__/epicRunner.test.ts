import { afterAll, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createEpic,
  getEpic,
  recoverOrphanedEpics,
  runEpic,
  sliceIdea,
  type EpicDeps,
} from "../orchestrator/epicRunner.js";
import type { RunRecord } from "../../shared/schemas.js";
import { freshStages } from "../../shared/schemas.js";
import { loadConfig, loadSecrets } from "../config.js";

const DATA_DIR = ".test-factory-epics";
process.env.FACTORY_DATA_DIR = DATA_DIR;

afterAll(async () => {
  delete process.env.FACTORY_DATA_DIR;
  await rm(resolve(process.cwd(), DATA_DIR), {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
});

const PLAN = {
  summary: "Add competitor-grade alerts to the tracker",
  slices: [
    {
      title: "Saved-search model",
      goals: "Add the saved_search table and CRUD service.",
      wiringTargets: ["backend/services/savedSearch.js", "backend/db/migrations"],
      acceptance: ["a saved search persists and lists"],
    },
    {
      title: "Alert delivery",
      goals: "Send alert digests for saved searches.",
      wiringTargets: ["backend/services/alerts.js"],
      acceptance: ["a new match produces one digest entry"],
    },
  ],
};

function fakeRun(overrides: Partial<RunRecord>): RunRecord {
  return {
    id: crypto.randomUUID(),
    idea: "x",
    status: "completed",
    resumable: false,
    demo: false,
    codeProvider: "mock",
    reviewProvider: "mock",
    currentStage: null,
    stages: freshStages(),
    logs: [],
    files: [],
    repairLoops: 0,
    providerUsage: {
      free: { calls: 0 },
      anthropic: { calls: 0 },
      openai: { calls: 0 },
      stub: { calls: 0 },
      mock: { calls: 0 },
      totalCalls: 0,
    },
    finalReport: null,
    appName: null,
    workspacePath: null,
    destination: null,
    release: null,
    error: null,
    attribution: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function deps(results: Array<Partial<RunRecord>>): EpicDeps & {
  ideas: string[];
  planOptions: Array<Record<string, unknown>>;
} {
  const ideas: string[] = [];
  const planOptions: Array<Record<string, unknown>> = [];
  let i = 0;
  return {
    ideas,
    planOptions,
    executeSliceRun: async (idea) => {
      ideas.push(idea);
      return fakeRun(results[Math.min(i++, results.length - 1)]!);
    },
    plan: async (_idea, options) => {
      planOptions.push(options as Record<string, unknown>);
      return PLAN;
    },
    config: loadConfig({}),
    secrets: loadSecrets({}),
  };
}

describe("epic slices", () => {
  it.each(["free", "paid"] as const)(
    "passes the persisted %s routing tier into epic planning",
    async (routingMode) => {
      const d = deps([]);
      await createEpic("big evolution", { mode: "extend", routingMode }, d);
      expect(d.planOptions).toHaveLength(1);
      expect(d.planOptions[0]?.routingMode).toBe(routingMode);
    },
  );

  it("renders a self-contained slice idea with wiring targets and the no-paper demand", async () => {
    const d = deps([]);
    const epic = await createEpic("big evolution", { mode: "extend" }, d);
    const idea = sliceIdea(epic, 0);
    expect(idea).toContain("Slice 1 of 2");
    expect(idea).toContain("big evolution");
    expect(idea).toContain("backend/services/savedSearch.js");
    expect(idea).toMatch(/documentation-only or test-only output fails/i);
  });

  it("retains comparative intent even when the planner paraphrases it away", async () => {
    const d = deps([]);
    const epic = await createEpic(
      "make this better than every competitor",
      { mode: "extend" },
      d,
    );

    expect(sliceIdea(epic, 0)).toContain("better than every competitor");
  });

  it("advances only on RELEASED slices and completes when all merge", async () => {
    const released = {
      status: "completed" as const,
      release: { released: true, prUrl: "pr", mergedSha: "abc", reason: "merged" },
    };
    const d = deps([released, released]);
    const epic = await createEpic("big evolution", { mode: "extend" }, d);
    const done = await runEpic(epic, d);
    expect(done.status).toBe("completed");
    expect(done.slices.every((s) => s.status === "released")).toBe(true);
    expect(d.ideas).toHaveLength(2);
    // slice 2 ran only after slice 1 released
    expect(d.ideas[1]).toContain("Slice 2 of 2");
  });

  it("pauses with the named reason when a slice completes but is HELD (paper-only class)", async () => {
    const d = deps([
      {
        status: "completed",
        release: {
          released: false,
          prUrl: "pr",
          mergedSha: null,
          reason: "delivery contains only docs/tests/schema paper",
        },
      },
    ]);
    const epic = await createEpic("big evolution", { mode: "extend" }, d);
    const paused = await runEpic(epic, d);
    expect(paused.status).toBe("paused");
    expect(paused.statusReason).toMatch(/paper/);
    expect(paused.slices[0]!.status).toBe("held");
    expect(paused.slices[1]!.status).toBe("pending");
    expect(d.ideas).toHaveLength(1);
  });

  it("pauses when a slice run throws, and the epic is durable on disk", async () => {
    const d = deps([]);
    d.executeSliceRun = async () => {
      throw new Error("provider exploded");
    };
    const epic = await createEpic("big evolution", { mode: "extend" }, d);
    const paused = await runEpic(epic, d);
    expect(paused.status).toBe("paused");
    expect(paused.statusReason).toMatch(/provider exploded/);
    const reloaded = await getEpic(epic.id);
    expect(reloaded?.status).toBe("paused");
    expect(reloaded?.slices[0]?.status).toBe("failed");
  });

  it("a resumed paused epic retries the same slice and can then finish", async () => {
    const released = {
      status: "completed" as const,
      release: { released: true, prUrl: "pr", mergedSha: "abc", reason: "merged" },
    };
    const d = deps([{ status: "failed", release: null, error: "flaky" }]);
    const epic = await createEpic("big evolution", { mode: "extend" }, d);
    const paused = await runEpic(epic, d);
    expect(paused.status).toBe("paused");
    const savedRunId = paused.slices[0]!.runId;

    // What the resume route does: reset the paused slice and continue.
    paused.slices[paused.currentSlice]!.status = "pending";
    paused.status = "running";
    paused.statusReason = null;
    const d2 = deps([released, released]);
    d2.resumeSliceRun = async (id) => fakeRun({ ...released, id });
    const done = await runEpic(paused, d2);
    expect(done.status).toBe("completed");
    expect(done.slices[0]!.runId).toBe(savedRunId);
    expect(d2.ideas).toHaveLength(1);
    expect(d2.ideas[0]).toContain("Slice 2 of 2");
  });
});

describe("epic resilience across server restarts", () => {
  it("boot recovery pauses orphaned running epics with the reason named", async () => {
    const d = deps([]);
    const epic = await createEpic("big evolution", { mode: "extend" }, d);
    expect(epic.status).toBe("running");
    const n = await recoverOrphanedEpics();
    expect(n).toBeGreaterThanOrEqual(1);
    const reloaded = await getEpic(epic.id);
    expect(reloaded?.status).toBe("paused");
    expect(reloaded?.statusReason).toMatch(/server restart/i);
  });

  it("persists the slice runId at run START, and resumes an interrupted slice from its checkpoint", async () => {
    const released = {
      status: "completed" as const,
      release: { released: true, prUrl: "pr", mergedSha: "abc", reason: "merged" },
    };
    // First pass: the slice run "starts" (runId persisted) then the run fails.
    const d1 = deps([{ status: "failed", release: null, error: "process died" }]);
    const startedIds: string[] = [];
    const origExec = d1.executeSliceRun;
    d1.executeSliceRun = async (_idea, _options, onStarted) => {
      const run = fakeRun({ status: "failed", release: null, error: "process died" });
      startedIds.push(run.id);
      await onStarted?.(run);
      return run;
    };
    void origExec;
    const epic = await createEpic("big evolution", { mode: "extend" }, d1);
    const paused = await runEpic(epic, d1);
    expect(paused.status).toBe("paused");
    // runId was persisted at start, before the failure landed.
    expect(paused.slices[0]!.runId).toBe(startedIds[0]);

    // Resume: the runner tries resumeSliceRun with the saved runId FIRST.
    paused.slices[paused.currentSlice]!.status = "pending";
    paused.status = "running";
    paused.statusReason = null;
    const resumedWith: string[] = [];
    const d2 = deps([released, released]);
    d2.resumeSliceRun = async (runId) => {
      resumedWith.push(runId);
      return fakeRun({ ...released, id: runId });
    };
    const done = await runEpic(paused, d2);
    expect(resumedWith[0]).toBe(startedIds[0]);
    expect(done.slices[0]!.status).toBe("released");
    expect(done.slices[0]!.runId).toBe(startedIds[0]);
    expect(d2.ideas).toHaveLength(1);
  });
});

describe("saved epic checkpoint safety", () => {
  const released: Partial<RunRecord> = {
    status: "completed",
    release: { released: true, prUrl: "pr", mergedSha: "abc", reason: "merged" },
  };

  it.each([
    "provider capacity temporarily unavailable",
    "saved checkpoint could not be read",
    "saved run is already executing",
  ])("preserves the saved run when resume reports: %s", async (reason) => {
    const first = deps([{ status: "failed", release: null, error: "interrupted" }]);
    const epic = await createEpic("keep the original work", { mode: "extend" }, first);
    const paused = await runEpic(epic, first);
    const savedRunId = paused.slices[0]!.runId;
    const recovery = deps([released]);
    const resumedIds: string[] = [];
    recovery.resumeSliceRun = async (id) => {
      resumedIds.push(id);
      throw new Error(reason);
    };

    const result = await runEpic(paused, recovery);
    expect(result.status).toBe("paused");
    expect(result.currentSlice).toBe(0);
    expect(result.statusReason).toContain(reason);
    expect(result.slices[0]!.runId).toBe(savedRunId);
    expect(result.slices[1]!.status).toBe("pending");
    expect(resumedIds).toEqual([savedRunId]);
    expect(recovery.ideas).toEqual([]);
    expect(recovery.planOptions).toEqual([]);
    const persisted = await getEpic(epic.id);
    expect(persisted?.slices[0]?.runId).toBe(savedRunId);
    expect(persisted?.statusReason).toContain(reason);
  });

  it("does not replace a saved run when the resume handler is unavailable", async () => {
    const first = deps([{ status: "failed", release: null }]);
    const epic = await createEpic("preserve checkpoint", { mode: "extend" }, first);
    const paused = await runEpic(epic, first);
    const savedRunId = paused.slices[0]!.runId;
    const recovery = deps([released]);

    const result = await runEpic(paused, recovery);
    expect(result.status).toBe("paused");
    expect(result.statusReason).toContain("no resume handler");
    expect(result.slices[0]!.runId).toBe(savedRunId);
    expect(result.currentSlice).toBe(0);
    expect(recovery.ideas).toEqual([]);
    expect((await getEpic(epic.id))?.slices[0]?.runId).toBe(savedRunId);
  });

  it("refuses a replacement identity returned by the resume handler", async () => {
    const first = deps([{ status: "failed", release: null }]);
    const epic = await createEpic("preserve identity", { mode: "extend" }, first);
    const paused = await runEpic(epic, first);
    const savedRunId = paused.slices[0]!.runId;
    const recovery = deps([released]);
    recovery.resumeSliceRun = async () => fakeRun(released);

    const result = await runEpic(paused, recovery);
    expect(result.status).toBe("paused");
    expect(result.statusReason).toContain("different run");
    expect(result.slices[0]!.runId).toBe(savedRunId);
    expect(result.slices[1]!.status).toBe("pending");
    expect(result.currentSlice).toBe(0);
    expect(recovery.ideas).toEqual([]);
    expect((await getEpic(epic.id))?.slices[0]?.runId).toBe(savedRunId);
  });

  it("does not skip a resumed run that still fails", async () => {
    const first = deps([{ status: "failed", release: null }]);
    const epic = await createEpic("retry saved work", { mode: "extend" }, first);
    const paused = await runEpic(epic, first);
    const savedRunId = paused.slices[0]!.runId;
    const recovery = deps([released]);
    recovery.resumeSliceRun = async (id) =>
      fakeRun({ id, status: "failed", release: null, error: "build still fails" });

    const result = await runEpic(paused, recovery);
    expect(result.status).toBe("paused");
    expect(result.statusReason).toContain("build still fails");
    expect(result.slices[0]!.runId).toBe(savedRunId);
    expect(result.slices[1]!.status).toBe("pending");
    expect(result.currentSlice).toBe(0);
    expect(recovery.ideas).toEqual([]);
  });

  it("can retry the preserved checkpoint after a failed recovery and reload", async () => {
    const first = deps([{ status: "failed", release: null }]);
    const epic = await createEpic("durable recovery", { mode: "extend" }, first);
    const paused = await runEpic(epic, first);
    const savedRunId = paused.slices[0]!.runId;
    const unavailable = deps([released]);
    unavailable.resumeSliceRun = async () => {
      throw new Error("temporary outage");
    };
    await runEpic(paused, unavailable);
    const persisted = await getEpic(epic.id);
    expect(persisted).not.toBeNull();

    const restored = deps([released]);
    const resumedIds: string[] = [];
    restored.resumeSliceRun = async (id) => {
      resumedIds.push(id);
      return fakeRun({ ...released, id });
    };
    const done = await runEpic(persisted!, restored);
    expect(done.status).toBe("completed");
    expect(done.slices[0]!.runId).toBe(savedRunId);
    expect(resumedIds).toEqual([savedRunId]);
    expect(unavailable.ideas).toEqual([]);
    expect(restored.ideas).toHaveLength(1);
    expect(restored.ideas[0]).toContain("Slice 2 of 2");
  });

  it("resumes the first of five slices and executes only the four remaining slices", async () => {
    const first = deps([{ status: "failed", release: null, error: "interrupted" }]);
    first.plan = async () => ({
      summary: "Five-stage product evolution",
      slices: Array.from({ length: 5 }, (_,index) => ({
        ...PLAN.slices[0]!,
        title: `Product slice ${index + 1}`,
      })),
    });
    const epic = await createEpic("finish all five slices", { mode: "extend" }, first);
    const paused = await runEpic(epic, first);
    const savedRunId = paused.slices[0]!.runId;
    const recovery = deps([released]);
    const resumedIds: string[] = [];
    recovery.resumeSliceRun = async (id) => {
      resumedIds.push(id);
      return fakeRun({ ...released, id });
    };

    const done = await runEpic(paused, recovery);
    expect(done.status).toBe("completed");
    expect(done.currentSlice).toBe(5);
    expect(done.slices.every((slice) => slice.status === "released")).toBe(true);
    expect(done.slices[0]!.runId).toBe(savedRunId);
    expect(resumedIds).toEqual([savedRunId]);
    expect(recovery.ideas).toHaveLength(4);
    for (let i = 0; i < 4; i++) {
      expect(recovery.ideas[i]).toContain(`Slice ${i + 2} of 5`);
    }
    expect(recovery.planOptions).toEqual([]);
  });
});
