import { describe, it, expect, afterAll, vi } from "vitest";
import { rm, mkdir, writeFile, symlink, utimes, lstat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { freshStages } from "../../shared/schemas.js";
import type { RunRecord } from "../../shared/schemas.js";

/**
 * Round-10 #2 + #3 — store-dir containment must survive a MUTABLE filesystem.
 *  #2 guardStoreDirs must NOT cache a successful result: pass once on normal
 *     dirs, then swap `.factory/runs` to a symlink/junction → the next write must
 *     re-check and refuse (no cached-success TOCTOU).
 *  #3 pruneOldRuns must resolve each entry through safeStorePath BEFORE stat, so
 *     a symlinked `<uuid>.json` is not followed for metadata during pruning.
 */

const TOCTOU_DIR = ".test-factory-toctou";
const PRUNE_DIR = ".test-factory-prune";
const toctouPath = resolve(process.cwd(), TOCTOU_DIR);
const prunePath = resolve(process.cwd(), PRUNE_DIR);
const outsidePath = resolve(process.cwd(), ".test-factory-toctou-OUTSIDE");
const pruneOutside = resolve(process.cwd(), ".test-factory-prune-OUTSIDE");

afterAll(async () => {
  delete process.env.FACTORY_DATA_DIR;
  for (const p of [toctouPath, prunePath, outsidePath, pruneOutside]) {
    await rm(p, { recursive: true, force: true });
  }
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

describe("Round-10 #2 guardStoreDirs re-checks every call (no cached-success TOCTOU)", () => {
  it("passes on normal dirs, then REFUSES the next write after runs is swapped to a symlink", async () => {
    await rm(toctouPath, { recursive: true, force: true });
    await rm(outsidePath, { recursive: true, force: true });
    await mkdir(join(toctouPath, "runs"), { recursive: true });
    await mkdir(join(toctouPath, "files"), { recursive: true });
    await mkdir(outsidePath, { recursive: true });

    process.env.FACTORY_DATA_DIR = TOCTOU_DIR;
    const store = await freshStore();

    // 1) Guard passes on normal dirs — the write lands inside the store.
    const run1 = makeRun(crypto.randomUUID());
    await store.saveRun(run1);
    expect(existsSync(join(toctouPath, "runs", `${run1.id}.json`))).toBe(true);

    // 2) Swap runs -> junction/symlink to an outside dir (the TOCTOU move).
    await rm(join(toctouPath, "runs"), { recursive: true, force: true });
    let swapped = false;
    try {
      await symlink(
        outsidePath,
        join(toctouPath, "runs"),
        process.platform === "win32" ? "junction" : "dir",
      );
      swapped = true;
    } catch {
      swapped = false;
    }
    if (!swapped) {
      expect(swapped).toBe(false); // environment forbids links — honest skip
      return;
    }

    // 3) The NEXT save must re-check and refuse (success was NOT cached).
    const run2 = makeRun(crypto.randomUUID());
    await expect(store.saveRun(run2)).rejects.toThrow(/symlink|outside|data root/i);
    expect(existsSync(join(outsidePath, `${run2.id}.json`))).toBe(false);
  });
});

describe("Round-10 #3 pruneOldRuns does not follow a symlinked <id>.json", () => {
  it("skips a symlinked run file and prunes only real files", async () => {
    await rm(prunePath, { recursive: true, force: true });
    await rm(pruneOutside, { recursive: true, force: true });
    const runsDir = join(prunePath, "runs");
    await mkdir(runsDir, { recursive: true });
    await mkdir(join(prunePath, "files"), { recursive: true });
    await mkdir(pruneOutside, { recursive: true });

    // Two real run files; A older (doomed with keep=1), B newer (kept).
    const idA = crypto.randomUUID();
    const idB = crypto.randomUUID();
    const fileA = join(runsDir, `${idA}.json`);
    const fileB = join(runsDir, `${idB}.json`);
    await writeFile(fileA, JSON.stringify(makeRun(idA)), "utf8");
    await writeFile(fileB, JSON.stringify(makeRun(idB)), "utf8");
    const old = new Date(Date.now() - 3_600_000);
    await utimes(fileA, old, old);

    // A symlinked <uuid>.json pointing OUTSIDE — must not be followed/pruned.
    const idLink = crypto.randomUUID();
    const linkPath = join(runsDir, `${idLink}.json`);
    const outsideTarget = join(pruneOutside, "secret.json");
    await writeFile(
      outsideTarget,
      JSON.stringify(makeRun(crypto.randomUUID())),
      "utf8",
    );
    let fileLinkCreated = false;
    try {
      await symlink(outsideTarget, linkPath, "file");
      fileLinkCreated = true;
    } catch {
      fileLinkCreated = false;
    }

    process.env.FACTORY_DATA_DIR = PRUNE_DIR;
    const store = await freshStore();
    const removed = await store.pruneOldRuns(1);

    // Real pruning happened: older removed, newer kept.
    expect(existsSync(fileA)).toBe(false);
    expect(existsSync(fileB)).toBe(true);

    if (fileLinkCreated) {
      // The symlink was skipped (still a symlink, not pruned) and its target
      // was never deleted through the link.
      const st = await lstat(linkPath).catch(() => null);
      expect(st?.isSymbolicLink()).toBe(true);
      expect(existsSync(outsideTarget)).toBe(true);
      expect(removed).toBe(1); // only the real older file, not the symlink
    }
  });
});
