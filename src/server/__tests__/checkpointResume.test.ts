import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdir, rm, symlink } from "node:fs/promises";
import { resolve } from "node:path";
import { freshStages } from "../../shared/schemas.js";
import type { RunRecord } from "../../shared/schemas.js";

const DATA_DIR = ".test-factory-checkpoint-resume";
process.env.FACTORY_DATA_DIR = DATA_DIR;
const dataPath = resolve(process.cwd(), DATA_DIR);
const workspaceRoot = resolve(process.cwd(), ".test-checkpoint-workspaces");
const outsideRoot = resolve(process.cwd(), ".test-checkpoint-outside");

afterAll(async () => {
  delete process.env.FACTORY_DATA_DIR;
  await rm(dataPath, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
  await rm(outsideRoot, { recursive: true, force: true });
});

describe("durable checkpoint continuation", () => {
  it("continues after product spec without replaying that provider call", async () => {
    vi.resetModules();
    const store = await import("../storage/runsStore.js");
    const { resumeFactory } = await import("../orchestrator/runFactory.js");
    const { loadConfig, loadSecrets } = await import("../config.js");

    const id = crypto.randomUUID();
    const stages = freshStages();
    stages.find((stage) => stage.id === "intake")!.status = "completed";
    stages.find((stage) => stage.id === "product_spec")!.status = "completed";
    const run: RunRecord = {
      id,
      idea: "Build a checkpoint proof app",
      status: "failed",
      resumable: true,
      demo: true,
      codeProvider: "mock",
      reviewProvider: "mock",
      currentStage: null,
      stages,
      logs: [],
      files: [],
      repairLoops: 0,
      providerUsage: {
        free: { calls: 0 },
        anthropic: { calls: 0 },
        openai: { calls: 0 },
        stub: { calls: 0 },
        mock: { calls: 1 },
        totalCalls: 1,
      },
      finalReport: null,
      appName: "CheckpointProof",
      workspacePath: null,
      error: "simulated process interruption",
      attribution: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await store.saveRun(run);
    await store.saveRunCheckpoint({
      schemaVersion: 1,
      runId: id,
      idea: "Build a checkpoint proof app",
      options: { demo: true },
      spec: {
        appName: "CheckpointProof",
        tagline: "Resume safely",
        targetUser: "operators",
        coreFeatures: ["durable resume"],
        dataModel: [],
        userFlows: ["resume an interrupted run"],
        acceptanceCriteria: ["completed calls are not replayed"],
      },
      files: [],
      testWriterComplete: false,
      commandOutput: "",
      testsExecuted: false,
      testExit: null,
      repairLoops: 0,
      repairComplete: false,
      updatedAt: Date.now(),
    });

    const config = {
      ...loadConfig({}),
      workspaceRoot,
      dryRunCommands: true,
    };
    const secrets = loadSecrets({});
    const attempts = await Promise.allSettled([
      resumeFactory(id, config, secrets),
      resumeFactory(id, config, secrets),
    ]);
    const fulfilled = attempts.filter(
      (result): result is PromiseFulfilledResult<RunRecord> =>
        result.status === "fulfilled",
    );
    const rejected = attempts.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0].reason)).toMatch(/already being claimed|not resumable/i);

    const resumed = fulfilled[0].value;
    expect(resumed.status).toBe("completed");
    expect(resumed.resumable).toBe(false);
    expect(
      resumed.logs.filter((line) => line.message.includes("Product Spec agent")),
    ).toHaveLength(0);
    expect(resumed.logs.some((line) => /resumed from/i.test(line.message))).toBe(true);
    expect(await store.getRunCheckpoint(id)).toBeNull();
  });

  it("keeps a checkpoint resumable when its workspace is outside the current root", async () => {
    vi.resetModules();
    const store = await import("../storage/runsStore.js");
    const { resumeFactory } = await import("../orchestrator/runFactory.js");
    const { loadConfig, loadSecrets } = await import("../config.js");

    const id = crypto.randomUUID();
    const run: RunRecord = {
      id,
      idea: "Workspace root proof",
      status: "failed",
      resumable: true,
      demo: true,
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
      workspacePath: resolve(process.cwd(), ".old-factory-root", id),
      error: "interrupted",
      attribution: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await store.saveRun(run);
    await store.saveRunCheckpoint({
      schemaVersion: 1,
      runId: id,
      idea: run.idea,
      options: { demo: true },
      files: [],
      testWriterComplete: false,
      commandOutput: "",
      testsExecuted: false,
      testExit: null,
      repairLoops: 0,
      repairComplete: false,
      updatedAt: Date.now(),
    });

    const config = { ...loadConfig({}), workspaceRoot };
    await expect(resumeFactory(id, config, loadSecrets({}))).rejects.toThrow(
      /WORKSPACE_ROOT/i,
    );

    run.workspacePath = workspaceRoot;
    await store.saveRun(run);
    await expect(resumeFactory(id, config, loadSecrets({}))).rejects.toThrow(
      /strict child/i,
    );

    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    const linkedWorkspace = resolve(workspaceRoot, `linked-${id}`);
    await symlink(
      outsideRoot,
      linkedWorkspace,
      process.platform === "win32" ? "junction" : "dir",
    );
    run.workspacePath = linkedWorkspace;
    await store.saveRun(run);
    await expect(resumeFactory(id, config, loadSecrets({}))).rejects.toThrow(
      /symlink|resolves outside/i,
    );

    const preserved = await store.getRunForExecution(id);
    expect(preserved?.status).toBe("failed");
    expect(preserved?.resumable).toBe(true);
    expect(await store.getRunCheckpoint(id)).not.toBeNull();
  });

  it("does not promise resume after restart when no checkpoint exists", async () => {
    vi.resetModules();
    let store = await import("../storage/runsStore.js");
    const id = crypto.randomUUID();
    const run: RunRecord = {
      id,
      idea: "No checkpoint proof",
      status: "running",
      resumable: false,
      demo: true,
      codeProvider: "mock",
      reviewProvider: "mock",
      currentStage: "intake",
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
      error: null,
      attribution: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await store.saveRun(run);

    vi.resetModules();
    store = await import("../storage/runsStore.js");
    const normalized = await store.getRunForExecution(id);
    expect(normalized?.status).toBe("failed");
    expect(normalized?.resumable).toBe(false);
    expect(normalized?.error).toMatch(/no durable checkpoint/i);
    expect(normalized?.error).not.toMatch(/Resume continues/i);
  });
});
