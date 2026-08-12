import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  lstat,
  realpath,
  open,
} from "node:fs/promises";
import { constants as FS } from "node:fs";
import { resolve, join, relative, isAbsolute, sep } from "node:path";
import { z } from "zod";
import type { RunRecord, RunSummary, FileContent } from "../../shared/schemas.js";
import type { FactoryCheckpoint } from "../orchestrator/checkpoint.js";
import { FactoryCheckpointSchema } from "../orchestrator/checkpoint.js";
import {
  RunRecordSchema,
  FileContentSchema,
  isValidRunId,
} from "../../shared/schemas.js";
import {
  redactSecrets,
  sanitizeRunRecordForServe,
  sanitizeFileRecords,
} from "../security/redact.js";

/**
 * runsStore.ts — local JSON persistence for run history.
 *
 * Active runs live in memory for fast polling; every mutation is also flushed
 * to `.factory/runs/<id>.json` so history survives a restart. Generated file
 * *contents* are stored separately and never auto-shipped to the browser.
 */

const DATA_ROOT = resolve(process.cwd(), process.env.FACTORY_DATA_DIR || ".factory");
const STORE_DIR = join(DATA_ROOT, "runs");
const FILES_DIR = join(DATA_ROOT, "files");
const CHECKPOINTS_DIR = join(DATA_ROOT, "checkpoints");

const memory = new Map<string, RunRecord>();
const fileContents = new Map<string, FileContent[]>();

async function ensureDirs() {
  await mkdir(STORE_DIR, { recursive: true });
  await mkdir(FILES_DIR, { recursive: true });
  await mkdir(CHECKPOINTS_DIR, { recursive: true });
}

/** True when `child`'s resolved path is `parent` or beneath it (lexical). */
function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Symlink/realpath containment guard. Lexical containment (`storeFilePath`) is
 * not enough: if `.factory/runs` or `.factory/files` is a SYMLINK (or junction)
 * to another location, `writeFile`/`readFile` follow it and persistence escapes
 * the data root. We refuse a store dir that is a symlink, or whose REAL path
 * resolves outside the real data root.
 *
 * TOCTOU-SAFE: this RE-CHECKS the live filesystem on EVERY call — it caches
 * NOTHING. Caching a success would let an attacker pass the guard once then swap
 * a store dir to a symlink and have later writes reuse the stale "ok". Caching a
 * FAILURE would wedge the store until restart if the bad condition was transient
 * (e.g. a junction that gets removed). So we neither cache success nor latch
 * failure: while the unsafe condition exists we throw (fail closed), and once it
 * is gone the very next call revalidates and succeeds.
 */
async function guardStoreDirs(): Promise<void> {
  const rootReal = await realpath(DATA_ROOT).catch(() => null);
  if (!rootReal) return; // nothing created yet — nothing can have escaped
  for (const dir of [STORE_DIR, FILES_DIR, CHECKPOINTS_DIR]) {
    const st = await lstat(dir).catch(() => null);
    if (!st) continue; // not created yet
    if (st.isSymbolicLink()) {
      throw new Error(`Refused: store directory is a symlink: ${dir}`);
    }
    const real = await realpath(dir);
    if (!isInside(rootReal, real)) {
      throw new Error(
        `Refused: store directory resolves outside the data root: ${dir}`,
      );
    }
  }
}

/**
 * Build a `<dir>/<id>.json` path that is GUARANTEED to stay inside `dir`. A run
 * id must be a plain UUID (no separators, no `..`, not absolute); anything else
 * is refused so a crafted/corrupt id can never redirect a write outside the
 * store. This is the single choke point every persistence path goes through.
 */
function storeFilePath(dir: string, id: string): string {
  if (!isValidRunId(id)) {
    throw new Error(`Refused: invalid run id (not a UUID): ${JSON.stringify(id)}`);
  }
  const target = join(dir, `${id}.json`);
  const rel = relative(resolve(dir), resolve(target));
  if (rel.startsWith("..") || isAbsolute(rel) || rel.includes(sep)) {
    throw new Error(`Refused: run id escapes the store directory: ${id}`);
  }
  return target;
}

/**
 * Resolve a per-run json path AND refuse a symlinked target file: even inside a
 * contained dir, an individual `<id>.json` symlink would redirect the write/read
 * outside. Combined with `guardStoreDirs`, every persistence op is contained.
 */
async function safeStorePath(dir: string, id: string): Promise<string> {
  await guardStoreDirs();
  const p = storeFilePath(dir, id);
  const st = await lstat(p).catch(() => null);
  if (st?.isSymbolicLink()) {
    throw new Error(`Refused: run file is a symlink: ${p}`);
  }
  return p;
}

/** True when this platform can refuse to open a symlink at the final component. */
const HAS_NOFOLLOW = typeof FS.O_NOFOLLOW === "number" && FS.O_NOFOLLOW !== 0;

/**
 * Write `data` to `path` while NARROWING the lstat→write TOCTOU window: open the
 * final component with O_NOFOLLOW where the platform supports it (POSIX), then
 * re-check the opened fd (`fstat`) is a regular file before writing through it.
 *
 * HONEST RESIDUAL: Windows/Node exposes no O_NOFOLLOW, so if a local same-user
 * attacker swaps the final component to a symlink in the narrow window AFTER
 * `safeStorePath`'s lstat and BEFORE this open, the open follows it. Full
 * containment against adversarial same-user filesystem mutation requires
 * OS-level controls (restrictive permissions on the data dir). The fstat
 * re-check still rejects a swap to a non-regular-file (e.g. a directory).
 */
export async function writeFileContained(path: string, data: string): Promise<void> {
  const flags =
    FS.O_WRONLY | FS.O_CREAT | FS.O_TRUNC | (HAS_NOFOLLOW ? FS.O_NOFOLLOW : 0);
  const fh = await open(path, flags, 0o600);
  try {
    const st = await fh.stat();
    if (!st.isFile()) {
      throw new Error(`Refused: store target is not a regular file: ${path}`);
    }
    await fh.writeFile(data, "utf8");
  } finally {
    await fh.close();
  }
}

export async function saveRun(run: RunRecord): Promise<void> {
  // Containment first: never write (or cache) a record with an unsafe id.
  if (!isValidRunId(run.id)) {
    throw new Error(`Refused: invalid run id (not a UUID): ${JSON.stringify(run.id)}`);
  }
  memory.set(run.id, run);
  await ensureDirs();
  // Symlink/realpath + lexical containment (throws → caller rejects, fail closed).
  const target = await safeStorePath(STORE_DIR, run.id);
  // Compact JSON: these records are machine-read only, and pretty-printing
  // roughly doubles every run file written during high-frequency polling.
  await writeFileContained(target, JSON.stringify(run));
}

export function putRunInMemory(run: RunRecord): void {
  memory.set(run.id, run);
}

/**
 * A run loaded from disk in a non-terminal state means the server died (or was
 * closed) mid-run — the in-flight work is gone, so surface it honestly as
 * failed instead of showing a "running" ghost forever.
 */
async function normalizeLoaded(run: RunRecord): Promise<RunRecord> {
  if (run.status === "queued" || run.status === "running") {
    run.status = "failed";
    const hasCheckpoint = Boolean(await getRunCheckpoint(run.id));
    run.resumable = hasCheckpoint;
    run.error = hasCheckpoint
      ? "Interrupted: the backend restarted while this run was in progress. Resume continues from its last durable checkpoint."
      : "Interrupted: the backend restarted while this run was in progress, but no durable checkpoint was available. Start a new run.";
    run.currentStage = null;
    for (const stage of run.stages) {
      if (stage.status === "active") {
        stage.status = "pending";
        stage.startedAt = null;
        stage.endedAt = null;
        stage.durationMs = null;
      }
    }
    run.updatedAt = Date.now();
    // Persist the correction so it survives the next restart too.
    void saveRun(run).catch(() => {});
  }
  return run;
}

/**
 * Load the canonical mutable record for the orchestrator. Unlike getRun(), this
 * never returns a sanitized copy and therefore must not be used at an API serve
 * boundary.
 */
export async function getRunForExecution(id: string): Promise<RunRecord | null> {
  if (!isValidRunId(id)) return null;
  if (memory.has(id)) return memory.get(id)!;
  try {
    const raw = await readFile(await safeStorePath(STORE_DIR, id), "utf8");
    const parsed = RunRecordSchema.parse(JSON.parse(raw));
    if (parsed.id !== id) return null;
    const normalized = await normalizeLoaded(parsed);
    memory.set(id, normalized);
    return normalized;
  } catch {
    return null;
  }
}

export async function getRun(id: string): Promise<RunRecord | null> {
  // SERVE BOUNDARY: always return a redacted COPY (never the raw canonical /
  // raw-on-disk record). This scrubs OLD pre-fix records and PLANTED raw records.
  const run = await getRunForExecution(id);
  return run ? sanitizeRunRecordForServe(run) : null;
}

export async function listRuns(): Promise<RunSummary[]> {
  await ensureDirs();
  await guardStoreDirs(); // refuse a symlinked/escaping store dir before reading it
  const seen = new Map<string, RunRecord>(memory);
  try {
    const names = await readdir(STORE_DIR);
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = name.replace(/\.json$/, "");
      // Ignore any file whose stem is not a valid run id (can't be ours).
      if (!isValidRunId(id) || seen.has(id)) continue;
      try {
        // safeStorePath also refuses an individual symlinked <id>.json.
        const raw = await readFile(await safeStorePath(STORE_DIR, id), "utf8");
        const parsed = RunRecordSchema.parse(JSON.parse(raw));
        // A planted record with an id != its filename must never be loaded or
        // (via normalizeLoaded → saveRun) rewritten to the id's path.
        if (parsed.id !== id) continue;
        seen.set(id, await normalizeLoaded(parsed));
      } catch {
        // skip corrupt entries
      }
    }
  } catch {
    // no store yet
  }
  return [...seen.values()]
    .map((r) => ({
      id: r.id,
      // SERVE BOUNDARY: redact model/user-controlled strings in the summary too
      // (covers old/planted raw records loaded from disk).
      idea: redactSecrets(r.idea),
      status: r.status,
      resumable: r.resumable,
      demo: r.demo,
      codeProvider: r.codeProvider,
      reviewProvider: r.reviewProvider,
      appName: r.appName == null ? r.appName : redactSecrets(r.appName),
      workspacePath:
        r.workspacePath == null ? r.workspacePath : redactSecrets(r.workspacePath),
      repairLoops: r.repairLoops,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Retention: cap on-disk history so `.factory/` can't grow forever (run records
 * are small, but files/<id>.json holds full generated file contents). Keeps the
 * newest `keep` runs by file mtime and deletes older records together with
 * their saved file contents. Called once at server start; failures are
 * non-fatal — worst case the history just isn't pruned this boot.
 */
export async function pruneOldRuns(keep = 200): Promise<number> {
  await ensureDirs();
  try {
    await guardStoreDirs(); // never prune through a symlinked/escaping store dir
    // Only consider well-formed run files; ignore anything else in the dir.
    const names = (await readdir(STORE_DIR)).filter(
      (n) => n.endsWith(".json") && isValidRunId(n.replace(/\.json$/, "")),
    );
    if (names.length <= keep) return 0;
    // Resolve each path through safeStorePath BEFORE stat() so a symlinked
    // <id>.json is refused (never followed for metadata); such entries are
    // skipped entirely rather than pruned through the link.
    const stats: { id: string; mtime: number }[] = [];
    for (const n of names) {
      const id = n.replace(/\.json$/, "");
      try {
        const p = await safeStorePath(STORE_DIR, id);
        stats.push({ id, mtime: (await stat(p)).mtimeMs });
      } catch {
        // symlinked / refused entry — do not follow it, skip
      }
    }
    stats.sort((a, b) => b.mtime - a.mtime);
    const doomed = stats.slice(keep);
    let removed = 0;
    for (const { id } of doomed) {
      // Route deletes through the containment/symlink guard too.
      await rm(await safeStorePath(STORE_DIR, id), { force: true }).catch(() => {});
      await rm(await safeStorePath(FILES_DIR, id), { force: true }).catch(() => {});
      await rm(await safeStorePath(CHECKPOINTS_DIR, id), { force: true }).catch(() => {});
      removed++;
    }
    return removed;
  } catch {
    return 0;
  }
}

/** Persist private continuation state; never served by an API route. */
export async function saveRunCheckpoint(
  checkpoint: FactoryCheckpoint,
): Promise<void> {
  if (!isValidRunId(checkpoint.runId)) {
    throw new Error("Refused: invalid checkpoint run id.");
  }
  await ensureDirs();
  const target = await safeStorePath(CHECKPOINTS_DIR, checkpoint.runId);
  await writeFileContained(target, JSON.stringify(checkpoint));
}

export async function getRunCheckpoint(
  id: string,
): Promise<FactoryCheckpoint | null> {
  if (!isValidRunId(id)) return null;
  try {
    const raw = await readFile(await safeStorePath(CHECKPOINTS_DIR, id), "utf8");
    const parsed = FactoryCheckpointSchema.parse(JSON.parse(raw));
    return parsed.runId === id ? parsed : null;
  } catch {
    return null;
  }
}

export async function deleteRunCheckpoint(id: string): Promise<void> {
  if (!isValidRunId(id)) return;
  await ensureDirs();
  await rm(await safeStorePath(CHECKPOINTS_DIR, id), { force: true });
}

const FileContentListSchema = z.array(FileContentSchema);

export function saveRunFiles(id: string, files: FileContent[]): void {
  if (!isValidRunId(id)) return; // never write file contents for an unsafe id
  // Redact EVERY model-controlled string (contents AND path/purpose) in the
  // SERVED/persisted copy. The real file on disk in the workspace (the generated
  // product) is written raw elsewhere; this is only the copy shown in the Files
  // panel and served over the API, so a generated `.env` line like SECRET_KEY=...
  // — or a secret smuggled into a file path/purpose — must not be served raw.
  const redacted = sanitizeFileRecords(files);
  fileContents.set(id, redacted);
  // Also flush to disk so the Files panel survives a backend restart. Write
  // failures (incl. a refused symlinked/escaping store) are non-fatal — the
  // in-memory copy still serves the live run.
  void ensureDirs()
    .then(async () =>
      writeFileContained(await safeStorePath(FILES_DIR, id), JSON.stringify(redacted)),
    )
    .catch(() => {});
}

export async function getRunFiles(id: string): Promise<FileContent[]> {
  if (!isValidRunId(id)) return [];
  // SERVE BOUNDARY: sanitize whatever we return (cache or disk) so old/planted
  // raw file records are scrubbed on the way out (idempotent on already-redacted).
  const cached = fileContents.get(id);
  if (cached && cached.length) return sanitizeFileRecords(cached);
  try {
    const raw = await readFile(await safeStorePath(FILES_DIR, id), "utf8");
    const files = sanitizeFileRecords(FileContentListSchema.parse(JSON.parse(raw)));
    fileContents.set(id, files);
    return files;
  } catch {
    return [];
  }
}
