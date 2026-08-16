import { describe, it, expect, afterAll, vi } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { RunRecordSchema, isValidRunId, freshStages } from "../../shared/schemas.js";
import type { RunRecord } from "../../shared/schemas.js";

/**
 * Round-7 finding #4 — run persistence must contain the run id. A crafted/corrupt
 * `.factory/runs/*.json` whose `id` is a traversal string must NOT be loadable
 * or (via normalizeLoaded → saveRun) rewritten to a path outside the store.
 */

const DATA_DIR = ".test-factory-idguard";
process.env.FACTORY_DATA_DIR = DATA_DIR;

const dataPath = resolve(process.cwd(), DATA_DIR);
// Where "../../outside-idguard" would land if containment failed.
const escapeTarget = resolve(process.cwd(), "outside-idguard.json");

afterAll(async () => {
  delete process.env.FACTORY_DATA_DIR;
  await rm(dataPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await rm(escapeTarget, { force: true });
});

function makeRecord(id: string): RunRecord {
  return {
    id,
    idea: "seed",
    status: "running",
    demo: true,
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
  } as RunRecord;
}

async function freshStore() {
  vi.resetModules();
  return import("../storage/runsStore.js");
}

describe("Round-7 #4 run id containment", () => {
  it("isValidRunId accepts UUIDs and rejects traversal / plain names", () => {
    expect(isValidRunId(crypto.randomUUID())).toBe(true);
    expect(isValidRunId("../../outside-idguard")).toBe(false);
    expect(isValidRunId("seed")).toBe(false);
    expect(isValidRunId("../../../etc/passwd")).toBe(false);
    expect(isValidRunId("")).toBe(false);
  });

  it("RunRecordSchema rejects a record whose id is not a UUID", () => {
    expect(RunRecordSchema.safeParse(makeRecord("../../outside-idguard")).success).toBe(
      false,
    );
    expect(RunRecordSchema.safeParse(makeRecord(crypto.randomUUID())).success).toBe(
      true,
    );
  });

  it("saveRun refuses to write a record whose id is a traversal string", async () => {
    const store = await freshStore();
    await expect(store.saveRun(makeRecord("../../outside-idguard"))).rejects.toThrow();
    expect(existsSync(escapeTarget)).toBe(false);
  });

  it("listRuns skips a planted seed.json (traversal id) without rewriting it outside the store", async () => {
    const store = await freshStore();
    const runsDir = join(dataPath, "runs");
    await mkdir(runsDir, { recursive: true });
    // status 'running' would, pre-fix, make normalizeLoaded call saveRun() and
    // escape to <cwd>/outside-idguard.json via the id.
    await writeFile(
      join(runsDir, "seed.json"),
      JSON.stringify(makeRecord("../../outside-idguard")),
      "utf8",
    );

    const runs = await store.listRuns();

    expect(runs.find((r) => r.id === "../../outside-idguard")).toBeUndefined();
    expect(existsSync(escapeTarget)).toBe(false);
  });
});
