import { describe, it, expect, afterAll } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { runFactory } from "../orchestrator/runFactory.js";
import { loadConfig, loadSecrets } from "../config.js";

const cleanupPaths: string[] = [];
afterAll(async () => {
  await Promise.all(
    cleanupPaths.map((p) =>
      rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
    ),
  );
});

async function makeExistingRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "factory-extend-src-"));
  cleanupPaths.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "homeschool-app", dependencies: { react: "^18.0.0" } }),
  );
  await writeFile(
    join(dir, "README.md"),
    "# homeschool-app\nAn existing K-12 platform.",
  );
  await writeFile(
    join(dir, "existing-marker.txt"),
    "this file predates the factory run",
  );
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

describe("extend mode (end-to-end, offline mock)", () => {
  it("ingests an existing repo into an isolated workspace, keeps its real name, and writes files alongside the pre-existing ones", async () => {
    const src = await makeExistingRepo();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "factory-extend-ws-"));
    cleanupPaths.push(workspaceRoot);

    const config = { ...loadConfig({}), workspaceRoot, allowUntrustedScripts: false };
    const run = await runFactory({
      idea: "Add a parent-visible progress dashboard",
      options: {
        demo: true,
        mode: "extend",
        repoSource: { type: "path", location: src },
        goals: ["Add a parent-visible progress dashboard"],
      },
      config,
      secrets: loadSecrets({}),
    });

    expect(run.status).toBe("completed");
    // Authoritative override: the real app name from package.json, not
    // whatever synthetic name the stub/model would have invented.
    expect(run.appName).toBe("homeschool-app");
    // Isolated by default — never the source path itself.
    expect(resolve(run.workspacePath ?? "")).not.toBe(resolve(src));
    expect(resolve(run.workspacePath ?? "")).not.toBe("");

    // The pre-existing file survived the ingestion (proves it's a real copy of
    // the repo, not a fresh empty workspace).
    const marker = await readFile(
      join(run.workspacePath!, "existing-marker.txt"),
      "utf8",
    );
    expect(marker).toContain("this file predates the factory run");

    // New files were actually written into the SAME ingested workspace.
    expect(run.files.length).toBeGreaterThan(0);
    expect(run.finalReport).not.toBeNull();
  }, 40_000);

  it("forces an explicit demo inPlace request into an isolated copy", async () => {
    const src = await makeExistingRepo();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "factory-extend-ws2-"));
    cleanupPaths.push(workspaceRoot);

    const config = { ...loadConfig({}), workspaceRoot, allowUntrustedScripts: false };
    const run = await runFactory({
      idea: "Add a parent-visible progress dashboard",
      options: {
        demo: true,
        mode: "extend",
        repoSource: { type: "path", location: src, inPlace: true },
        goals: ["Add a parent-visible progress dashboard"],
      },
      config,
      secrets: loadSecrets({}),
    });

    expect(run.status).toBe("completed");
    expect(resolve(run.workspacePath ?? "")).not.toBe(resolve(src));
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: src,
    })
      .toString()
      .trim();
    // Zero-credit mock output never creates or checks out a run branch in the
    // owner's repository, even when the request explicitly asks for inPlace.
    expect(branch).not.toMatch(/^factory-deck\//);
    const runBranches = execFileSync("git", ["branch", "--list", "factory-deck/*"], {
      cwd: src,
    })
      .toString()
      .trim();
    expect(runBranches).toBe("");
  }, 40_000);

  it("greenfield 'new' mode is unaffected — same behavior as before extend mode existed", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "factory-new-ws-"));
    cleanupPaths.push(workspaceRoot);
    const config = { ...loadConfig({}), workspaceRoot, allowUntrustedScripts: false };
    const run = await runFactory({
      idea: "Build a Bible reading habit tracker",
      options: { demo: true },
      config,
      secrets: loadSecrets({}),
    });
    expect(run.status).toBe("completed");
    expect(run.appName).toBe("VerseKeeper");
  });
});
