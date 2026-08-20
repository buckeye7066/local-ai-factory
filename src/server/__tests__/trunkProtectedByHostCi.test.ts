/**
 * THE HOST REPO'S CI GATES EVERY TRUNK ADVANCE (owner decision 2026-08-20:
 * "protect factory deck's trunk").
 *
 * PR #74 made `deliverRun` fast-forward the trunk onto the run's branch
 * directly. On an UNPROTECTED trunk that advanced main on Factory Deck's own
 * evidence — its demo gate, its verification gate, its file-digest receipt —
 * without the host repository's CI ever running. This suite pins the reversal:
 *
 *   - a repo that HAS CI: delivery publishes the branch and STOPS. The trunk is
 *     byte-identical afterwards, and the branch is AHEAD of it, so the PR the
 *     release step opens has real commits in it (the exact mirror of the
 *     zero-ahead assertion in trunkReleaseHandoff.test.ts, which pins the
 *     opposite case);
 *   - a repo with NO CI: the named fallback fast-forwards, because there is no
 *     check a PR could ever wait on;
 *   - an explicit owner opt-in: the fallback, even on a repo with CI — the only
 *     way to bypass a gate, and it must be named in the run's report;
 *   - "could not tell whether there is CI": the GATE, never the bypass.
 *
 * Everything runs against a REAL local bare remote (no network), the way
 * trunkReleaseHandoff.test.ts does, and asserts on the remote's own refs rather
 * than on what the code said it did.
 */
import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { deliverRun } from "../orchestrator/deliverRun.js";
import {
  planRelease,
  planReleaseOutcome,
  planTrunkAdvance,
} from "../orchestrator/releasePlan.js";
import { detectHostCi } from "../workspace/hostCi.js";
import { captureFileDigests } from "../workspace/verificationReceipt.js";
import type { RunDestination, RunOptions } from "../../shared/schemas.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/**
 * A bare remote with `main`, plus a clone sitting on it. `ci: true` seeds a
 * real GitHub Actions workflow, which is what makes the host repo "have a gate".
 */
function makeRemoteAndClone(opts: { ci: boolean }): { remote: string; clone: string } {
  const root = mkdtempSync(join(tmpdir(), "factory-trunk-hostci-"));
  roots.push(root);
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const clone = join(root, "clone");
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", remote]);
  execFileSync("git", ["init", "-q", "-b", "main", seed]);
  git(["config", "user.email", "test@example.com"], seed);
  git(["config", "user.name", "Test"], seed);
  writeFileSync(join(seed, "README.md"), "# seed\n");
  if (opts.ci) {
    mkdirSync(join(seed, ".github", "workflows"), { recursive: true });
    writeFileSync(
      join(seed, ".github", "workflows", "ci.yml"),
      "name: CI\non: [pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n",
    );
  }
  git(["add", "-A"], seed);
  git(["commit", "-qm", "seed"], seed);
  git(["remote", "add", "origin", remote], seed);
  git(["push", "-q", "origin", "main"], seed);
  execFileSync("git", ["clone", "-q", remote, clone]);
  git(["config", "user.email", "test@example.com"], clone);
  git(["config", "user.name", "Test"], clone);
  return { remote, clone };
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
  options: RunOptions = {},
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
    appName: "Host CI trunk policy",
    options,
    verification: {
      qaPassed: true,
      testStatus: "passing",
      writeRefusals: 0,
      incompleteCommands: 0,
      fileDigests,
    },
  });
}

describe("a host repo WITH CI: Factory Deck does not touch the trunk", () => {
  it("publishes the branch, leaves main byte-identical, and leaves REAL commits for the PR", async () => {
    const { remote, clone } = makeRemoteAndClone({ ci: true });
    const mainBefore = git(["rev-parse", "main"], remote).trim();

    const dest = await deliverOnBranch(clone, remote, "factory-deck/ci01");

    // The work reached the repo — on a branch, bound to the verified commit.
    expect(dest.status).toBe("delivered");
    expect(dest.branchPushed).toBe(true);
    expect(
      git(["branch", "--format=%(refname:short)"], remote)
        .split(/\r?\n/)
        .map((s) => s.trim()),
    ).toContain("factory-deck/ci01");

    // THE POINT: the trunk did NOT move. Not "moved and reverted" — never
    // touched. Asserted on the remote's own ref, not on what the code claimed.
    expect(git(["rev-parse", "main"], remote).trim()).toBe(mainBefore);
    expect(dest.releasedToTrunk).toBe(false);
    expect(dest.trunkAdvancePath).toBe("pr-gate");

    // ...and main does not carry the file at all.
    expect(() => git(["show", "main:feature.txt"], remote)).toThrow();

    // The mirror of trunkReleaseHandoff's zero-ahead assertion: because the
    // trunk did not move, the PR the release step opens has real commits in it.
    git(["fetch", "-q", "origin"], clone);
    const ahead = git(
      ["rev-list", "--count", "origin/main..factory-deck/ci01"],
      clone,
    ).trim();
    expect(Number(ahead)).toBeGreaterThan(0);

    // The report must SAY which path was taken, not leave it to be inferred.
    expect(dest.detail).toMatch(/host repo's CI gates the trunk/i);
    expect(dest.detail).toMatch(/trunk was NOT advanced/i);

    // And the orchestrator must route it to the host repo's PR gate.
    expect(
      planRelease({
        destination: dest,
        demo: false,
        pushToOrigin: undefined,
        releaseToMainEnabled: true,
      }),
    ).toBe("open-pr");
  }, 60_000);

  it("does not touch the trunk even when the trunk is unprotected AND would accept a push", async () => {
    // The reversed behaviour in one assertion: an unprotected trunk is exactly
    // the case PR #74 advanced without CI. Prove the remote WOULD have taken it.
    const { remote, clone } = makeRemoteAndClone({ ci: true });
    const mainBefore = git(["rev-parse", "main"], remote).trim();

    const dest = await deliverOnBranch(clone, remote, "factory-deck/ci02");
    expect(git(["rev-parse", "main"], remote).trim()).toBe(mainBefore);

    // The remote accepts a main update from anyone who asks — nothing blocked
    // Factory Deck; it declined.
    git(["push", "-q", "origin", "factory-deck/ci02:refs/heads/main"], clone);
    expect(git(["rev-parse", "main"], remote).trim()).not.toBe(mainBefore);
    expect(dest.releasedToTrunk).toBe(false);
  }, 60_000);
});

describe("the NAMED FALLBACK: a repo with no CI at all", () => {
  it("fast-forwards the trunk, and the report names the fallback and its reason", async () => {
    const { remote, clone } = makeRemoteAndClone({ ci: false });
    const mainBefore = git(["rev-parse", "main"], remote).trim();

    const dest = await deliverOnBranch(clone, remote, "factory-deck/nc01");

    expect(dest.status).toBe("delivered");
    expect(dest.releasedToTrunk).toBe(true);
    expect(dest.trunkAdvancePath).toBe("direct-fast-forward");
    expect(git(["rev-parse", "main"], remote).trim()).not.toBe(mainBefore);
    expect(git(["show", "main:feature.txt"], remote)).toContain("generated");
    // Named, not silent: the report says it was a fallback and why.
    expect(dest.detail).toMatch(/FALLBACK \(no host CI\)/);

    // Nothing left for a PR to contain.
    git(["fetch", "-q", "origin"], clone);
    expect(
      git(["rev-list", "--count", "origin/main..factory-deck/nc01"], clone).trim(),
    ).toBe("0");
    expect(
      planRelease({
        destination: dest,
        demo: false,
        releaseToMainEnabled: true,
      }),
    ).toBe("already-on-trunk");
  }, 60_000);

  it("still refuses to force a protected trunk, and hands the work to the PR gate", async () => {
    const { remote, clone } = makeRemoteAndClone({ ci: false });
    protectMain(remote);
    const mainBefore = git(["rev-parse", "main"], remote).trim();

    const dest = await deliverOnBranch(clone, remote, "factory-deck/nc02");

    expect(dest.releasedToTrunk).toBe(false);
    expect(dest.branchPushed).toBe(true);
    // The rejection was reported, never retried with --force.
    expect(git(["rev-parse", "main"], remote).trim()).toBe(mainBefore);
    expect(dest.detail).toMatch(/NOT RELEASED/);
    expect(
      planRelease({
        destination: dest,
        demo: false,
        releaseToMainEnabled: true,
      }),
    ).toBe("open-pr");
  }, 60_000);
});

describe("the NAMED FALLBACK: an explicit owner opt-in", () => {
  it("bypasses the PR gate on a repo that HAS CI, and says so in the report", async () => {
    const { remote, clone } = makeRemoteAndClone({ ci: true });
    const mainBefore = git(["rev-parse", "main"], remote).trim();

    const dest = await deliverOnBranch(clone, remote, "factory-deck/opt01", {
      directTrunkAdvance: true,
    });

    expect(dest.releasedToTrunk).toBe(true);
    expect(dest.trunkAdvancePath).toBe("direct-fast-forward");
    expect(git(["rev-parse", "main"], remote).trim()).not.toBe(mainBefore);
    // A bypass that does not announce itself is the thing this policy forbids.
    expect(dest.detail).toMatch(/FALLBACK \(owner opt-in\)/);
  }, 60_000);

  it("is OFF by default — the same repo without the flag keeps its trunk", async () => {
    const { remote, clone } = makeRemoteAndClone({ ci: true });
    const mainBefore = git(["rev-parse", "main"], remote).trim();
    const dest = await deliverOnBranch(clone, remote, "factory-deck/opt02", {});
    expect(dest.trunkAdvancePath).toBe("pr-gate");
    expect(git(["rev-parse", "main"], remote).trim()).toBe(mainBefore);
  }, 60_000);
});

describe("planTrunkAdvance — the decision itself", () => {
  it("sends a repo with CI to the PR gate", () => {
    expect(planTrunkAdvance({ hostCi: "present" }).path).toBe("pr-gate");
  });

  it("sends a repo with NO CI to the named fallback", () => {
    const d = planTrunkAdvance({ hostCi: "absent" });
    expect(d.path).toBe("direct-fast-forward");
    expect(d.reason).toMatch(/no host CI/i);
  });

  it("sends UNKNOWN to the gate — not knowing is never permission to bypass", () => {
    const d = planTrunkAdvance({ hostCi: "unknown" });
    expect(d.path).toBe("pr-gate");
    expect(d.reason).toMatch(/could not determine/i);
  });

  it("honours the explicit opt-in over every other input", () => {
    for (const hostCi of ["present", "absent", "unknown"] as const) {
      const d = planTrunkAdvance({ hostCi, directTrunkAdvance: true });
      expect(d.path).toBe("direct-fast-forward");
      expect(d.reason).toMatch(/owner opt-in/i);
    }
  });

  it("treats an explicit `false` opt-in as no opt-in at all", () => {
    expect(
      planTrunkAdvance({ hostCi: "present", directTrunkAdvance: false }).path,
    ).toBe("pr-gate");
  });
});

describe("planReleaseOutcome — an open, auto-merging PR is not a failed run", () => {
  it("completes the run only when the commits are actually on the trunk", () => {
    expect(planReleaseOutcome("merged")).toBe("complete");
  });

  it("does NOT fail the run for a PR that is still going green", () => {
    // The false FAILED this policy exists to remove: before the three-state
    // result, anything that was not `released` failed the run — including a PR
    // that was open, armed, and one green check away from landing.
    expect(planReleaseOutcome("pending")).toBe("pending");
    expect(planReleaseOutcome("pending")).not.toBe("fail-run");
  });

  it("still fails the run for a genuinely blocked release", () => {
    // The mirror guarantee: "pending" must not become a way to launder a real
    // failure into a completed run.
    expect(planReleaseOutcome("held")).toBe("fail-run");
  });
});

describe("detectHostCi — read from the delivered tree, never guessed", () => {
  function tree(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "factory-hostci-detect-"));
    roots.push(root);
    for (const [rel, body] of Object.entries(files)) {
      const parts = rel.split("/");
      mkdirSync(join(root, ...parts.slice(0, -1)), { recursive: true });
      writeFileSync(join(root, ...parts), body);
    }
    return root;
  }

  it("finds a GitHub Actions workflow", () => {
    const d = detectHostCi(tree({ ".github/workflows/ci.yml": "on: push\n" }));
    expect(d.presence).toBe("present");
    expect(d.evidence).toBe(".github/workflows/ci.yml");
  });

  it("finds non-GitHub CI configurations too", () => {
    expect(detectHostCi(tree({ ".gitlab-ci.yml": "stages: [test]\n" })).presence).toBe(
      "present",
    );
    expect(detectHostCi(tree({ "Jenkinsfile": "pipeline {}\n" })).presence).toBe("present");
    expect(
      detectHostCi(tree({ ".circleci/config.yml": "version: 2.1\n" })).presence,
    ).toBe("present");
  });

  it("reports absent for a tree with no CI at all", () => {
    const d = detectHostCi(tree({ "README.md": "# hi\n", "src/app.ts": "export {};\n" }));
    expect(d.presence).toBe("absent");
    expect(d.evidence).toBeNull();
  });

  it("does not count an EMPTY workflow file as a gate", () => {
    expect(detectHostCi(tree({ ".github/workflows/ci.yml": "" })).presence).toBe("absent");
  });

  it("does not count a non-YAML file in the workflows directory", () => {
    expect(detectHostCi(tree({ ".github/workflows/README.md": "notes\n" })).presence).toBe(
      "absent",
    );
  });

  it("reports UNKNOWN — never absent — for a tree it cannot read", () => {
    const d = detectHostCi(join(tmpdir(), `definitely-not-here-${crypto.randomUUID()}`));
    expect(d.presence).toBe("unknown");
    // ...and unknown must route to the gate.
    expect(planTrunkAdvance({ hostCi: d.presence }).path).toBe("pr-gate");
  });
});
