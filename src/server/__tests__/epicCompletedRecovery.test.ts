import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunRecord } from "../../shared/schemas.js";
import { freshStages } from "../../shared/schemas.js";
import { loadConfig, loadSecrets } from "../config.js";
import type { EpicDeps } from "../orchestrator/epicRunner.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "factory-epic-completed-"));
  vi.stubEnv("FACTORY_DATA_DIR", dataDir);
  vi.resetModules();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  await rm(dataDir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
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

async function savedEpic(overrides: Partial<RunRecord> = {}) {
  const { createEpic, saveEpic } = await import("../orchestrator/epicRunner.js");
  const { saveRun } = await import("../storage/runsStore.js");
  const config = loadConfig({});
  const secrets = loadSecrets({});
  const executeSliceRun = vi.fn(async (_idea: string) => record());
  const resumeSliceRun = vi.fn(async (runId: string) => {
    // Use the real production adapter, not a fake that accepts completed runs.
    const { resumeFactory } = await import("../orchestrator/runFactory.js");
    return resumeFactory(runId, config, secrets);
  });
  const deps: EpicDeps = {
    config,
    secrets,
    executeSliceRun,
    resumeSliceRun,
    plan: async () => ({
      summary: "Recover a two-slice evolution",
      slices: [1, 2].map((number) => ({
        title: `Slice ${number}`,
        goals: `Implement product slice ${number}`,
        wiringTargets: ["src/app.ts"],
        acceptance: [`slice ${number} behavior works`],
      })),
    }),
  };
  const epic = await createEpic("preserve paid work", { mode: "extend" }, deps);
  const child = record(overrides);
  epic.slices[0]!.runId = child.id;
  epic.slices[0]!.status = "running";
  await saveEpic(epic);
  await saveRun(child);

  // Discard module memory so the recovery must read the durable receipts.
  vi.resetModules();
  const restarted = await import("../orchestrator/epicRunner.js");
  await restarted.recoverOrphanedEpics();
  const restored = await restarted.getEpic(epic.id);
  expect(restored?.status).toBe("paused");
  const { getRunCheckpoint } = await import("../storage/runsStore.js");
  expect(await getRunCheckpoint(child.id)).toBeNull();
  return {
    restarted,
    restored: restored!,
    child,
    deps,
    executeSliceRun,
    resumeSliceRun,
  };
}

describe("reconcile completed children after a parent restart", () => {
  it("uses the saved released child and executes only the remaining slice", async () => {
    const fixture = await savedEpic();
    const done = await fixture.restarted.runEpic(fixture.restored, fixture.deps);

    expect(done.status).toBe("completed");
    expect(done.currentSlice).toBe(2);
    expect(done.slices[0]!.runId).toBe(fixture.child.id);
    expect(done.slices[0]!.mergedSha).toBe(fixture.child.release!.mergedSha);
    expect(fixture.resumeSliceRun).not.toHaveBeenCalled();
    expect(fixture.executeSliceRun).toHaveBeenCalledTimes(1);
    expect(fixture.executeSliceRun.mock.calls[0]?.[0]).toContain("Slice 2 of 2");
    const persisted = await fixture.restarted.getEpic(done.id);
    expect(persisted?.slices[0]?.runId).toBe(fixture.child.id);
    expect(persisted?.status).toBe("completed");
  });

  it("does not require a resume handler for an already released child", async () => {
    const fixture = await savedEpic();
    delete fixture.deps.resumeSliceRun;
    const done = await fixture.restarted.runEpic(fixture.restored, fixture.deps);

    expect(done.status).toBe("completed");
    expect(done.slices[0]!.runId).toBe(fixture.child.id);
    expect(fixture.executeSliceRun).toHaveBeenCalledTimes(1);
  });

  it.each(["held", "missing"] as const)(
    "does not advance when the completed child's release proof is %s",
    async (proof) => {
      const fixture = await savedEpic({
        release:
          proof === "missing"
            ? null
            : {
                released: false,
                prUrl: null,
                mergedSha: null,
                reason: "required CI has not passed",
              },
      });
      const paused = await fixture.restarted.runEpic(fixture.restored, fixture.deps);

      expect(paused.status).toBe("paused");
      expect(paused.currentSlice).toBe(0);
      expect(paused.slices[0]!.status).toBe("held");
      expect(paused.slices[0]!.runId).toBe(fixture.child.id);
      expect(paused.slices[1]!.status).toBe("pending");
      expect(paused.statusReason).toContain(
        proof === "missing" ? "no release" : "required CI has not passed",
      );
      expect(fixture.resumeSliceRun).not.toHaveBeenCalled();
      expect(fixture.executeSliceRun).not.toHaveBeenCalled();
    },
  );

  it("keeps a failed child when the real adapter finds no durable checkpoint", async () => {
    const fixture = await savedEpic({
      status: "failed",
      resumable: true,
      release: null,
    });
    const paused = await fixture.restarted.runEpic(fixture.restored, fixture.deps);

    expect(paused.status).toBe("paused");
    expect(paused.currentSlice).toBe(0);
    expect(paused.slices[0]!.runId).toBe(fixture.child.id);
    expect(paused.statusReason).toContain("no interrupted durable checkpoint");
    expect(fixture.resumeSliceRun).toHaveBeenCalledTimes(1);
    expect(fixture.resumeSliceRun).toHaveBeenCalledWith(fixture.child.id);
    expect(fixture.executeSliceRun).not.toHaveBeenCalled();
  });
});
