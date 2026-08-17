import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  saveRun,
  getRun,
  listRuns,
  deleteRun,
  saveRunFiles,
  getRunFiles,
  saveRunCheckpoint,
  getRunCheckpoint,
} from "../storage/runsStore.js";
import { rollbackWorkspace } from "../workspace/cleanup.js";
import { planDestination } from "../orchestrator/deliverRun.js";
import { isProtectedBranch, compareUrlFor } from "../workspace/gitOps.js";
import { repoNameProblem, freshStages } from "../../shared/schemas.js";
import type { RunRecord } from "../../shared/schemas.js";

/**
 * Owner requests, 2026-08-13:
 *  1. "give me a way to delete old runs too in factory deck"
 *  2. "whichever git repo I add prior to the prompt is the one that the work
 *      should be saved in"
 *  3. "If it is a new app altogether, it should ask me what to name the
 *      app/repo, then create it"
 */

function makeRun(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: randomUUID(),
    idea: "Build a chore tracker",
    status: "completed",
    resumable: false,
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
    appName: "Chore Tracker",
    workspacePath: null,
    destination: null,
    error: null,
    attribution: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...over,
  };
}

describe("deleteRun — the run record, its files and its checkpoint all go", () => {
  it("removes every persisted trace of one run", async () => {
    const run = makeRun();
    await saveRun(run);
    saveRunFiles(run.id, [
      {
        path: "src/App.tsx",
        purpose: "ui",
        language: "tsx",
        size: 10,
        status: "generated",
        contents: "x",
      },
    ]);
    await saveRunCheckpoint({
      schemaVersion: 1,
      runId: run.id,
      idea: "i",
      options: {},
      files: [],
      writeRefusals: [],
      blockingWriteRefusals: [],
      testWriterComplete: false,
      commandOutput: "",
      testsExecuted: false,
      testExit: null,
      repairLoops: 0,
      repairComplete: false,
      updatedAt: Date.now(),
    });

    expect(await getRun(run.id)).not.toBeNull();
    expect(await getRunCheckpoint(run.id)).not.toBeNull();

    expect(await deleteRun(run.id)).toBe(true);

    expect(await getRun(run.id)).toBeNull();
    expect(await getRunFiles(run.id)).toEqual([]);
    expect(await getRunCheckpoint(run.id)).toBeNull();
    expect((await listRuns()).some((r) => r.id === run.id)).toBe(false);
  });

  it("leaves OTHER runs untouched", async () => {
    const keep = makeRun();
    const doomed = makeRun();
    await saveRun(keep);
    await saveRun(doomed);
    await deleteRun(doomed.id);
    expect(await getRun(keep.id)).not.toBeNull();
    expect(await getRun(doomed.id)).toBeNull();
  });

  it("refuses an id that is not a UUID (no path escape)", async () => {
    expect(await deleteRun("../../etc/passwd")).toBe(false);
    expect(await deleteRun("not-a-uuid")).toBe(false);
  });

  it("reports false for a run that was never stored", async () => {
    expect(await deleteRun(randomUUID())).toBe(false);
  });
});

describe("workspace removal stays jailed under WORKSPACE_ROOT", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "factory-del-ws-"));
  });

  it("deletes a workspace that lives under the root", async () => {
    const ws = join(root, "chore-tracker-1234abcd");
    await mkdir(join(ws, "src"), { recursive: true });
    await writeFile(join(ws, "src", "App.tsx"), "x");

    const res = await rollbackWorkspace(root, ws);

    expect(res.ok).toBe(true);
    await expect(stat(ws)).rejects.toThrow();
  });

  it("REFUSES a path outside the root — an inPlace run's real repo survives", async () => {
    const outside = await mkdtemp(join(tmpdir(), "factory-real-repo-"));
    await writeFile(join(outside, "keep.txt"), "owner's actual code");

    const res = await rollbackWorkspace(root, outside);

    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/escapes WORKSPACE_ROOT/);
    // Still there — deleting a run record must never delete the owner's repo.
    expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe(
      "owner's actual code",
    );
    await rm(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it("refuses the workspace ROOT itself", async () => {
    const res = await rollbackWorkspace(root, root);
    expect(res.ok).toBe(false);
    expect(await stat(root)).toBeTruthy();
  });
});

describe("planDestination — the attached repo IS the destination", () => {
  it("extend mode targets the attached repo on the run's own branch", () => {
    const dest = planDestination({
      mode: "extend",
      options: { mode: "extend" },
      originUrl: "https://github.com/buckeye7066/incognito",
      branch: "factory-deck/4ca83862",
    });
    expect(dest.kind).toBe("existing-repo");
    expect(dest.target).toBe("https://github.com/buckeye7066/incognito");
    expect(dest.branch).toBe("factory-deck/4ca83862");
    expect(dest.status).toBe("planned");
  });

  it("extend mode with a non-git source says so instead of pretending", () => {
    const dest = planDestination({
      mode: "extend",
      options: { mode: "extend" },
      originUrl: null,
      branch: null,
    });
    expect(dest.kind).toBe("workspace-only");
    expect(dest.detail).toMatch(/not a git repo/);
  });

  it("new mode targets owner/name and reports that it will be created", () => {
    const dest = planDestination({
      mode: "new",
      options: { newRepo: { name: "bible-habit-tracker" } },
      githubOwner: "buckeye7066",
    });
    expect(dest.kind).toBe("new-repo");
    expect(dest.target).toBe("buckeye7066/bible-habit-tracker");
    expect(dest.url).toBe("https://github.com/buckeye7066/bible-habit-tracker");
    expect(dest.detail).toMatch(/private GitHub repo will be created/);
  });

  it("new mode with createRemote:false stays local and says so", () => {
    const dest = planDestination({
      mode: "new",
      options: { newRepo: { name: "local-only", createRemote: false } },
      githubOwner: "buckeye7066",
    });
    expect(dest.kind).toBe("new-repo");
    expect(dest.url).toBeNull();
    expect(dest.detail).toMatch(/local git repo/i);
  });

  it("new mode with no name at all degrades to workspace-only, never invents one", () => {
    const dest = planDestination({ mode: "new", options: {} });
    expect(dest.kind).toBe("workspace-only");
    expect(dest.target).not.toMatch(/[a-z]+-[0-9a-f]{8}/); // no invented slug
  });
});

describe("push safety", () => {
  it("treats trunk branches as protected", () => {
    for (const b of ["main", "master", "MAIN", "develop", "release", "trunk"]) {
      expect(isProtectedBranch(b)).toBe(true);
    }
    expect(isProtectedBranch("factory-deck/4ca83862")).toBe(false);
  });

  it("builds a GitHub compare link for https and ssh remotes", () => {
    expect(
      compareUrlFor("https://github.com/buckeye7066/incognito.git", "factory-deck/ab"),
    ).toBe("https://github.com/buckeye7066/incognito/compare/factory-deck%2Fab?expand=1");
    expect(compareUrlFor("git@github.com:buckeye7066/iplay.git", "factory-deck/cd")).toBe(
      "https://github.com/buckeye7066/iplay/compare/factory-deck%2Fcd?expand=1",
    );
  });

  it("returns null for a non-GitHub remote instead of guessing a URL", () => {
    expect(compareUrlFor("C:\\Users\\firer\\Iplay", "factory-deck/ab")).toBeNull();
    expect(compareUrlFor("https://gitlab.com/x/y.git", "factory-deck/ab")).toBeNull();
  });
});

describe("repo name validation", () => {
  it("accepts names GitHub accepts", () => {
    for (const n of ["bible-habit-tracker", "my_app", "app.v2", "A1"]) {
      expect(repoNameProblem(n)).toBeNull();
    }
  });

  it("rejects what GitHub would silently rewrite or refuse", () => {
    expect(repoNameProblem("")).toMatch(/required/);
    expect(repoNameProblem("my app")).toMatch(/only letters/);
    expect(repoNameProblem("my/app")).toMatch(/only letters/);
    expect(repoNameProblem("-leading")).toMatch(/cannot start/);
    expect(repoNameProblem(".hidden")).toMatch(/cannot start/);
    expect(repoNameProblem("..")).toMatch(/cannot start|cannot be/);
    expect(repoNameProblem("thing.git")).toMatch(/\.git/);
    expect(repoNameProblem("x".repeat(101))).toMatch(/100 characters/);
  });
});

describe("run summaries carry the destination to the UI", () => {
  it("serves destination in the list so a card can show it", async () => {
    const run = makeRun({
      destination: {
        kind: "existing-repo",
        target: "https://github.com/buckeye7066/iplay",
        branch: "factory-deck/bbd0349f",
        status: "delivered",
        detail: "Committed 12 file(s). Pushed factory-deck/bbd0349f.",
        url: null,
        deliveredAt: Date.now(),
      },
    });
    await saveRun(run);
    const summary = (await listRuns()).find((r) => r.id === run.id);
    expect(summary?.destination?.status).toBe("delivered");
    expect(summary?.destination?.target).toBe("https://github.com/buckeye7066/iplay");
    await deleteRun(run.id);
  });
});

describe("path containment sanity", () => {
  it("resolve() equality is what the live-workspace guard relies on", () => {
    expect(resolve("C:/a/b")).toBe(resolve("C:/a/./b"));
  });
});
