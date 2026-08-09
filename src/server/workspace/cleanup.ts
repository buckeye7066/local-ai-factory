import { rm } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";

/**
 * cleanup.ts — rollback helper: delete a job worktree only when it is jailed
 * under WORKSPACE_ROOT. Never touches source trees outside that root.
 */

function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export async function rollbackWorkspace(
  workspaceRoot: string,
  worktreePath: string | null | undefined,
): Promise<{ ok: boolean; reason?: string }> {
  if (!worktreePath) return { ok: false, reason: "No worktree path." };
  const root = resolve(workspaceRoot);
  const target = resolve(worktreePath);
  if (!isInside(root, target) || target === root) {
    return { ok: false, reason: "Refused: worktree escapes WORKSPACE_ROOT." };
  }
  await rm(target, { recursive: true, force: true });
  return { ok: true };
}
