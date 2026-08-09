import { describe, it, expect, afterAll, vi } from "vitest";
import { rm, mkdir, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { freshStages } from "../../shared/schemas.js";
import type { RunRecord } from "../../shared/schemas.js";

/**
 * Round-11 #7 — the store-dir guard must not permanently latch a failure: a
 * TRANSIENT junction/symlink should refuse writes WHILE present, but once the
 * unsafe condition is gone the next call must revalidate and succeed (no wedge
 * until restart).
 */

const DATA_DIR = ".test-factory-guardrecover";
process.env.FACTORY_DATA_DIR = DATA_DIR;
const dataPath = resolve(process.cwd(), DATA_DIR);
const outsidePath = resolve(process.cwd(), ".test-factory-guardrecover-OUTSIDE");

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

describe("Round-11 #7 guard failure is not permanently latched", () => {
  it("refuses while a junction is present, then RECOVERS once it is removed", async () => {
    await rm(dataPath, { recursive: true, force: true });
    await rm(outsidePath, { recursive: true, force: true });
    await mkdir(join(dataPath, "runs"), { recursive: true });
    await mkdir(join(dataPath, "files"), { recursive: true });
    await mkdir(outsidePath, { recursive: true });

    const store = await freshStore();

    // 1) Normal dirs — a write succeeds.
    await store.saveRun(makeRun(crypto.randomUUID()));

    // 2) Swap runs -> junction/symlink (transient unsafe condition).
    await rm(join(dataPath, "runs"), { recursive: true, force: true });
    let swapped = false;
    try {
      await symlink(
        outsidePath,
        join(dataPath, "runs"),
        process.platform === "win32" ? "junction" : "dir",
      );
      swapped = true;
    } catch {
      swapped = false;
    }
    if (!swapped) {
      expect(swapped).toBe(false); // honest skip if links are unavailable
      return;
    }

    // 3) While unsafe → refuse (fail closed).
    const during = makeRun(crypto.randomUUID());
    await expect(store.saveRun(during)).rejects.toThrow(/symlink|outside|data root/i);
    expect(existsSync(join(outsidePath, `${during.id}.json`))).toBe(false);

    // 4) Remove the junction, restore a real dir — the guard must REVALIDATE and
    //    let the NEXT write succeed (no permanent wedge).
    await rm(join(dataPath, "runs"), { recursive: true, force: true });
    await mkdir(join(dataPath, "runs"), { recursive: true });
    const after = makeRun(crypto.randomUUID());
    await store.saveRun(after); // must NOT throw
    expect(existsSync(join(dataPath, "runs", `${after.id}.json`))).toBe(true);
  });
});
