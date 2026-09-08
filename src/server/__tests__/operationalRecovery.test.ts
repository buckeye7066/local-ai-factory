import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunRecord } from "../../shared/schemas.js";
import { freshStages } from "../../shared/schemas.js";
import { loadConfig, loadSecrets } from "../config.js";

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "factory-operational-recovery-"));
  vi.stubEnv("FACTORY_DATA_DIR", dataDir);
  vi.resetModules();
});
afterEach(async () => {
  vi.doUnmock("node:fs/promises");
  vi.unstubAllEnvs();
  vi.resetModules();
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: randomUUID(),
    idea: "saved child",
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
    release: {
      released: true,
      prUrl: "https://github.com/example/fixture/pull/1",
      mergedSha: "a".repeat(40),
      reason: "fixture release already recorded",
    },
    error: null,
    attribution: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function dependencies() {
  const executeSliceRun = vi.fn(async () => record());
  const resumeSliceRun = vi.fn(async (id: string) => record({ id }));
  const plan = vi.fn(async () => ({
    summary: "Two real release-gated slices",
    slices: [1, 2].map((n) => ({
      title: `Slice ${n}`,
      goals: `Implement ${n}`,
      wiringTargets: ["src/app.ts"],
      acceptance: [`behavior ${n} passes`],
    })),
  }));
  return {
    executeSliceRun,
    resumeSliceRun,
    plan,
    config: loadConfig({}),
    secrets: loadSecrets({}),
  };
}
async function setup() {
  const epics = await import("../orchestrator/epicRunner.js");
  const store = await import("../storage/runsStore.js");
  const recovery = await import("../orchestrator/operationalRecovery.js");
  const deps = dependencies();
  const resumeRun = vi.fn(async (id: string) => {
    const completed = record({ id });
    await store.saveRun(completed);
    return completed;
  });
  const onError = vi.fn();
  const worker = recovery.createOperationalRecovery({
    epicDeps: () => deps,
    resumeRun,
    onError,
    now: () => Date.now() + 60_000,
  });
  return { epics, store, recovery, deps, resumeRun, onError, worker };
}

describe("durable automatic operational recovery", () => {
  it("resumes a standalone interrupted checkpoint after a process restart", async () => {
    const f = await setup();
    const run = record({ status: "running", resumable: false, release: null });
    const { FactoryCheckpointSchema } = await import("../orchestrator/checkpoint.js");
    await f.store.saveRun(run);
    await f.store.saveRunCheckpoint(
      FactoryCheckpointSchema.parse({
        schemaVersion: 3,
        runId: run.id,
        idea: run.idea,
        options: {},
        updatedAt: Date.now(),
      }),
    );
    vi.resetModules();
    const restarted = await setup();
    await restarted.worker.tick();
    expect(restarted.resumeRun).toHaveBeenCalledWith(run.id);
    expect((await restarted.store.getRunForExecution(run.id))?.status).toBe(
      "completed",
    );
  });
  it("restarts an interrupted epic without a manual resume or replaying its completed child", async () => {
    const f = await setup();
    const epic = await f.epics.createEpic("preserve original work", {}, f.deps);
    const child = record();
    epic.slices[0]!.runId = child.id;
    epic.slices[0]!.status = "running";
    await f.epics.saveEpic(epic);
    await f.store.saveRun(child);
    vi.resetModules();
    const restarted = await setup();
    await restarted.epics.recoverOrphanedEpics();
    await restarted.worker.tick();
    const saved = await restarted.epics.getEpic(epic.id);
    expect(saved?.status).toBe("completed");
    expect(saved?.slices[0]?.runId).toBe(child.id);
    expect(saved?.recovery).toBeUndefined();
    expect(restarted.deps.resumeSliceRun).not.toHaveBeenCalled();
    expect(restarted.deps.executeSliceRun).toHaveBeenCalledTimes(1);
    expect(restarted.resumeRun).not.toHaveBeenCalled();
  });

  it("reconciles a pending child release and advances only after the same child merges", async () => {
    const f = await setup();
    const epic = await f.epics.createEpic("finish delayed release", {}, f.deps);
    const child = record({
      status: "failed",
      resumable: true,
      recovery: { stage: "release", attempt: 1, nextAttemptAt: 0 },
      release: {
        released: false,
        state: "pending",
        prUrl: "pr",
        mergedSha: null,
        reason: "CI pending",
      },
    });
    epic.status = "paused";
    epic.recovery = child.recovery;
    epic.slices[0]!.runId = child.id;
    await f.store.saveRun(child);
    await f.epics.saveEpic(epic);
    await f.worker.tick();
    expect(f.deps.resumeSliceRun).toHaveBeenCalledWith(child.id, true);
    expect(f.deps.executeSliceRun).toHaveBeenCalledTimes(1);
    expect((await f.epics.getEpic(epic.id))?.status).toBe("completed");
    expect(f.resumeRun).not.toHaveBeenCalled();
  });

  it.each(["cancelled", "completed"] as const)(
    "never automatically resumes a %s standalone run",
    async (status) => {
      const f = await setup();
      await f.store.saveRun(
        record({
          status,
          resumable: true,
          recovery: { stage: "release", attempt: 1, nextAttemptAt: 0 },
        }),
      );
      await f.worker.tick();
      expect(f.resumeRun).not.toHaveBeenCalled();
    },
  );

  it("does not retry a terminal verification failure or an unmarked failed run", async () => {
    const f = await setup();
    await f.store.saveRun(
      record({
        status: "failed",
        resumable: false,
        recovery: { stage: "delivery", attempt: 1, nextAttemptAt: 0 },
      }),
    );
    await f.store.saveRun(record({ status: "failed", resumable: true }));
    await f.worker.tick();
    expect(f.resumeRun).not.toHaveBeenCalled();
  });

  it("honors a cancelled child even when its parent has restart intent", async () => {
    const f = await setup();
    const epic = await f.epics.createEpic("do not override stop", {}, f.deps);
    const child = record({ status: "cancelled", resumable: true, release: null });
    epic.slices[0]!.runId = child.id;
    await f.store.saveRun(child);
    await f.epics.saveEpic(epic);
    await f.epics.recoverOrphanedEpics();
    await f.worker.tick();
    const saved = await f.epics.getEpic(epic.id);
    expect(saved?.status).toBe("paused");
    expect(saved?.recovery).toBeUndefined();
    expect(saved?.statusReason).toContain("cancelled");
    expect(f.deps.resumeSliceRun).not.toHaveBeenCalled();
    expect(f.deps.executeSliceRun).not.toHaveBeenCalled();
  });

  it("cancels a parked retry without redacting or discarding its saved execution data", async () => {
    const f = await setup();
    const run = record({
      status: "failed",
      resumable: true,
      idea: "original private input",
      recovery: { stage: "release", attempt: 1, nextAttemptAt: 0 },
    });
    await f.store.saveRun(run);
    expect(await f.recovery.cancelOperationalRetry(run.id)).toBe(true);
    await f.worker.tick();
    const saved = await f.store.getRunForExecution(run.id);
    expect(saved?.status).toBe("cancelled");
    expect(saved?.resumable).toBe(true);
    expect(saved?.idea).toBe("original private input");
    expect(saved?.recovery).toBeUndefined();
    expect(f.resumeRun).not.toHaveBeenCalled();
  });

  it("persists retry backoff when a resume setup fails and does not hammer the service", async () => {
    const f = await setup();
    const run = record({
      status: "failed",
      resumable: true,
      recovery: { stage: "delivery", attempt: 3, nextAttemptAt: 0 },
    });
    await f.store.saveRun(run);
    f.resumeRun.mockRejectedValue(new Error("credentials temporarily unavailable"));
    await f.worker.tick();
    await f.worker.tick();
    expect(f.resumeRun).toHaveBeenCalledTimes(1);
    expect(f.onError).toHaveBeenCalledTimes(1);
    vi.resetModules();
    const diskStore = await import("../storage/runsStore.js");
    const saved = await diskStore.getRunForExecution(run.id);
    expect(saved?.recovery?.attempt).toBe(4);
    expect(saved?.recovery?.nextAttemptAt).toBeGreaterThan(Date.now() + 60_000);
    expect(saved?.resumable).toBe(true);
  });

  it("claims a run once even when timer ticks overlap", async () => {
    const f = await setup();
    const run = record({
      status: "failed",
      resumable: true,
      recovery: { stage: "release", attempt: 1, nextAttemptAt: 0 },
    });
    await f.store.saveRun(run);
    let finish!: (run: RunRecord) => void;
    f.resumeRun.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = f.worker.tick();
    await vi.waitFor(() => expect(f.resumeRun).toHaveBeenCalledTimes(1));
    await f.worker.tick();
    expect(f.resumeRun).toHaveBeenCalledTimes(1);
    finish(record({ id: run.id }));
    await first;
  });

  it("respects shutdown before a retry begins", async () => {
    const f = await setup();
    await f.store.saveRun(
      record({
        status: "failed",
        resumable: true,
        recovery: { stage: "release", attempt: 1, nextAttemptAt: 0 },
      }),
    );
    f.worker.stop();
    await f.worker.tick();
    expect(f.resumeRun).not.toHaveBeenCalled();
  });

  it("claims planning as well as execution and rejects a duplicate epic driver", async () => {
    const f = await setup();
    const shell = await f.epics.createEpicShell("only one plan", {});
    let finish!: (plan: Awaited<ReturnType<typeof f.deps.plan>>) => void;
    const plan = await f.deps.plan();
    f.deps.plan.mockClear();
    f.deps.plan.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = f.epics.runEpic(shell, f.deps);
    await vi.waitFor(() => expect(f.deps.plan).toHaveBeenCalledTimes(1));
    await expect(f.epics.runEpic(shell, f.deps)).rejects.toThrow("already executing");
    await f.worker.tick();
    finish(plan);
    await first;
    const calls = f.deps.executeSliceRun.mock.calls.length;
    await f.epics.runEpic(shell, f.deps);
    expect(f.deps.executeSliceRun).toHaveBeenCalledTimes(calls);
  });
});

describe("crash-safe epic persistence", () => {
  it("keeps complete snapshots ordered during concurrent saves", async () => {
    const f = await setup();
    const epic = await f.epics.createEpicShell("durable", {});
    epic.summary = "first";
    const first = f.epics.saveEpic(epic);
    epic.summary = "second";
    const second = f.epics.saveEpic(epic);
    await Promise.all([first, second]);
    expect((await f.epics.getEpic(epic.id))?.summary).toBe("second");
    expect(
      (await readdir(join(dataDir, "epics"))).filter((p) => p.endsWith(".tmp")),
    ).toEqual([]);
  });

  it("a failed atomic publish preserves the previous saved epic and cleans its temporary file", async () => {
    const f = await setup();
    const epic = await f.epics.createEpicShell("previous complete state", {});
    const target = join(dataDir, "epics", `${epic.id}.json`);
    const before = await readFile(target, "utf8");
    vi.doMock("node:fs/promises", async () => {
      const fs =
        await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      return {
        ...fs,
        rename: async (from: string, to: string) => {
          if (to === target) throw new Error("injected interrupted publish");
          return fs.rename(from, to);
        },
      };
    });
    vi.resetModules();
    const restarted = await import("../orchestrator/epicRunner.js");
    epic.summary = "must not partially overwrite";
    await expect(restarted.saveEpic(epic)).rejects.toThrow("interrupted publish");
    expect(await readFile(target, "utf8")).toBe(before);
    expect(
      (await readdir(join(dataDir, "epics"))).filter((p) => p.endsWith(".tmp")),
    ).toEqual([]);
  });

  it("reports corrupt records explicitly instead of hiding jobs", async () => {
    const f = await setup();
    const epic = await f.epics.createEpicShell("preserved", {});
    await writeFile(join(dataDir, "epics", `${epic.id}.json`), '{"partial":');
    await expect(f.epics.getEpic(epic.id)).rejects.toThrow("unreadable");
    await expect(f.epics.listEpics()).rejects.toThrow(epic.id);
  });

  it("rejects path traversal and filename/record identity mismatches", async () => {
    const f = await setup();
    const epic = await f.epics.createEpicShell("contained", {});
    await expect(f.epics.saveEpic({ ...epic, id: "../escape" })).rejects.toThrow(
      "invalid epic id",
    );
    expect(await f.epics.getEpic("../escape")).toBeNull();
    await writeFile(
      join(dataDir, "epics", `${epic.id}.json`),
      JSON.stringify({ ...epic, id: randomUUID() }),
    );
    await expect(f.epics.getEpic(epic.id)).rejects.toThrow("identity");
  });
});
