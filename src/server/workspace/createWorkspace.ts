import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";

/**
 * createWorkspace.ts — allocate an isolated directory for one run's generated
 * app. All workspaces live under WORKSPACE_ROOT; a run never touches anything
 * outside its own directory.
 */

/** Turn an app idea + run id into a stable, filesystem-safe folder name. */
export function workspaceSlug(appName: string, runId: string): string {
  const base = appName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const shortId = runId.slice(0, 8);
  return `${base || "app"}-${shortId}`;
}

export interface Workspace {
  /** Absolute path to this run's workspace directory. */
  path: string;
  slug: string;
}

export async function createWorkspace(
  workspaceRoot: string,
  appName: string,
  runId: string,
): Promise<Workspace> {
  const slug = workspaceSlug(appName, runId);
  const path = resolve(join(workspaceRoot, slug));
  await mkdir(path, { recursive: true });
  return { path, slug };
}
