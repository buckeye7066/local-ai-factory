import { afterAll, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { freshStages } from "../../shared/schemas.js";
import type { RunRecord } from "../../shared/schemas.js";

const DATA_DIR = ".test-factory-checkpoint-resume";
process.env.FACTORY_DATA_DIR = DATA_DIR;
const dataPath = resolve(process.cwd(), DATA_DIR);
const workspaceRoot = resolve(process.cwd(), ".test-checkpoint-workspaces");

afterAll(async () => {
  delete process.env.FACTORY_DATA_DIR;
  await rm(dataPath, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
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
      repairComplete: false,
      updatedAt: Date.now(),
    });

    const config = {
      ...loadConfig({}),
      workspaceRoot,
      dryRunCommands: true,
    };
    const resumed = await resumeFactory(id, config, loadSecrets({}));

    expect(resumed.status).toBe("completed");
    expect(resumed.resumable).toBe(false);
    expect(
      resumed.logs.filter((line) => line.message.includes("Product Spec agent")),
    ).toHaveLength(0);
    expect(resumed.logs.some((line) => /resumed from/i.test(line.message))).toBe(true);
    expect(await store.getRunCheckpoint(id)).toBeNull();
  });
});
