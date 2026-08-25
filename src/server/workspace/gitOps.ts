import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * gitOps.ts — the ORCHESTRATOR's own git/gh calls.
 *
 * Deliberately separate from `commandRunner.ts`. That module executes
 * MODEL-authored commands and keeps `git push` off its allowlist — nothing an
 * agent writes may ever push. This module is the opposite case: fixed argv
 * assembled by Factory Deck itself, used only to deliver a finished run to the
 * repo the OWNER attached (or to the repo the owner asked to be created).
 *
 * Rules that hold everywhere in here:
 *  - argv arrays, `shell: false` — no string interpolation into a shell.
 *  - never `--force` / `+refs`; a push either fast-forwards or fails loudly.
 *  - the run AUTHORS its commit on its own `factory-deck/<id>` branch, never
 *    directly on the trunk — `pushBranch` still refuses a protected branch.
 *
 * Owner order, 2026-08-19: "The work is pushed to main directly so it is in
 * production." A verified run does NOT stop at a side branch. After the run's
 * branch is published, `releaseToMain` fast-forwards the repo's trunk onto it,
 * so the finished work is on `main` and therefore in production. The branch is
 * kept as the audit trail, not as a parking space.
 *
 * The trunk only ever moves by FAST-FORWARD from a branch that already contains
 * the current trunk. That is the whole safety argument: no `--force`, no merge
 * commit invented on the trunk, and if anyone else pushed in the meantime the
 * push is REJECTED and reported rather than overwritten.
 */

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when the binary could not be spawned at all (e.g. gh not installed). */
  spawnError: string | null;
}

function run(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs = 300_000,
): Promise<ExecResult> {
  return new Promise((resolveP) => {
    const child = spawn(bin, args, { cwd, shell: false });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolveP({ code: null, stdout, stderr, spawnError: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveP({
        code,
        stdout: stdout.trim(),
        stderr: stderr.slice(-4000).trim(),
        spawnError: null,
      });
    });
  });
}

export const git = (args: string[], cwd: string, timeoutMs?: number) =>
  run("git", args, cwd, timeoutMs);

/** `gh` on Windows is `gh.exe`; spawn resolves it from PATH either way. */
export const gh = (args: string[], cwd: string, timeoutMs?: number) =>
  run("gh", args, cwd, timeoutMs);

export function isGitWorkingTree(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

/** Best-effort one-line failure text for a result (never throws). */
export function failureText(res: ExecResult): string {
  if (res.spawnError) return res.spawnError;
  const body = res.stderr || res.stdout || "";
  return `exit ${res.code}${body ? `: ${body.slice(0, 600)}` : ""}`;
}

/** The push URL configured for `origin`, or null when there is no origin. */
export async function originUrl(dir: string): Promise<string | null> {
  const res = await git(["remote", "get-url", "origin"], dir, 15_000);
  if (res.code !== 0 || !res.stdout) return null;
  return res.stdout;
}

/** Currently checked-out branch name, or null on a detached/empty HEAD. */
export async function currentBranch(dir: string): Promise<string | null> {
  const res = await git(["rev-parse", "--abbrev-ref", "HEAD"], dir, 15_000);
  if (res.code !== 0) return null;
  const name = res.stdout.trim();
  return !name || name === "HEAD" ? null : name;
}

/**
 * Branches a run may never AUTHOR its commit on. The run always commits to its
 * own `factory-deck/<id>` branch; the trunk is advanced afterwards, and only by
 * fast-forward, in `releaseToMain`.
 */
export function isProtectedBranch(branch: string): boolean {
  return /^(main|master|trunk|develop|release)$/i.test(branch.trim());
}

/**
 * The remote's real default branch, asked of the remote rather than assumed.
 *
 * `main` is not universal and a wrong guess here would push production work to
 * a branch nobody deploys. `ls-remote --symref` is the remote's own answer;
 * the `origin/<name>` probes are the fallback for remotes that do not publish a
 * symref (some local/bare remotes). Returns null when neither can be resolved,
 * which the caller REPORTS instead of guessing.
 */
export async function defaultRemoteBranch(dir: string): Promise<string | null> {
  const sym = await git(["ls-remote", "--symref", "origin", "HEAD"], dir, 60_000);
  if (sym.code === 0) {
    const m = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(sym.stdout);
    if (m?.[1]) return m[1];
  }
  for (const name of ["main", "master"]) {
    const r = await git(
      ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${name}`],
      dir,
      15_000,
    );
    if (r.code === 0 && r.stdout.trim()) return name;
  }
  return null;
}

/**
 * Initialise a fresh repo for a brand-new app. `-b main` keeps the default
 * branch explicit rather than inheriting whatever init.defaultBranch happens to
 * be. Idempotent: an already-initialised directory is left alone.
 */
export async function initRepo(dir: string): Promise<ExecResult | null> {
  if (isGitWorkingTree(dir)) return null;
  return git(["init", "-b", "main"], dir, 30_000);
}

/**
 * Stage EXACTLY the paths this run wrote and commit them.
 *
 * Never `git add -A`: an ingested repo may carry the owner's own uncommitted
 * work (and always carries `node_modules` after the install step), and sweeping
 * that into the run's commit would deliver changes the run did not make. Paths
 * are passed after `--` so a file named like a flag is still just a file.
 *
 * Returns `committed: false` with a reason when there was nothing to commit —
 * that is a normal outcome, not an error.
 */
export async function commitRunFiles(
  dir: string,
  relativePaths: string[],
  message: string,
): Promise<{
  committed: boolean;
  unchanged: boolean;
  detail: string;
  sha: string | null;
}> {
  const paths = [...new Set(relativePaths.filter((p) => p && !p.startsWith("..")))];
  if (!paths.length) {
    return {
      committed: false,
      unchanged: false,
      detail: "No generated files to commit.",
      sha: null,
    };
  }
  // Stage in batches so a very large build cannot overflow the command line.
  for (let i = 0; i < paths.length; i += 100) {
    const batch = paths.slice(i, i + 100);
    const add = await git(["add", "--", ...batch], dir, 60_000);
    if (add.code !== 0) {
      return {
        committed: false,
        unchanged: false,
        detail: `git add failed — ${failureText(add)}`,
        sha: null,
      };
    }
  }
  const staged = await git(["diff", "--cached", "--name-only"], dir, 30_000);
  if (staged.code === 0 && !staged.stdout.trim()) {
    return {
      committed: false,
      unchanged: true,
      detail:
        "Nothing to commit — the generated files match what is already in the repo.",
      sha: null,
    };
  }
  const commit = await git(["commit", "-m", message], dir, 60_000);
  if (commit.code !== 0) {
    return {
      committed: false,
      unchanged: false,
      detail: `git commit failed — ${failureText(commit)}`,
      sha: null,
    };
  }
  const head = await git(["rev-parse", "HEAD"], dir, 15_000);
  return {
    committed: true,
    unchanged: false,
    detail: `Committed ${paths.length} file(s).`,
    sha: head.code === 0 ? head.stdout.trim() : null,
  };
}

/**
 * Push ONE branch to origin. No force, no upstream rewriting, and a hard refusal
 * to push a protected trunk branch even if a caller asks for it.
 *
 * A shallow clone (`--depth`) can be rejected by the remote with "shallow update
 * not allowed"; we unshallow first when the repo is shallow so the push has a
 * complete history to offer.
 */
export async function pushBranch(
  dir: string,
  branch: string,
): Promise<{ pushed: boolean; detail: string }> {
  if (isProtectedBranch(branch)) {
    return {
      pushed: false,
      detail: `Refused: will not push the protected branch "${branch}" — runs deliver on their own factory-deck/* branch.`,
    };
  }
  const remote = await originUrl(dir);
  if (!remote) {
    return {
      pushed: false,
      detail: "No 'origin' remote on this workspace — nothing to push back to.",
    };
  }
  const shallow = await git(["rev-parse", "--is-shallow-repository"], dir, 15_000);
  if (shallow.code === 0 && shallow.stdout.trim() === "true") {
    await git(["fetch", "--unshallow", "origin"], dir, 600_000).catch(() => undefined);
  }
  const res = await git(["push", "origin", `${branch}:${branch}`], dir, 600_000);
  if (res.code !== 0) {
    return { pushed: false, detail: `git push failed — ${failureText(res)}` };
  }
  return { pushed: true, detail: `Pushed ${branch} to ${remote}.` };
}

export interface ReleaseResult {
  released: boolean;
  /** The trunk that was targeted, once known — for the report either way. */
  trunk: string | null;
  detail: string;
}

/**
 * Land the run's verified branch ON THE TRUNK, so the work is in production.
 *
 * Owner order 2026-08-19: a finished run does not stop at a side branch. This
 * is the step that makes "delivered" mean "on main".
 *
 * Sequence, and why each part is the way it is:
 *  1. resolve the remote's REAL default branch (never assume "main");
 *  2. fetch it, and merge it INTO the run's branch. Integrating on the run's
 *     branch is what keeps the trunk clean: a conflict or a dirty working tree
 *     fails HERE, with the trunk untouched, instead of leaving a half-merged
 *     trunk behind;
 *  3. push the run's branch again, so the merge commit is in the audit trail;
 *  4. push `branch -> refs/heads/<trunk>`. Because the branch now contains the
 *     trunk, this is a pure FAST-FORWARD. No `--force` anywhere: if someone
 *     else advanced the trunk between the fetch and the push, git rejects it
 *     and that rejection is returned as the outcome — never retried with force.
 *
 * Never throws. A failure to release is reported and leaves the pushed branch
 * as the recoverable artifact; the caller must not report it as delivered.
 */
export async function releaseToMain(
  dir: string,
  branch: string,
): Promise<ReleaseResult> {
  if (isProtectedBranch(branch)) {
    return {
      released: false,
      trunk: null,
      detail: `Refused: "${branch}" is a trunk name, but a run's work is authored on its own factory-deck/* branch.`,
    };
  }
  const remote = await originUrl(dir);
  if (!remote) {
    return {
      released: false,
      trunk: null,
      detail:
        "No 'origin' remote on this workspace — there is no trunk to release onto.",
    };
  }
  const trunk = await defaultRemoteBranch(dir);
  if (!trunk) {
    return {
      released: false,
      trunk: null,
      detail:
        "Could not determine the repo's default branch from origin, so nothing was released. " +
        `The run's work is safe on ${branch}.`,
    };
  }

  const on = await currentBranch(dir);
  if (on !== branch) {
    return {
      released: false,
      trunk,
      detail: `Refused: expected to be on ${branch} but the workspace is on ${on ?? "a detached HEAD"}.`,
    };
  }

  const fetched = await git(["fetch", "origin", trunk], dir, 600_000);
  if (fetched.code !== 0) {
    return {
      released: false,
      trunk,
      detail: `Could not fetch origin/${trunk} — ${failureText(fetched)}. The run's work is safe on ${branch}.`,
    };
  }

  // Merge the trunk INTO the run's branch. --no-ff keeps the run identifiable
  // in trunk history; --no-edit avoids opening an editor in a headless run.
  const merged = await git(
    ["merge", "--no-ff", "--no-edit", "FETCH_HEAD"],
    dir,
    300_000,
  );
  if (merged.code !== 0) {
    // Leave NOTHING half-merged. Abort restores the branch; the push above
    // already published the run's own commit, so the work is not lost.
    await git(["merge", "--abort"], dir, 60_000).catch(() => undefined);
    return {
      released: false,
      trunk,
      detail:
        `Could not merge origin/${trunk} into ${branch} — ${failureText(merged)}. ` +
        `The merge was aborted and nothing was pushed to ${trunk}; the run's work is on ${branch}.`,
    };
  }

  // Publish the merge on the run's branch first, so the audit trail exists even
  // if the trunk push is rejected a moment later.
  const rePush = await git(["push", "origin", `${branch}:${branch}`], dir, 600_000);
  if (rePush.code !== 0) {
    return {
      released: false,
      trunk,
      detail: `Could not push the merged ${branch} — ${failureText(rePush)}. Nothing was pushed to ${trunk}.`,
    };
  }

  const release = await git(
    ["push", "origin", `${branch}:refs/heads/${trunk}`],
    dir,
    600_000,
  );
  if (release.code !== 0) {
    return {
      released: false,
      trunk,
      detail:
        `Fast-forward of ${trunk} was REJECTED — ${failureText(release)}. ` +
        `Not retried with --force. The work is on ${branch} and can be merged from there.`,
    };
  }
  return {
    released: true,
    trunk,
    detail: `Merged ${branch} into ${trunk} and pushed ${trunk} to ${remote} — the work is in production.`,
  };
}

/* ------------------------------------------------------------------ */
/* GitHub (gh CLI)                                                     */
/* ------------------------------------------------------------------ */

export type RepoExistence = "exists" | "free" | "unknown";

/**
 * Does `owner/name` already exist on GitHub? "unknown" (gh missing or not
 * authenticated) is reported as such and never silently treated as "free" —
 * telling the owner a name is available when we could not check would be the
 * exact kind of quiet false claim this deck forbids.
 */
export async function githubRepoExists(
  fullName: string,
  cwd: string,
): Promise<{ existence: RepoExistence; detail: string }> {
  const res = await gh(["repo", "view", fullName, "--json", "name"], cwd, 30_000);
  if (res.spawnError) {
    return { existence: "unknown", detail: `gh not available: ${res.spawnError}` };
  }
  if (res.code === 0)
    return { existence: "exists", detail: `${fullName} already exists.` };
  const err = `${res.stderr}\n${res.stdout}`.toLowerCase();
  if (err.includes("could not resolve") || err.includes("not found")) {
    return { existence: "free", detail: `${fullName} is available.` };
  }
  return { existence: "unknown", detail: failureText(res) };
}

/** The authenticated gh account, used as the default owner for new repos. */
export async function githubLogin(cwd: string): Promise<string | null> {
  const res = await gh(["api", "user", "--jq", ".login"], cwd, 30_000);
  if (res.code !== 0 || !res.stdout.trim()) return null;
  return res.stdout.trim();
}

/**
 * Create `owner/name` on GitHub from an existing local repo and push it.
 * `--source` + `--push` is gh's own one-shot flow: it creates the remote, wires
 * up `origin`, and pushes the current branch.
 */
export async function githubCreateRepo(args: {
  fullName: string;
  dir: string;
  private: boolean;
}): Promise<{ created: boolean; detail: string; url: string | null }> {
  const res = await gh(
    [
      "repo",
      "create",
      args.fullName,
      args.private ? "--private" : "--public",
      "--source",
      args.dir,
      "--push",
    ],
    args.dir,
    600_000,
  );
  if (res.code !== 0) {
    return {
      created: false,
      detail: `gh repo create failed — ${failureText(res)}`,
      url: null,
    };
  }
  const printed = `${res.stdout}\n${res.stderr}`.match(/https:\/\/github\.com\/\S+/);
  return {
    created: true,
    detail: `Created ${args.fullName} and pushed the work.`,
    url: printed
      ? printed[0].replace(/[.,)]+$/, "")
      : `https://github.com/${args.fullName}`,
  };
}

/**
 * Turn a git remote URL into a browsable compare link for `branch`, so the
 * owner can open a PR in one click. Returns null for non-GitHub remotes (a
 * local path, a self-hosted host) rather than guessing a URL shape.
 */
export function compareUrlFor(remote: string, branch: string): string | null {
  const m = githubOwnerRepo(remote);
  if (!m) return null;
  return `https://github.com/${m.owner}/${m.repo}/compare/${encodeURIComponent(branch)}?expand=1`;
}

/**
 * Commit-history link for a branch — the link that matters once the work is
 * actually ON the trunk, where a "compare" view would be empty.
 */
export function branchUrlFor(remote: string, branch: string): string | null {
  const m = githubOwnerRepo(remote);
  if (!m) return null;
  return `https://github.com/${m.owner}/${m.repo}/commits/${encodeURIComponent(branch)}`;
}

function githubOwnerRepo(remote: string): { owner: string; repo: string } | null {
  const m =
    /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remote.trim()) ??
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remote.trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}
