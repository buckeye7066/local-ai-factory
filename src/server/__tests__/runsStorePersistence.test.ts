import { describe, it, expect, afterAll, vi } from "vitest";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { freshStages } from "../../shared/schemas.js";
import type { RunRecord, FileContent } from "../../shared/schemas.js";

/**
 * These tests point the store at an isolated data dir (FACTORY_DATA_DIR) and
 * simulate a backend restart with vi.resetModules(), which drops the store's
 * in-memory maps and forces the disk path.
 */
const DATA_DIR = ".test-factory-store";
process.env.FACTORY_DATA_DIR = DATA_DIR;

const dataPath = resolve(process.cwd(), DATA_DIR);

afterAll(async () => {
  delete process.env.FACTORY_DATA_DIR;
  await rm(dataPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: crypto.randomUUID(),
    idea: "test idea",
    status: "completed",
    demo: true,
    routingMode: "free",
    codeProvider: "stub",
    reviewProvider: "stub",
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
    error: null,
    attribution: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as RunRecord;
}

async function freshStore() {
  vi.resetModules();
  return import("../storage/runsStore.js");
}

describe("runsStore persistence across restarts", () => {
  it("marks a run that was 'running' on disk as failed after a restart", async () => {
    const store1 = await freshStore();
    const run = makeRun({ status: "running" });
    run.stages[0].status = "active";
    await store1.saveRun(run);

    // Simulate a restart: new module instance, empty memory.
    const store2 = await freshStore();
    const loaded = await store2.getRun(run.id);

    expect(loaded).not.toBeNull();
    expect(loaded!.status).toBe("failed");
    expect(loaded!.error).toMatch(/interrupted/i);
    expect(loaded!.stages.every((s) => s.status !== "active")).toBe(true);
  });

  it("serves generated file contents from disk after a restart", async () => {
    const store1 = await freshStore();
    const run = makeRun();
    await store1.saveRun(run);
    const files: FileContent[] = [
      {
        path: "src/App.tsx",
        language: "tsx",
        size: 42,
        status: "generated",
        purpose: "root component",
        contents: "export const App = () => null;",
      },
    ];
    store1.saveRunFiles(run.id, files);

    // The disk write is fire-and-forget; wait until a fresh store can see it.
    await vi.waitFor(
      async () => {
        const store2 = await freshStore();
        const loaded = await store2.getRunFiles(run.id);
        expect(loaded).toHaveLength(1);
        expect(loaded[0].contents).toBe("export const App = () => null;");
      },
      { timeout: 5000 },
    );
  });

  it("includes the persisted economic tier in run summaries", async () => {
    const store1 = await freshStore();
    const run = makeRun({
      routingMode: "paid",
      codeProvider: "openai",
      reviewProvider: "openai",
    });
    await store1.saveRun(run);

    const store2 = await freshStore();
    const summary = (await store2.listRuns()).find((item) => item.id === run.id);
    expect(summary).toMatchObject({
      id: run.id,
      routingMode: "paid",
      codeProvider: "openai",
      reviewProvider: "openai",
    });
  });
});
