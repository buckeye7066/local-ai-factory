import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { constants as FS } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, join } from "node:path";
import { isValidRunId } from "../../shared/schemas.js";
import { writeFileContained } from "./runsStore.js";
import { acquireProcessFileLock, type ProcessFileLease } from "./processFileLock.js";

/**
 * idempotency.ts — durable, atomic client idempotency for POST /api/runs.
 *
 * Reservation and run creation are one operation. The first caller publishes a
 * durable O_EXCL receipt containing the exact run id before invoking startRun;
 * every concurrent caller observes that same receipt instead of starting a
 * second run.
 */

const DATA_ROOT = resolve(process.cwd(), process.env.FACTORY_DATA_DIR || ".factory");
const IDEM_DIR = join(DATA_ROOT, "idempotency");
const HASH_PATTERN = /^[a-f0-9]{32}$/;
const HAS_NOFOLLOW = typeof FS.O_NOFOLLOW === "number" && FS.O_NOFOLLOW !== 0;
const PENDING_RECOVERY_GRACE_MS = 30_000;

type IdempotencyRecord = {
  runId: string;
  ideaHash: string;
  createdAt: number;
  state: "pending" | "committed";
  claimToken: string;
};

const keyLocks = new Map<string, Promise<void>>();

function safeKeyFilename(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex");
  return `${hash}.json`;
}

function recordPath(key: string): string {
  return join(IDEM_DIR, safeKeyFilename(key));
}

function lockPath(key: string): string {
  return `${recordPath(key)}.lock`;
}

export function hashIdea(idea: string): string {
  return createHash("sha256").update(idea).digest("hex").slice(0, 32);
}

function parseRecord(raw: string): IdempotencyRecord {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Refused: idempotency receipt contains malformed JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Refused: idempotency receipt is not an object.");
  }
  const candidate = value as Partial<IdempotencyRecord>;
  const legacy = candidate.state === undefined && candidate.claimToken === undefined;
  if (
    !isValidRunId(candidate.runId ?? "") ||
    typeof candidate.ideaHash !== "string" ||
    !HASH_PATTERN.test(candidate.ideaHash) ||
    typeof candidate.createdAt !== "number" ||
    !Number.isFinite(candidate.createdAt) ||
    (!legacy && candidate.state !== "pending" && candidate.state !== "committed") ||
    (!legacy &&
      (typeof candidate.claimToken !== "string" || !isValidRunId(candidate.claimToken)))
  ) {
    throw new Error("Refused: idempotency receipt fields are invalid.");
  }
  // Records written before atomic reservations were introduced represent
  // completed starts and remain readable.
  return {
    runId: candidate.runId!,
    ideaHash: candidate.ideaHash,
    createdAt: candidate.createdAt,
    state: legacy ? "committed" : candidate.state!,
    claimToken: legacy ? candidate.runId! : candidate.claimToken!,
  };
}

function pathInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function syncIdempotencyDirectory(): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(IDEM_DIR, FS.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureIdempotencyDirectory(): Promise<void> {
  await mkdir(DATA_ROOT, { recursive: true });
  const rootStat = await lstat(DATA_ROOT);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Refused: Factory data root is not a real directory.");
  }
  await mkdir(IDEM_DIR, { recursive: true });
  const idemStat = await lstat(IDEM_DIR);
  if (idemStat.isSymbolicLink() || !idemStat.isDirectory()) {
    throw new Error("Refused: idempotency store is not a real directory.");
  }
  const [rootReal, idemReal] = await Promise.all([
    realpath(DATA_ROOT),
    realpath(IDEM_DIR),
  ]);
  if (!pathInside(rootReal, idemReal)) {
    throw new Error("Refused: idempotency store escapes the Factory data root.");
  }
}

async function acquireKeyLock(key: string): Promise<ProcessFileLease | null> {
  await ensureIdempotencyDirectory();
  return acquireProcessFileLock(lockPath(key), {
    timeoutMs: 10_000,
    pollMs: 5,
    staleGraceMs: 30_000,
  });
}

async function readRecordPath(path: string): Promise<IdempotencyRecord | null> {
  const flags = FS.O_RDONLY | (HAS_NOFOLLOW ? FS.O_NOFOLLOW : 0);
  let handle;
  try {
    handle = await open(path, flags);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error("Refused: idempotency receipt is not a regular file.");
    }
    return parseRecord(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

async function readRecord(key: string): Promise<IdempotencyRecord | null> {
  await ensureIdempotencyDirectory();
  const parsed = await readRecordPath(recordPath(key));
  return parsed;
}

async function withKeyLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = keyLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const queued = previous.catch(() => {}).then(() => gate);
  keyLocks.set(key, queued);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (keyLocks.get(key) === queued) keyLocks.delete(key);
  }
}

async function reserveRecord(
  key: string,
  ideaHash: string,
): Promise<{ record: IdempotencyRecord; created: boolean }> {
  await ensureIdempotencyDirectory();
  const path = recordPath(key);
  const record: IdempotencyRecord = {
    runId: randomUUID(),
    ideaHash,
    createdAt: Date.now(),
    state: "pending",
    claimToken: randomUUID(),
  };
  const flags =
    FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | (HAS_NOFOLLOW ? FS.O_NOFOLLOW : 0);
  try {
    const handle = await open(path, flags, 0o600);
    try {
      await handle.writeFile(JSON.stringify(record), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncIdempotencyDirectory();
    return { record, created: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readRecordPath(path);
    if (!existing) {
      throw new Error("Refused: idempotency receipt vanished during reservation.");
    }
    return { record: existing, created: false };
  }
}

export type IdempotentStartResult<T> =
  | { status: "created"; runId: string; value: T }
  | { status: "existing"; runId: string }
  | { status: "pending"; runId: string }
  | { status: "conflict"; runId: string };

export type DurableRunInspector = (runId: string) => Promise<"present" | "missing">;

/**
 * Atomically reserve a run id and start exactly one run for a key/idea pair.
 * The callback must use the supplied id and return a value carrying that id.
 */
export async function startIdempotently<T extends { id: string }>(
  key: string,
  idea: string,
  create: (reservedRunId: string) => T | Promise<T>,
  inspectDurableRun?: DurableRunInspector,
): Promise<IdempotentStartResult<T>> {
  return withKeyLock(key, async () => {
    const ideaHash = hashIdea(idea);
    const lockLease = await acquireKeyLock(key);
    if (!lockLease) {
      const occupied = await readRecord(key);
      if (!occupied) {
        throw new Error("Refused: idempotency ownership lock remained occupied.");
      }
      if (occupied.ideaHash !== ideaHash) {
        return { status: "conflict", runId: occupied.runId };
      }
      return occupied.state === "committed"
        ? { status: "existing", runId: occupied.runId }
        : { status: "pending", runId: occupied.runId };
    }
    try {
      const known = await readRecord(key);
      if (known?.ideaHash !== undefined && known.ideaHash !== ideaHash) {
        return { status: "conflict", runId: known.runId };
      }
      if (known?.state === "committed") {
        return { status: "existing", runId: known.runId };
      }

      let record: IdempotencyRecord;
      if (known) {
        if (!inspectDurableRun) {
          return { status: "pending", runId: known.runId };
        }
        const durableState = await inspectDurableRun(known.runId);
        if (durableState === "present") {
          const committed: IdempotencyRecord = { ...known, state: "committed" };
          await writeFileContained(recordPath(key), JSON.stringify(committed));
          return { status: "existing", runId: known.runId };
        }
        if (Date.now() - known.createdAt < PENDING_RECOVERY_GRACE_MS) {
          return { status: "pending", runId: known.runId };
        }
        // The owner is gone (we hold its reclaimed lease), no durable run
        // exists, and the reservation is past its compatibility grace. Replay
        // with the SAME run id so the key's identity never changes.
        record = {
          ...known,
          createdAt: Date.now(),
          claimToken: randomUUID(),
          state: "pending",
        };
        await writeFileContained(recordPath(key), JSON.stringify(record));
      } else {
        const reservation = await reserveRecord(key, ideaHash);
        if (!reservation.created) {
          if (reservation.record.ideaHash !== ideaHash) {
            return { status: "conflict", runId: reservation.record.runId };
          }
          return reservation.record.state === "committed"
            ? { status: "existing", runId: reservation.record.runId }
            : { status: "pending", runId: reservation.record.runId };
        }
        record = reservation.record;
      }

      let callbackReturned = false;
      try {
        const value = await create(record.runId);
        callbackReturned = true;
        if (value.id !== record.runId) {
          throw new Error(
            "Refused: idempotent run starter did not use its reserved run id.",
          );
        }
        const committed: IdempotencyRecord = { ...record, state: "committed" };
        await writeFileContained(recordPath(key), JSON.stringify(committed));
        return { status: "created", runId: committed.runId, value };
      } catch (error) {
        // Once the callback returned, a durable run exists. Preserve pending
        // if publishing the committed marker failed; the next owner probes and
        // promotes it without starting a duplicate.
        if (!callbackReturned && !inspectDurableRun) {
          // Callers without a durable run store can prove that a thrown starter
          // created nothing, so their reservation is retryable immediately.
          const current = await readRecordPath(recordPath(key)).catch(() => null);
          if (current?.claimToken === record.claimToken) {
            await rm(recordPath(key), { force: true });
            await syncIdempotencyDirectory();
          }
        }
        // A production starter supplies inspectDurableRun. Its initial save can
        // fail while the background failure path is still persisting the same
        // reserved id. Preserve pending unconditionally in that case: retries
        // either promote the durable run or, after the recovery grace, replay
        // the SAME identity. They can never allocate a second run id.
        throw error;
      }
    } finally {
      await lockLease.release();
    }
  });
}

/** Compatibility lookup for callers reading records without starting a run. */
export async function lookupIdempotency(
  key: string,
  idea: string,
): Promise<{ runId: string } | null> {
  const record = await readRecord(key);
  return record?.ideaHash === hashIdea(idea) ? { runId: record.runId } : null;
}

/** True when the key exists but was used with a different idea (HTTP 409). */
export async function isIdempotencyConflict(
  key: string,
  idea: string,
): Promise<boolean> {
  const record = await readRecord(key);
  return Boolean(record && record.ideaHash !== hashIdea(idea));
}

/** Test helper: clear process-local receipt and lock caches. */
export function _resetIdempotencyForTests(): void {
  keyLocks.clear();
}
