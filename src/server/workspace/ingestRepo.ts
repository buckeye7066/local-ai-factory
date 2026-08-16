import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, stat } from "node:fs/promises";
import { resolve, join, isAbsolute, relative } from "node:path";
import type { RepoSource } from "../../shared/schemas.js";

/**
 * ingestRepo.ts — bring an EXISTING codebase into Factory Deck's extend-mode
 * pipeline.
 *
 * SAFETY DEFAULT: unless the caller explicitly sets `repoSource.inPlace: true`,
 * this ALWAYS produces an isolated copy under WORKSPACE_ROOT — a local path is
 * either `git clone`d (if it is itself a git repo, so history + the ability to
 * work on a throwaway branch survive) or file-copied; a git URL is always
 * cloned. Nothing here ever writes into the source location in the default
 * path. `inPlace: true` is a narrow, explicit opt-in for the one case that
 * needs it (an owner-authorized run against a real project) — it still refuses
 * to touch a dirty working tree, and it still works on a dedicated branch
 * rather than main, so "in place" never means "silently rewrite main with
 * uncommitted collateral damage."
 *
 * ORIGIN IS KEPT (owner order 2026-08-13: "whichever git repo I add prior to
 * the prompt is the one that the work should be saved in"). The clone keeps its
 * `origin` so the finished run can push its own `factory-deck/<id>` branch back
 * to the repo the owner attached. That delivery is the ONLY thing allowed to
 * push, it happens once at the end of a completed run, it is never a
 * force-push, and it never targets main/master — see workspace/gitOps.ts and
 * orchestrator/deliverRun.ts. Model-authored commands still cannot push at all:
 * `git push` remains off commandRunner's allowlist.
 */

export class IngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngestError";
  }
}

export interface IngestResult {
  /** Absolute path to the workspace the pipeline should read/write. */
  path: string;
  slug: string;
  /** True when `path` is a git working tree (branch/commit operations apply). */
  isGitRepo: boolean;
  /** Branch checked out in `path` for this run's changes, if any. */
  branch: string | null;
  /** True when `path` IS the original source location (no copy was made). */
  inPlace: boolean;
  /**
   * inPlace only: the branch the OWNER had checked out before this run cut its
   * own. The run restores it when it ends — a run that parks the owner's real
   * repo on a factory branch (the FlexFactor 2026-08-11 parking defect) leaves
   * their working tree wrong for every tool that opens it next.
   */
  previousBranch: string | null;
  /**
   * The repo this workspace can push back to (the attached git URL, or the
   * local checkout a clone came from). null when there is nowhere to deliver —
   * a plain folder copy with no git at all.
   */
  originUrl: string | null;
  log: string[];
}

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "repo"
  );
}

/** Run a trusted git command (argv array, no shell) with a bounded timeout. */
function runGit(
  args: string[],
  cwd: string,
  timeoutMs = 300_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn("git", args, { cwd, shell: false });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      rejectP(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveP({ code, stdout, stderr: stderr.slice(-4000) });
    });
  });
}

/** Reject argv-injection-shaped locations (leading `-` looks like a flag to git). */
function assertSafeGitArg(location: string): void {
  if (location.trim().startsWith("-")) {
    throw new IngestError(`Refused: repo location looks like a flag: ${location}`);
  }
}

async function isGitWorkingTree(dir: string): Promise<boolean> {
  return existsSync(join(dir, ".git"));
}

/**
 * A location that is plainly a remote URL is a GIT source, whatever the form
 * said. The owner pasted a GitHub URL with the "Local path" tab selected and
 * the run died deep inside slice 1 with
 * "Local path does not exist: C:\...\local-ai-factory\https:\github.com\...".
 * Nothing good comes of resolving a URL as a folder — correct it and say so.
 */
export function normalizeRepoSource(source: RepoSource): {
  source: RepoSource;
  note: string | null;
} {
  const looksRemote = /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/i.test(source.location.trim());
  if (source.type === "path" && looksRemote) {
    return {
      source: { ...source, type: "git", inPlace: false },
      note: `Treating ${source.location} as a Git URL (it was entered as a local path).`,
    };
  }
  return { source, note: null };
}

export async function ingestExistingRepo(
  workspaceRoot: string,
  rawSource: RepoSource,
  runId: string,
): Promise<IngestResult> {
  const log: string[] = [];
  const normalized = normalizeRepoSource(rawSource);
  const source = normalized.source;
  if (normalized.note) log.push(normalized.note);
  assertSafeGitArg(source.location);

  if (source.type === "git") {
    if (source.inPlace) {
      throw new IngestError("inPlace is only valid for repoSource.type = 'path'.");
    }
    const dest = resolve(
      join(workspaceRoot, `extend-${slugify(source.location)}-${runId.slice(0, 8)}`),
    );
    await mkdir(workspaceRoot, { recursive: true });
    log.push(`Cloning ${source.location} -> ${dest}`);
    // Full history (no --depth): a shallow clone is what a remote rejects with
    // "shallow update not allowed" when the run later pushes its branch back.
    const res = await runGit(
      ["clone", "--no-tags", source.location, dest],
      workspaceRoot,
    );
    if (res.code !== 0) {
      throw new IngestError(
        `git clone failed (exit ${res.code}): ${res.stderr.slice(0, 800)}`,
      );
    }
    const branch = `factory-deck/${runId.slice(0, 8)}`;
    await runGit(["checkout", "-b", branch], dest, 15_000);
    log.push(`Checked out branch ${branch} in the isolated clone.`);
    log.push(`origin kept as ${source.location} — the run's branch is pushed back there.`);
    return {
      path: dest,
      slug: slugify(source.location),
      isGitRepo: true,
      branch,
      inPlace: false,
    previousBranch: null,
      originUrl: source.location,
      log,
    };
  }

  // type === "path"
  const src = resolve(source.location);
  const st = await stat(src).catch(() => null);
  if (!st || !st.isDirectory()) {
    throw new IngestError(`Local path does not exist or is not a directory: ${src}`);
  }
  const rootReal = resolve(workspaceRoot);
  if (!source.inPlace) {
    const relToRoot = relative(rootReal, src);
    if (relToRoot === "" || (!relToRoot.startsWith("..") && !isAbsolute(relToRoot))) {
      throw new IngestError("Refused: source path is inside WORKSPACE_ROOT already.");
    }
  }

  if (source.inPlace) {
    // Narrow, explicit path: operate directly on the real directory. Still a
    // dedicated branch (never commit straight onto the caller's checked-out
    // branch). A pre-existing dirty working tree is NOT refused here — the
    // caller is responsible for staging/committing only the files ITS OWN run
    // touched (never `git add -A`), so any unrelated uncommitted work already
    // sitting in the tree is carried forward untouched, not swept into a commit.
    const isRepo = await isGitWorkingTree(src);
    if (!isRepo) {
      throw new IngestError(
        `inPlace requires a git working tree (no .git found at ${src}); refusing to edit a non-git directory in place.`,
      );
    }
    const branch = `factory-deck/${runId.slice(0, 8)}`;
    // Remember where the owner WAS, so the run can put them back.
    const previousBranch = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], src, 15_000)
      .then((r) => (r.code === 0 && r.stdout.trim() && r.stdout.trim() !== "HEAD" ? r.stdout.trim() : null))
      .catch(() => null);
    log.push(
      `Operating IN PLACE on ${src} (explicit opt-in) — checking out ${branch}` +
        (previousBranch ? ` (will restore ${previousBranch} when the run ends).` : "."),
    );
    const res = await runGit(["checkout", "-b", branch], src, 15_000);
    if (res.code !== 0) {
      throw new IngestError(
        `Could not create branch ${branch} in ${src} (exit ${res.code}): ${res.stderr.slice(0, 500)}`,
      );
    }
    // In place, the repo IS the destination; its own origin (if any) is where
    // the branch is published.
    const inPlaceOrigin = await runGit(["remote", "get-url", "origin"], src, 15_000)
      .then((r) => (r.code === 0 && r.stdout.trim() ? r.stdout.trim() : src))
      .catch(() => src);
    return {
      path: src,
      slug: slugify(src),
      isGitRepo: true,
      branch,
      inPlace: true,
      previousBranch,
      originUrl: inPlaceOrigin,
      log,
    };
  }

  const dest = resolve(
    join(workspaceRoot, `extend-${slugify(src)}-${runId.slice(0, 8)}`),
  );
  await mkdir(workspaceRoot, { recursive: true });
  if (await isGitWorkingTree(src)) {
    log.push(`Local git repo detected — cloning ${src} -> ${dest} (isolated copy).`);
    const res = await runGit(["clone", "--no-tags", src, dest], workspaceRoot);
    if (res.code !== 0) {
      throw new IngestError(
        `git clone (local) failed (exit ${res.code}): ${res.stderr.slice(0, 800)}`,
      );
    }
    const branch = `factory-deck/${runId.slice(0, 8)}`;
    await runGit(["checkout", "-b", branch], dest, 15_000);
    log.push(`Checked out branch ${branch} in the isolated clone.`);
    log.push(
      `origin kept as ${src} — the run's branch is pushed back into that checkout.`,
    );
    return {
      path: dest,
      slug: slugify(src),
      isGitRepo: true,
      branch,
      inPlace: false,
    previousBranch: null,
      originUrl: src,
      log,
    };
  }

  log.push(`No .git found — copying ${src} -> ${dest} (isolated copy).`);
  const EXCLUDE = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    "out",
    "coverage",
    ".turbo",
    "venv",
    ".venv",
    "__pycache__",
    "target",
  ]);
  await cp(src, dest, {
    recursive: true,
    filter: (source_) => {
      const base = source_.split(/[\\/]/).pop() ?? "";
      return !EXCLUDE.has(base);
    },
  });
  return {
    path: dest,
    slug: slugify(src),
    isGitRepo: false,
    branch: null,
    inPlace: false,
    previousBranch: null,
    // A plain folder copy has no git anywhere, so there is nothing to push
    // back to — the run's output stays in its workspace and says so.
    originUrl: null,
    log,
  };
}
