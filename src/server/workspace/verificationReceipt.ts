import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { posix } from "node:path";
import { readWorkspaceFile } from "./fileWriter.js";

function canonical(path: string): string {
  return posix.normalize(path.replace(/\\/g, "/")).replace(/^\.\/+/, "");
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
      reason: "verification receipt is missing paths or belongs to another deliverable set",
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
  try {
    execFileSync(
      "git",
      ["-C", workspacePath, "rev-parse", "--verify", "HEAD"],
      { encoding: "utf8", timeout: 30_000 },
    );
  } catch {
    return []; // new-app workspace with no committed git baseline
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
    .map(canonical)
    .filter(Boolean);
  return [...new Set(changed.filter((path) => !allowed.has(path)))].sort();
}
