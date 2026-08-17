import { mkdir, open, stat } from "node:fs/promises";
import { constants, lstatSync, realpathSync } from "node:fs";
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

/**
 * Resolve a path and reject every symlink component. Existing targets are
 * additionally realpath-checked beneath the physical workspace root.
 */
export function safeResolveExistingPath(
  workspaceRoot: string,
  relativePath: string,
): string {
  const target = safeResolve(workspaceRoot, relativePath);
  const lexicalRoot = resolve(workspaceRoot);
  const rootStat = lstatSync(lexicalRoot);
  if (rootStat.isSymbolicLink()) {
    throw new WorkspacePathError("Workspace root may not be a symlink.");
  }
  const rel = relative(lexicalRoot, target);
  let cursor = lexicalRoot;
  for (const part of rel.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part);
    const info = lstatSync(cursor);
    if (info.isSymbolicLink()) {
      throw new WorkspacePathError(`Symlink traversal is not allowed: ${relativePath}`);
    }
  }
  const rootReal = realpathSync(lexicalRoot);
  const targetReal = realpathSync(target);
  const physical = relative(rootReal, targetReal);
  if (physical === "" || physical.startsWith("..") || isAbsolute(physical)) {
    throw new WorkspacePathError(
      `Path resolves outside the workspace boundary: ${relativePath}`,
    );
  }
  return target;
}

/** Resolve a writable path, rejecting symlinks among all components that exist. */
function safeResolveWritablePath(workspaceRoot: string, relativePath: string): string {
  const target = safeResolve(workspaceRoot, relativePath);
  const lexicalRoot = resolve(workspaceRoot);
  const rootStat = lstatSync(lexicalRoot);
  if (rootStat.isSymbolicLink()) {
    throw new WorkspacePathError("Workspace root may not be a symlink.");
  }
  const rel = relative(lexicalRoot, target);
  let cursor = lexicalRoot;
  for (const part of rel.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part);
    try {
      const info = lstatSync(cursor);
      if (info.isSymbolicLink()) {
        throw new WorkspacePathError(
          `Symlink traversal is not allowed: ${relativePath}`,
        );
      }
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code ?? "")
          : "";
      if (code === "ENOENT") break;
      throw error;
    }
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
  let abs = safeResolveWritablePath(workspaceRoot, relativePath);
  let existed = false;
  try {
    const info = await stat(abs);
    if (!info.isFile()) {
      throw new WorkspacePathError(
        `Write target is not a regular file: ${relativePath}`,
      );
    }
    existed = true;
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";
    if (code !== "ENOENT") throw error;
  }
  await mkdir(dirname(abs), { recursive: true });
  // Re-check after mkdir to close the ordinary create-parent symlink window.
  abs = safeResolveWritablePath(workspaceRoot, relativePath);
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const handle = await open(
    abs,
    constants.O_WRONLY | constants.O_CREAT | noFollow,
    0o666,
  );
  try {
    const opened = await handle.stat();
    if (opened.nlink > 1) {
      throw new WorkspacePathError(
        `Hard-linked write targets are not allowed: ${relativePath}`,
      );
    }
    await handle.truncate(0);
    await handle.writeFile(contents, "utf8");
  } finally {
    await handle.close();
  }
  const canonicalPath = relative(resolve(workspaceRoot), abs).split(sep).join("/");
  return {
    path: canonicalPath,
    size: Buffer.byteLength(contents, "utf8"),
    language: detectLanguage(canonicalPath),
    existed,
  };
}

export async function readWorkspaceFile(
  workspaceRoot: string,
  relativePath: string,
): Promise<string> {
  const abs = safeResolveExistingPath(workspaceRoot, relativePath);
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const handle = await open(abs, constants.O_RDONLY | noFollow);
  try {
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
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
