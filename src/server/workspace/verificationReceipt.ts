import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, posix, relative } from "node:path";
import { readWorkspaceFile } from "./fileWriter.js";

function canonical(path: string): string {
  if (!path) return "";
  const normalized = posix.normalize(path.replace(/\\/g, "/")).replace(/^\.\/+/, "");
  return normalized === "." ? "" : normalized;
}

export function sha256Text(contents: string): string {
  return createHash("sha256").update(contents, "utf8").digest("hex");
}

export async function captureFileDigests(
  workspacePath: string,
  paths: Iterable<string>,
): Promise<Record<string, string>> {
  const digests: Record<string, string> = {};
  for (const rawPath of paths) {
    const path = canonical(rawPath);
    const contents = await readWorkspaceFile(workspacePath, path);
    digests[path] = sha256Text(contents);
  }
  return digests;
}

export async function verifyFileDigests(
  workspacePath: string,
  paths: Iterable<string>,
  expected: Record<string, string> | undefined,
): Promise<{ ok: boolean; reason?: string }> {
  const canonicalPaths = [...new Set([...paths].map(canonical))].sort();
  if (!expected || Object.keys(expected).length !== canonicalPaths.length) {
    return {
      ok: false,
      reason:
        "verification receipt is missing paths or belongs to another deliverable set",
    };
  }
  for (const path of canonicalPaths) {
    const expectedDigest = expected[path];
    if (!expectedDigest) {
      return { ok: false, reason: `verification receipt is missing ${path}` };
    }
    let contents: string;
    try {
      contents = await readWorkspaceFile(workspacePath, path);
    } catch (error) {
      return {
        ok: false,
        reason: `verified file ${path} cannot be read safely: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    if (sha256Text(contents) !== expectedDigest) {
      return {
        ok: false,
        reason: `verified file changed after checks ran: ${path}`,
      };
    }
  }
  return { ok: true };
}

export function verificationReceiptHash(
  expected: Record<string, string> | undefined,
): string {
  const entries = Object.entries(expected ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return sha256Text(JSON.stringify(entries));
}

/**
 * Verify the bytes and changed-path set in the actual commit object. Working
 * tree checks alone cannot detect a pre-staged extra file, clean filter, or
 * hook that changed the index before git commit.
 */
export function verifyCommitFileDigests(
  workspacePath: string,
  commitSha: string,
  allowedPaths: Iterable<string>,
  expected: Record<string, string> | undefined,
): { ok: boolean; reason?: string } {
  if (!/^[0-9a-f]{40,64}$/i.test(commitSha)) {
    return { ok: false, reason: "commit SHA is missing or malformed" };
  }
  const paths = [...new Set([...allowedPaths].map(canonical))].sort();
  if (!expected || Object.keys(expected).length !== paths.length) {
    return {
      ok: false,
      reason: "commit receipt is missing paths or belongs to another deliverable set",
    };
  }
  try {
    const changed = execFileSync(
      "git",
      [
        "-C",
        workspacePath,
        "diff-tree",
        "--root",
        "--no-commit-id",
        "--name-only",
        "-r",
        "-z",
        commitSha,
      ],
      {
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 64 * 1024 * 1024,
      },
    )
      .split("\0")
      .filter(Boolean)
      .map(canonical);
    const allowed = new Set(paths);
    const extra = changed.filter((path) => !allowed.has(path));
    if (extra.length) {
      return {
        ok: false,
        reason:
          "commit contains paths outside the verification receipt: " +
          extra.slice(0, 20).join(", "),
      };
    }
    for (const path of paths) {
      const blob = execFileSync(
        "git",
        ["-C", workspacePath, "show", `${commitSha}:${path}`],
        {
          encoding: "buffer",
          timeout: 30_000,
          maxBuffer: 64 * 1024 * 1024,
        },
      );
      const digest = createHash("sha256").update(blob).digest("hex");
      if (digest !== expected[path]) {
        return {
          ok: false,
          reason: `committed blob differs from verified bytes: ${path}`,
        };
      }
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason:
        "cannot verify the committed tree safely: " +
        (error instanceof Error ? error.message : String(error)),
    };
  }
}

export interface VerificationWindowResult<T> {
  ok: boolean;
  phase: "before" | "after";
  reason?: string;
  value?: T;
}

/**
 * Execute verification only while the orchestrator's intended deliverable
 * bytes stay fixed. Test/build scripts may create derived output, but they may
 * not rewrite a path that the run plans to commit and then bless that rewrite.
 */
export async function withVerificationReceipt<T>(
  workspacePath: string,
  paths: Iterable<string>,
  intendedDigests: Record<string, string>,
  action: () => Promise<T>,
): Promise<VerificationWindowResult<T>> {
  const stablePaths = [...paths];
  const before = await verifyFileDigests(workspacePath, stablePaths, intendedDigests);
  if (!before.ok) return { ...before, phase: "before" };
  const value = await action();
  const after = await verifyFileDigests(workspacePath, stablePaths, intendedDigests);
  return after.ok
    ? { ok: true, phase: "after", value }
    : { ...after, phase: "after", value };
}

const NON_DELIVERABLE_DIRS = new Set([
  ".git",
  "node_modules",
  ".pnpm-store",
  "dist",
  "build",
  "coverage",
  ".next",
  "out",
]);

function workspaceFilesWithoutGit(root: string): string[] {
  const files: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!NON_DELIVERABLE_DIRS.has(entry.name)) stack.push(absolute);
      } else if (entry.isFile()) {
        const path = canonical(relative(root, absolute));
        if (path) files.push(path);
      }
    }
  }
  return files;
}

/**
 * Verification must run against the same repository state that will be
 * delivered. A test/build command may not quietly rewrite or create an
 * unlisted tracked artifact and then leave that dependency out of the commit.
 */
export function findUnexpectedWorkspaceChanges(
  workspacePath: string,
  allowedPaths: Iterable<string>,
): string[] {
  const allowed = new Set([...allowedPaths].map(canonical));
  let hasHead = true;
  try {
    execFileSync("git", ["-C", workspacePath, "rev-parse", "--verify", "HEAD"], {
      encoding: "utf8",
      timeout: 30_000,
    });
  } catch {
    hasHead = false;
  }
  if (!hasHead) {
    return workspaceFilesWithoutGit(workspacePath)
      .filter((path) => !allowed.has(path))
      .sort();
  }

  const run = (args: string[]): string => {
    try {
      return execFileSync("git", ["-C", workspacePath, ...args], {
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (error) {
      throw new Error(
        `Cannot establish a clean verification tree: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };
  const changed = [
    ...run(["diff", "--name-only", "-z", "HEAD"]).split("\0"),
    ...run(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0"),
  ]
    .filter(Boolean)
    .map(canonical)
    .filter(Boolean);
  return [...new Set(changed.filter((path) => !allowed.has(path)))].sort();
}
