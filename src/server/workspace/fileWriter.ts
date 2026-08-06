import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { dirname, resolve, relative, isAbsolute, sep, extname } from "node:path";

/**
 * fileWriter.ts — the file-system safety boundary.
 *
 * SECURITY: Generated files may ONLY be written inside the run's workspace
 * directory. `safeResolve` rejects absolute paths and any path that escapes
 * the workspace root via "..". Every write goes through `writeWorkspaceFile`,
 * which calls `safeResolve` first. There is no code path that writes outside.
 */

export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

/**
 * Resolve `relativePath` against `workspaceRoot`, guaranteeing the result
 * stays inside the root. Throws WorkspacePathError otherwise.
 */
export function safeResolve(workspaceRoot: string, relativePath: string): string {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    throw new WorkspacePathError("Empty file path is not allowed.");
  }
  if (isAbsolute(relativePath)) {
    throw new WorkspacePathError(`Absolute paths are not allowed: ${relativePath}`);
  }
  const root = resolve(workspaceRoot);
  const target = resolve(root, relativePath);
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new WorkspacePathError(
      `Path escapes the workspace boundary: ${relativePath}`,
    );
  }
  // Extra guard against drive-letter games on Windows.
  if (!target.startsWith(root + sep) && target !== root) {
    throw new WorkspacePathError(
      `Path escapes the workspace boundary: ${relativePath}`,
    );
  }
  return target;
}

export interface WriteResult {
  path: string;
  size: number;
  language: string;
  existed: boolean;
}

/** Write a single file inside the workspace, creating parent dirs as needed. */
export async function writeWorkspaceFile(
  workspaceRoot: string,
  relativePath: string,
  contents: string,
): Promise<WriteResult> {
  const abs = safeResolve(workspaceRoot, relativePath);
  let existed = false;
  try {
    await stat(abs);
    existed = true;
  } catch {
    existed = false;
  }
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, contents, "utf8");
  return {
    path: relativePath.split(sep).join("/"),
    size: Buffer.byteLength(contents, "utf8"),
    language: detectLanguage(relativePath),
    existed,
  };
}

export async function readWorkspaceFile(
  workspaceRoot: string,
  relativePath: string,
): Promise<string> {
  const abs = safeResolve(workspaceRoot, relativePath);
  return readFile(abs, "utf8");
}

/** Map a file extension to a syntax-highlight-friendly language name. */
export function detectLanguage(path: string): string {
  const ext = extname(path).toLowerCase();
  const map: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "tsx",
    ".js": "javascript",
    ".jsx": "jsx",
    ".json": "json",
    ".css": "css",
    ".scss": "scss",
    ".html": "html",
    ".md": "markdown",
    ".yml": "yaml",
    ".yaml": "yaml",
    ".sh": "bash",
    ".env": "dotenv",
    ".sql": "sql",
  };
  if (path.toLowerCase().endsWith("readme.md")) return "markdown";
  return map[ext] ?? "text";
}
