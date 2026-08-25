import { mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { constants, lstatSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
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

interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

function identityOf(info: {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}): FileIdentity {
  return {
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
  };
}

function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}

async function syncDirectoryBestEffort(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, constants.O_RDONLY).catch(() => null);
  if (!handle) return;
  try {
    await handle.sync().catch(() => {});
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Write a single file inside the workspace, creating parent dirs as needed. */
export async function writeWorkspaceFile(
  workspaceRoot: string,
  relativePath: string,
  contents: string,
): Promise<WriteResult> {
  let abs = safeResolveWritablePath(workspaceRoot, relativePath);
  let existed = false;
  let originalIdentity: FileIdentity | null = null;
  let originalMode = 0o666;
  try {
    const info = await stat(abs);
    if (!info.isFile()) {
      throw new WorkspacePathError(
        `Write target is not a regular file: ${relativePath}`,
      );
    }
    if (info.nlink > 1) {
      throw new WorkspacePathError(
        `Hard-linked write targets are not allowed: ${relativePath}`,
      );
    }
    existed = true;
    originalIdentity = identityOf(info);
    originalMode = info.mode & 0o777;
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
  const root = resolve(workspaceRoot);
  // Keep this independent of the target basename. A valid near-NAME_MAX file
  // must not become unwritable merely because the atomic sibling adds a long
  // suffix to that basename.
  const tempName = `.factory-${process.pid}-${randomUUID()}.tmp`;
  const tempAbs = resolve(dirname(abs), tempName);
  // The temporary file is derived from a contained target, but run it through
  // the same boundary check so future path changes cannot weaken that fact.
  safeResolveWritablePath(root, relative(root, tempAbs));
  const handle = await open(
    tempAbs,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
    originalMode,
  );
  let committed = false;
  try {
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1) {
        throw new WorkspacePathError(
          `Atomic write temporary is not a private regular file: ${relativePath}`,
        );
      }
      await handle.writeFile(contents, "utf8");
      if (existed) await handle.chmod(originalMode);
      await handle.sync();
    } finally {
      await handle.close();
    }

    // Refuse a concurrent target replacement instead of overwriting an editor
    // or another factory process that changed the path while the temp was built.
    abs = safeResolveWritablePath(workspaceRoot, relativePath);
    const current = await stat(abs).catch((error: unknown) => {
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code ?? "")
          : "";
      if (code === "ENOENT") return null;
      throw error;
    });
    if (originalIdentity) {
      if (
        !current ||
        !current.isFile() ||
        current.nlink > 1 ||
        !sameIdentity(originalIdentity, identityOf(current))
      ) {
        throw new WorkspacePathError(
          `Write target changed while preparing atomic replacement: ${relativePath}`,
        );
      }
    } else if (current) {
      throw new WorkspacePathError(
        `Write target appeared while preparing atomic creation: ${relativePath}`,
      );
    }
    await rename(tempAbs, abs);
    committed = true;
    await syncDirectoryBestEffort(dirname(abs));
  } finally {
    if (!committed) await unlink(tempAbs).catch(() => {});
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
