/**
 * TWO RELEASE MECHANISMS, ONE TRUNK.
 *
 * `deliverRun` fast-forwards the repo's default branch onto the run's branch
 * (owner order 2026-08-19). `runFactory` then used to ALWAYS run `releaseRun`,
 * which opens a PR from that same branch onto main. Those cannot both be right:
 *
 *  - fast-forward SUCCEEDED  → branch and trunk are the same commit, so the PR
 *    has ZERO commits. GitHub refuses an empty PR, `releaseRun` reports "could
 *    not open the PR", and the run was marked FAILED — with its work already in
 *    production. A run that succeeded must never be reported as failed.
 *  - fast-forward REJECTED (a PROTECTED trunk) → delivery returned "failed" and
 *    the orchestrator stopped there, so the PR path — the correct recovery for
 *    a protected trunk — never ran. Verified work sat on a pushed branch with
 *    no PR and nothing asking anyone to finish it.
 *
 * These tests drive the REAL deliverRun against a REAL local bare remote (no
 * network), and drive the REAL decision function on the facts it produces.
 */
import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { deliverRun } from "../orchestrator/deliverRun.js";
import { planRelease } from "../orchestrator/releasePlan.js";
import { captureFileDigests } from "../workspace/verificationReceipt.js";
import type { RunDestination } from "../../shared/schemas.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A bare remote with `main`, plus a clone sitting on a factory-deck branch. */
function makeRemoteAndClone(): { root: string; remote: string; clone: string } {
  const root = mkdtempSync(join(tmpdir(), "factory-trunk-handoff-"));
  roots.push(root);
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const clone = join(root, "clone");
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", remote]);
  execFileSync("git", ["init", "-q", "-b", "main", seed]);
  git(["config", "user.email", "test@example.com"], seed);
  git(["config", "user.name", "Test"], seed);
  writeFileSync(join(seed, "README.md"), "# seed\n");
  git(["add", "-A"], seed);
  git(["commit", "-qm", "seed"], seed);
  git(["remote", "add", "origin", remote], seed);
  git(["push", "-q", "origin", "main"], seed);
  execFileSync("git", ["clone", "-q", remote, clone]);
  git(["config", "user.email", "test@example.com"], clone);
  git(["config", "user.name", "Test"], clone);
  return { root, remote, clone };
}

/** Make the bare remote behave like a PROTECTED trunk: main updates are refused. */
function protectMain(remote: string): void {
  const hook = join(remote, "hooks", "pre-receive");
  writeFileSync(
    hook,
    "#!/bin/sh\n" +
      "while read old new ref; do\n" +
      '  if [ "$ref" = "refs/heads/main" ]; then\n' +
      '    echo "remote: error: GH006: Protected branch update failed" >&2\n' +
      "    exit 1\n" +
      "  fi\n" +
      "done\n" +
      "exit 0\n",
    { mode: 0o755 },
  );
  chmodSync(hook, 0o755);
}

async function deliverOnBranch(
  clone: string,
  remote: string,
  branch: string,
): Promise<RunDestination> {
  git(["checkout", "-q", "-b", branch], clone);
  writeFileSync(join(clone, "feature.txt"), "generated\n");
  const fileDigests = await captureFileDigests(clone, ["feature.txt"]);
  return deliverRun({
    destination: {
      kind: "existing-repo",
      target: remote,
      branch,
      status: "planned",
      detail: null,
      url: null,
      deliveredAt: null,
    },
    workspacePath: clone,
    filePaths: ["feature.txt"],
    runId: crypto.randomUUID(),
    appName: "Trunk handoff",
    options: {},
    verification: {
      qaPassed: true,
      testStatus: "passing",
      writeRefusals: 0,
      incompleteCommands: 0,
      fileDigests,
    },
  });
}

describe("an unprotected trunk: the work lands, and there is nothing left to PR", () => {
  it("reports releasedToTrunk and leaves the branch with ZERO commits ahead of the trunk", async () => {
    const { remote, clone } = makeRemoteAndClone();
    const mainBefore = git(["rev-parse", "main"], remote).trim();

    const dest = await deliverOnBranch(clone, remote, "factory-deck/ff01");

    expect(dest.status).toBe("delivered");
    expect(dest.branchPushed).toBe(true);
    expect(dest.releasedToTrunk).toBe(true);
    // The claim is only real if the trunk MOVED and carries the file.
    expect(git(["rev-parse", "main"], remote).trim()).not.toBe(mainBefore);
    expect(git(["show", "main:feature.txt"], remote)).toContain("generated");

    // THE POINT: a PR from this branch onto main would contain nothing at all.
    // This is why the gated release step must be skipped, not attempted.
    git(["fetch", "-q", "origin"], clone);
    const ahead = git(
      ["rev-list", "--count", "origin/main..factory-deck/ff01"],
      clone,
    ).trim();
    expect(ahead).toBe("0");

    // And the orchestrator must therefore choose "already on trunk".
    expect(
      planRelease({
        destination: dest,
        demo: false,
        pushToOrigin: undefined,
        releaseToMainEnabled: true,
      }),
    ).toBe("already-on-trunk");
  }, 60_000);
});

describe("a PROTECTED trunk: the branch is published and the PR gate takes over", () => {
  it("records branchPushed without releasedToTrunk, leaves main alone, and plans a PR", async () => {
    const { remote, clone } = makeRemoteAndClone();
    protectMain(remote);
    const mainBefore = git(["rev-parse", "main"], remote).trim();

    const dest = await deliverOnBranch(clone, remote, "factory-deck/ff02");

    expect(dest.status).toBe("failed");
    // The branch really is published — that is what makes the PR recovery real.
    expect(dest.branchPushed).toBe(true);
    expect(dest.releasedToTrunk).toBe(false);
    expect(
      git(["branch", "--format=%(refname:short)"], remote)
        .split(/\r?\n/)
        .map((s) => s.trim()),
    ).toContain("factory-deck/ff02");
    // ...and the trunk was NOT forced past its protection.
    expect(git(["rev-parse", "main"], remote).trim()).toBe(mainBefore);

    // The orchestrator must route this to the repo's own PR gate rather than
    // stopping the run — the hole this restores.
    expect(
      planRelease({
        destination: dest,
        demo: false,
        pushToOrigin: undefined,
        releaseToMainEnabled: true,
      }),
    ).toBe("open-pr");
  }, 60_000);
});

describe("planRelease — the decision itself", () => {
  const base = {
    kind: "existing-repo" as const,
    branch: "factory-deck/x",
    commitSha: "a".repeat(40),
  };

  it("never opens a PR for a branch already merged into the trunk", () => {
    expect(
      planRelease({
        destination: {
          ...base,
          status: "delivered",
          branchPushed: true,
          releasedToTrunk: true,
        },
        demo: false,
        releaseToMainEnabled: true,
      }),
    ).toBe("already-on-trunk");
  });

  it("fails the run when nothing was pushed at all", () => {
    expect(
      planRelease({
        destination: {
          ...base,
          status: "failed",
          branchPushed: false,
          releasedToTrunk: false,
        },
        demo: false,
        releaseToMainEnabled: true,
      }),
    ).toBe("fail-delivery");
  });

  it("fails the run when the branch is pushed but releasing to main is disabled", () => {
    // FACTORY_RELEASE_TO_MAIN=0 means there is no PR path to fall back to, so
    // a trunk that did not move is still an incomplete delivery.
    expect(
      planRelease({
        destination: {
          ...base,
          status: "failed",
          branchPushed: true,
          releasedToTrunk: false,
        },
        demo: false,
        releaseToMainEnabled: false,
      }),
    ).toBe("fail-delivery");
  });

  it("has nothing to release for a workspace-only run", () => {
    expect(
      planRelease({
        destination: {
          kind: "workspace-only",
          branch: null,
          commitSha: null,
          status: "skipped",
        },
        demo: false,
        releaseToMainEnabled: true,
      }),
    ).toBe("none");
  });

  it("has nothing to release when the owner disabled pushing back to origin", () => {
    expect(
      planRelease({
        destination: { ...base, status: "skipped" },
        demo: false,
        pushToOrigin: false,
        releaseToMainEnabled: true,
      }),
    ).toBe("none");
  });
});
