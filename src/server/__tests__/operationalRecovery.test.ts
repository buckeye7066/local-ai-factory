import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
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
  it("rebuilds retry intent after a transient execution exception clears its reservation", async () => {
    const f = await setup();
    const run = record({
      status: "failed",
      resumable: true,
      recovery: { stage: "release", attempt: 2, nextAttemptAt: 0 },
    });
    await f.store.saveRun(run);
    f.resumeRun.mockImplementation(async () => {
      run.recovery = undefined;
      await f.store.saveRun(run);
      throw new Error("temporary audit persistence failure");
    });
    await f.worker.tick();
    expect((await f.store.getRunForExecution(run.id))?.recovery).toMatchObject({
      stage: "release",
      attempt: 3,
    });
    await f.worker.tick();
    expect(f.resumeRun).toHaveBeenCalledTimes(1);
  });

  it("reports a corrupt epic while still recovering a healthy standalone run", async () => {
    const f = await setup();
    const bad = await f.epics.createEpicShell("preserved corrupt record", {});
    const target = join(dataDir, "epics", `${bad.id}.json`);
    await writeFile(target, "corrupt bytes");
    const run = record({
      status: "failed",
      resumable: true,
      recovery: { stage: "release", attempt: 1, nextAttemptAt: 0 },
    });
    await f.store.saveRun(run);
    await f.worker.tick();
    expect(f.resumeRun).toHaveBeenCalledWith(run.id);
    expect(f.onError).toHaveBeenCalled();
    expect(await readFile(target, "utf8")).toBe("corrupt bytes");
  });

  it("never schedules automatic deployment retries without a supported target", async () => {
    const { deploymentOperationalRetry } =
      await import("../orchestrator/operationalRetry.js");
    expect(deploymentOperationalRetry({ target: null })).toBeUndefined();
    expect(deploymentOperationalRetry({ target: "railway" }, undefined, 1000)).toEqual({
      stage: "deployment",
      attempt: 1,
      nextAttemptAt: 31_000,
    });
  });
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

describe("real backend startup recovery", () => {
  it("automatically advances saved released children when the actual server boots", async () => {
    const f = await setup();
    const epic = await f.epics.createEpic("recover without provider calls", {}, f.deps);
    for (const slice of epic.slices) {
      const child = record();
      slice.runId = child.id;
      await f.store.saveRun(child);
    }
    await f.epics.saveEpic(epic);
    const bad = await f.epics.createEpicShell(
      "unreadable sibling must not stop startup",
      {},
    );
    const badPath = join(dataDir, "epics", `${bad.id}.json`);
    await writeFile(badPath, "corrupt sibling");
    // PORT=0 reserves an isolated ephemeral listener. No installed app is touched.
    const child = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
      cwd: process.cwd(),
      windowsHide: true,
      env: {
        ...process.env,
        PORT: "0",
        FACTORY_DATA_DIR: dataDir,
        FACTORY_BIND_LAN: "0",
        ANTHROPIC_API_KEY: "",
        OPENAI_API_KEY: "",
        WORKSPACE_ROOT: join(dataDir, "workspaces"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (data) => {
      output = (output + String(data)).slice(-8000);
    });
    child.stderr.on("data", (data) => {
      output = (output + String(data)).slice(-8000);
    });
    child.on("error", (err) => {
      output += String(err);
    });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    try {
      await vi.waitFor(
        async () => {
          expect(child.exitCode, output).toBeNull();
          expect((await f.epics.getEpic(epic.id))?.status, output).toBe("completed");
        },
        { timeout: 20_000, interval: 100 },
      );
      expect(output).toContain("queued 1 interrupted epic(s) for automatic recovery");
      expect(output).toContain(bad.id);
      expect(await readFile(badPath, "utf8")).toBe("corrupt sibling");
      expect((await f.epics.getEpic(epic.id))?.slices.map((s) => s.runId)).toEqual(
        epic.slices.map((s) => s.runId),
      );
    } finally {
      child.kill();
      await closed;
    }
  }, 30_000);
});

describe("automatic recovery terminal holds", () => {
  it("does not reinterpret a manually resumable child hold as automatic retry intent", async () => {
    const f = await setup();
    const epic = await f.epics.createEpic("preserve manual hold", {}, f.deps);
    const child = record({
      status: "failed",
      resumable: true,
      recovery: undefined,
      release: null,
    });
    epic.slices[0]!.runId = child.id;
    await f.store.saveRun(child);
    await f.epics.saveEpic(epic);
    await f.epics.recoverOrphanedEpics();
    await f.worker.tick();
    expect((await f.epics.getEpic(epic.id))?.recovery).toBeUndefined();
    expect(f.deps.resumeSliceRun).not.toHaveBeenCalled();
    expect(f.deps.executeSliceRun).not.toHaveBeenCalled();
  });
  it("does not repeatedly resume a terminally failed child after its parent restarts", async () => {
    const f = await setup();
    const epic = await f.epics.createEpic("preserve terminal evidence", {}, f.deps);
    const child = record({ status: "failed", resumable: false, release: null });
    epic.slices[0]!.runId = child.id;
    await f.store.saveRun(child);
    await f.epics.saveEpic(epic);
    await f.epics.recoverOrphanedEpics();
    await f.worker.tick();
    const saved = await f.epics.getEpic(epic.id);
    expect(saved?.status).toBe("paused");
    expect(saved?.statusReason).toContain("terminal hold");
    expect(saved?.recovery).toBeUndefined();
    expect(f.deps.resumeSliceRun).not.toHaveBeenCalled();
    expect(f.deps.executeSliceRun).not.toHaveBeenCalled();
  });
});

describe("ordered run persistence", () => {
  it("serializes captured run snapshots so an older publish cannot overwrite a newer state", async () => {
    const f = await setup();
    const run = record({ status: "failed", resumable: true });
    await f.store.saveRun(run);
    const target = join(dataDir, "runs", `${run.id}.json`);
    let releaseFirst!: () => void;
    let entered = 0;
    vi.doMock("node:fs/promises", async () => {
      const fs =
        await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      return {
        ...fs,
        rename: async (from: string, to: string) => {
          if (to === target && ++entered === 1)
            await new Promise<void>((resolve) => {
              releaseFirst = resolve;
            });
          return fs.rename(from, to);
        },
      };
    });
    vi.resetModules();
    const store = await import("../storage/runsStore.js");
    const first = store.saveRun({ ...run, status: "failed" });
    await vi.waitFor(() => expect(entered).toBe(1));
    const second = store.saveRun({ ...run, status: "completed", resumable: false });
    releaseFirst();
    await Promise.all([first, second]);
    expect(JSON.parse(await readFile(target, "utf8")).status).toBe("completed");
    expect(entered).toBe(2);
  });

  it("waits for durable normalization before returning a restart ticket", async () => {
    const f = await setup();
    const run = record({ status: "running", resumable: false });
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
    const target = join(dataDir, "runs", `${run.id}.json`);
    let entered = false;
    let release!: () => void;
    vi.doMock("node:fs/promises", async () => {
      const fs =
        await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      return {
        ...fs,
        rename: async (from: string, to: string) => {
          if (to === target) {
            entered = true;
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }
          return fs.rename(from, to);
        },
      };
    });
    vi.resetModules();
    const store = await import("../storage/runsStore.js");
    let returned = false;
    const reading = store.getRunForExecution(run.id).then((value) => {
      returned = true;
      return value;
    });
    await vi.waitFor(() => expect(entered).toBe(true));
    expect(returned).toBe(false);
    release();
    const saved = await reading;
    expect(saved?.recovery?.stage).toBe("restart");
    expect(JSON.parse(await readFile(target, "utf8")).recovery.stage).toBe("restart");
  });
});

describe("crash-safe epic persistence", () => {
  it("does not overwrite a corrupt record with a stale caller snapshot", async () => {
    const f = await setup();
    const epic = await f.epics.createEpicShell("preserve storage evidence", {});
    const target = join(dataDir, "epics", `${epic.id}.json`);
    await writeFile(target, "corrupt original bytes");
    await expect(f.epics.runEpic(epic, f.deps)).rejects.toThrow("unreadable");
    expect(await readFile(target, "utf8")).toBe("corrupt original bytes");
    expect(f.deps.plan).not.toHaveBeenCalled();
  });

  it("does not recreate a deleted epic from a stale timer or API snapshot", async () => {
    const f = await setup();
    const epic = await f.epics.createEpicShell("do not resurrect", {});
    await rm(join(dataDir, "epics", `${epic.id}.json`));
    await expect(f.epics.runEpic(epic, f.deps)).rejects.toThrow("refusing to recreate");
    expect(await f.epics.getEpic(epic.id)).toBeNull();
    expect(f.deps.plan).not.toHaveBeenCalled();
  });
  it("retries a transient replacement lock without deleting the last valid record", async () => {
    const f = await setup();
    const epic = await f.epics.createEpicShell("last valid state", {});
    const target = join(dataDir, "epics", `${epic.id}.json`);
    const before = await readFile(target, "utf8");
    let attempts = 0;
    vi.doMock("node:fs/promises", async () => {
      const fs =
        await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      return {
        ...fs,
        rename: async (from: string, to: string) => {
          if (to === target && ++attempts <= 2) {
            expect(await fs.readFile(target, "utf8")).toBe(before);
            throw Object.assign(new Error("transient reader lock"), { code: "EPERM" });
          }
          return fs.rename(from, to);
        },
      };
    });
    vi.resetModules();
    const restarted = await import("../orchestrator/epicRunner.js");
    epic.summary = "complete new state";
    await restarted.saveEpic(epic);
    expect(attempts).toBeGreaterThanOrEqual(3);
    expect((await restarted.getEpic(epic.id))?.summary).toBe("complete new state");
    expect(
      (await readdir(join(dataDir, "epics"))).filter((p) => p.endsWith(".tmp")),
    ).toEqual([]);
  });

  it("caps durable retry delays while continuing to preserve retry intent", async () => {
    const { nextOperationalRetry } =
      await import("../orchestrator/operationalRetry.js");
    let ticket = nextOperationalRetry("release", undefined, 1000);
    expect(ticket.nextAttemptAt).toBe(31_000);
    for (let n = 0; n < 40; n++) ticket = nextOperationalRetry("release", ticket, 1000);
    expect(ticket.attempt).toBe(30);
    expect(ticket.nextAttemptAt).toBe(1000 + 15 * 60_000);
  });
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
