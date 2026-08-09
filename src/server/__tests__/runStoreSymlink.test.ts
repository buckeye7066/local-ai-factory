import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import { rm, mkdir, writeFile, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { freshStages } from "../../shared/schemas.js";
import type { RunRecord } from "../../shared/schemas.js";

/**
 * Round-9 #4 — run-id containment was LEXICAL only. If `.factory/runs` is a
 * symlink/junction to another location, writeFile/readFile FOLLOW it and
 * persistence escapes the data root. The store now refuses a store dir whose
 * REAL path resolves outside the real data root (and refuses symlinked dirs).
 */

const DATA_DIR = ".test-factory-symlink";
process.env.FACTORY_DATA_DIR = DATA_DIR;

const dataPath = resolve(process.cwd(), DATA_DIR);
const outsidePath = resolve(process.cwd(), ".test-factory-symlink-OUTSIDE");

let linkCreated = false;

beforeAll(async () => {
  await mkdir(outsidePath, { recursive: true });
  await mkdir(dataPath, { recursive: true });
  const runsLink = join(dataPath, "runs");
  try {
    // Junction on Windows (no admin needed); dir symlink elsewhere.
    await symlink(
      outsidePath,
      runsLink,
      process.platform === "win32" ? "junction" : "dir",
    );
    linkCreated = true;
  } catch {
    linkCreated = false; // environment forbids link creation — test self-skips
  }
});

afterAll(async () => {
  delete process.env.FACTORY_DATA_DIR;
  await rm(dataPath, { recursive: true, force: true });
  await rm(outsidePath, { recursive: true, force: true });
});

function makeRun(id: string): RunRecord {
  return {
    id,
    idea: "x",
    status: "completed",
    demo: true,
    codeProvider: "stub",
    reviewProvider: "stub",
    currentStage: null,
    stages: freshStages(),
    logs: [],
    files: [],
    repairLoops: 0,
    providerUsage: {
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

describe("Round-9 #4 symlinked store dir is refused (not followed)", () => {
  it("refuses save + list when .factory/runs escapes the data root, and writes nothing outside", async () => {
    if (!linkCreated) {
      // Honest skip: this environment does not permit creating the link.
      expect(linkCreated).toBe(false);
      return;
    }
    const store = await freshStore();
    const run = makeRun(crypto.randomUUID());

    await expect(store.saveRun(run)).rejects.toThrow(/symlink|outside|data root/i);
    // The write did NOT land in the symlink target.
    expect(existsSync(join(outsidePath, `${run.id}.json`))).toBe(false);

    // Even a planted file behind the symlink must not be read through it.
    await writeFile(
      join(outsidePath, `${crypto.randomUUID()}.json`),
      JSON.stringify(makeRun(crypto.randomUUID())),
      "utf8",
    );
    await expect(store.listRuns()).rejects.toThrow(/symlink|outside|data root/i);
  });
});
