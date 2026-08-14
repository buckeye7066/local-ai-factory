import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { pushBranch, commitRunFiles, originUrl } from "../workspace/gitOps.js";

/**
 * Exercises the ACTUAL push path against a local bare remote — no network.
 *
 * `isProtectedBranch` is unit-tested elsewhere, but a predicate being correct
 * proves nothing about whether the push path consults it. These tests make the
 * guard actually fire, and prove the safe case really does move commits, so a
 * guard that silently stopped working (or a push that silently did nothing)
 * cannot pass.
 */

const git = (args: string[], cwd: string) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A bare "remote" plus a working clone with an initial commit on main. */
async function makeRemoteAndClone() {
  const root = await mkdtemp(join(tmpdir(), "factory-push-"));
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const clone = join(root, "clone");

  execFileSync("git", ["init", "--bare", "-b", "main", remote]);
  execFileSync("git", ["init", "-b", "main", seed]);
  git(["config", "user.email", "test@example.com"], seed);
  git(["config", "user.name", "Test"], seed);
  await writeFile(join(seed, "README.md"), "# seed\n");
  git(["add", "-A"], seed);
  git(["commit", "-q", "-m", "seed"], seed);
  git(["remote", "add", "origin", remote], seed);
  git(["push", "-q", "origin", "main"], seed);

  execFileSync("git", ["clone", "-q", remote, clone]);
  git(["config", "user.email", "test@example.com"], clone);
  git(["config", "user.name", "Test"], clone);
  return { root, remote, clone };
}

const remoteBranches = (remote: string) =>
  git(["branch", "--format=%(refname:short)"], remote).split("\n").filter(Boolean);

describe("pushBranch — what may reach the owner's repo", () => {
  it("REFUSES to push main, and the remote is genuinely unchanged", async () => {
    const { root, remote, clone } = await makeRemoteAndClone();
    try {
      const before = git(["rev-parse", "main"], remote);
      await writeFile(join(clone, "sneaky.txt"), "should never land on main\n");
      const commit = await commitRunFiles(clone, ["sneaky.txt"], "run output");
      expect(commit.committed).toBe(true);

      const res = await pushBranch(clone, "main");

      expect(res.pushed).toBe(false);
      expect(res.detail).toMatch(/Refused/);
      // The guard is only real if the remote did not move.
      expect(git(["rev-parse", "main"], remote)).toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("PUSHES the run's own factory-deck branch and the remote really gains it", async () => {
    const { root, remote, clone } = await makeRemoteAndClone();
    try {
      const mainBefore = git(["rev-parse", "main"], remote);
      expect(remoteBranches(remote)).not.toContain("factory-deck/abcd1234");

      git(["checkout", "-q", "-b", "factory-deck/abcd1234"], clone);
      await writeFile(join(clone, "feature.txt"), "generated\n");
      const commit = await commitRunFiles(clone, ["feature.txt"], "run output");
      expect(commit.committed).toBe(true);

      const res = await pushBranch(clone, "factory-deck/abcd1234");

      expect(res.pushed).toBe(true);
      expect(remoteBranches(remote)).toContain("factory-deck/abcd1234");
      // The delivered file is really on the delivered branch...
      expect(
        git(["show", "factory-deck/abcd1234:feature.txt"], remote),
      ).toContain("generated");
      // ...and main was not touched.
      expect(git(["rev-parse", "main"], remote)).toBe(mainBefore);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("reports a missing origin instead of failing silently", async () => {
    const { root, clone } = await makeRemoteAndClone();
    try {
      git(["remote", "remove", "origin"], clone);
      expect(await originUrl(clone)).toBeNull();

      const res = await pushBranch(clone, "factory-deck/abcd1234");

      expect(res.pushed).toBe(false);
      expect(res.detail).toMatch(/No 'origin' remote/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("commitRunFiles — only the run's own output is committed", () => {
  it("leaves unrelated uncommitted work in the tree alone", async () => {
    const { root, clone } = await makeRemoteAndClone();
    try {
      // The owner's own in-progress edit, sitting in the tree.
      await writeFile(join(clone, "OWNERS_WIP.txt"), "do not commit me\n");
      // What the run generated.
      await writeFile(join(clone, "generated.txt"), "run output\n");

      const res = await commitRunFiles(clone, ["generated.txt"], "run output");
      expect(res.committed).toBe(true);

      const committed = git(["show", "--name-only", "--format=", "HEAD"], clone)
        .split("\n")
        .filter(Boolean);
      expect(committed).toEqual(["generated.txt"]);
      // Still untracked — never swept into the run's commit.
      expect(git(["status", "--porcelain"], clone)).toContain("OWNERS_WIP.txt");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("reports nothing-to-commit rather than claiming a delivery", async () => {
    const { root, clone } = await makeRemoteAndClone();
    try {
      const res = await commitRunFiles(clone, ["README.md"], "run output");
      expect(res.committed).toBe(false);
      expect(res.detail).toMatch(/Nothing to commit/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
