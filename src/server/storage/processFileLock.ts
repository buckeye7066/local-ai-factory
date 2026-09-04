import { randomUUID } from "node:crypto";
import { constants as FS } from "node:fs";
import { lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Crash-recoverable cross-process file lock.
 *
 * Contenders never share an owner pathname. Each creates a UUID-bound owner
 * receipt, then appends that UUID to an immutable ticket log in one O_APPEND
 * write. The append order is the ownership order. New arrivals therefore
 * cannot jump ahead of a waiter, and stale recovery only removes the abandoned
 * UUID pathname, never a replacement owner that appeared after inspection.
 */

const HAS_NOFOLLOW = typeof FS.O_NOFOLLOW === "number" && FS.O_NOFOLLOW !== 0;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OWNER_PATTERN = /^owner\.(\d+)\.([0-9a-f-]{36})\.json$/i;
const TICKET_LOG = "tickets.log";

export type ProcessFileLease = {
  token: string;
  release: () => Promise<void>;
};

export type ProcessFileLockOptions = {
  timeoutMs?: number;
  pollMs?: number;
  staleGraceMs?: number;
};

type OwnerReceipt = {
  version: 1;
  pid: number;
  createdAt: number;
  token: string;
};

type ActiveOwner = OwnerReceipt & {
  path: string;
  ticket: number;
};

type TicketCache = {
  identity: string;
  offset: number;
  carry: string;
  nextTicket: number;
  order: Map<string, number>;
};

const ticketCaches = new Map<string, TicketCache>();

function queuePath(lockPath: string): string {
  return `${resolve(lockPath)}.owners`;
}

function ownerName(pid: number, token: string): string {
  return `owner.${pid}.${token}.json`;
}

function ticketLogPath(queue: string): string {
  return resolve(queue, TICKET_LOG);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ESRCH" && code !== "EINVAL";
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, FS.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureQueue(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  const queueStat = await lstat(path);
  if (queueStat.isSymbolicLink() || !queueStat.isDirectory()) {
    throw new Error("Refused: process-lock queue is not a real directory.");
  }
}

async function writeExclusiveOwner(path: string, receipt: OwnerReceipt): Promise<void> {
  const flags =
    FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | (HAS_NOFOLLOW ? FS.O_NOFOLLOW : 0);
  const handle = await open(path, flags, 0o600);
  try {
    await handle.writeFile(JSON.stringify(receipt), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function appendTicket(queue: string, token: string): Promise<void> {
  const path = ticketLogPath(queue);
  const flags =
    FS.O_WRONLY | FS.O_CREAT | FS.O_APPEND | (HAS_NOFOLLOW ? FS.O_NOFOLLOW : 0);
  const handle = await open(path, flags, 0o600);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error("Refused: process-lock ticket log is not a regular file.");
    }
    const record = Buffer.from(`${token}\n`, "utf8");
    const written = await handle.write(record, 0, record.length, null);
    if (written.bytesWritten !== record.length) {
      throw new Error("Refused: process-lock ticket write was incomplete.");
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(queue);
}

function resetTicketCache(identity: string): TicketCache {
  return {
    identity,
    offset: 0,
    carry: "",
    nextTicket: 1,
    order: new Map<string, number>(),
  };
}

/** Read only ticket bytes this process has not parsed yet. */
async function readTicketOrder(queue: string): Promise<Map<string, number>> {
  const path = ticketLogPath(queue);
  const flags = FS.O_RDONLY | (HAS_NOFOLLOW ? FS.O_NOFOLLOW : 0);
  let handle;
  try {
    handle = await open(path, flags);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      ticketCaches.delete(queue);
      return new Map<string, number>();
    }
    throw error;
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error("Refused: process-lock ticket log is not a regular file.");
    }
    const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    let cache = ticketCaches.get(queue);
    if (!cache || cache.identity !== identity || stat.size < cache.offset) {
      cache = resetTicketCache(identity);
      ticketCaches.set(queue, cache);
    }

    const unread = stat.size - cache.offset;
    if (unread > 0) {
      const buffer = Buffer.allocUnsafe(unread);
      const result = await handle.read(buffer, 0, unread, cache.offset);
      cache.offset += result.bytesRead;
      const text = cache.carry + buffer.subarray(0, result.bytesRead).toString("utf8");
      const lines = text.split("\n");
      cache.carry = lines.pop() ?? "";
      for (const line of lines) {
        const token = line.trim();
        if (!UUID_PATTERN.test(token) || cache.order.has(token)) continue;
        cache.order.set(token, cache.nextTicket);
        cache.nextTicket += 1;
      }
    }
    return cache.order;
  } finally {
    await handle.close();
  }
}

function parseOwnerFilename(name: string): Pick<OwnerReceipt, "pid" | "token"> | null {
  const match = OWNER_PATTERN.exec(name);
  if (!match) return null;
  const pid = Number(match[1]);
  const token = match[2]!;
  if (!Number.isSafeInteger(pid) || pid <= 0 || !UUID_PATTERN.test(token)) {
    return null;
  }
  return { pid, token };
}

function parseOwnerReceipt(
  raw: string,
  filename: Pick<OwnerReceipt, "pid" | "token">,
): OwnerReceipt | null {
  try {
    const value = JSON.parse(raw) as Partial<OwnerReceipt>;
    if (
      value.version !== 1 ||
      value.pid !== filename.pid ||
      value.token !== filename.token ||
      typeof value.createdAt !== "number" ||
      !Number.isFinite(value.createdAt)
    ) {
      return null;
    }
    return value as OwnerReceipt;
  } catch {
    return null;
  }
}

async function readOwner(path: string): Promise<{ raw: string; mtimeMs: number }> {
  const flags = FS.O_RDONLY | (HAS_NOFOLLOW ? FS.O_NOFOLLOW : 0);
  const handle = await open(path, flags);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error("Refused: process-lock owner is not a regular file.");
    }
    return { raw: await handle.readFile("utf8"), mtimeMs: stat.mtimeMs };
  } finally {
    await handle.close();
  }
}

async function removeUniqueOwner(path: string, queue: string): Promise<void> {
  // The filename contains a random UUID generated by its sole owner. No later
  // legitimate owner reuses it, so this cannot erase a replacement lease.
  await rm(path, { force: true });
  await syncDirectory(queue);
}

async function scanActiveOwners(
  queue: string,
  staleGraceMs: number,
  tickets: ReadonlyMap<string, number>,
): Promise<ActiveOwner[]> {
  const owners: ActiveOwner[] = [];
  for (const name of await readdir(queue)) {
    if (name === TICKET_LOG) continue;
    const filename = parseOwnerFilename(name);
    if (!filename) continue;
    const path = resolve(queue, name);
    let read: { raw: string; mtimeMs: number };
    try {
      read = await readOwner(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }

    const receipt = parseOwnerReceipt(read.raw, filename);
    const createdAt = receipt?.createdAt ?? read.mtimeMs;
    const ageMs = Date.now() - createdAt;
    if (ageMs >= staleGraceMs && !processIsAlive(filename.pid)) {
      await removeUniqueOwner(path, queue);
      continue;
    }

    const ticket = tickets.get(filename.token);
    if (ticket === undefined) {
      // The owner receipt is created before its ticket append. Until the append
      // happens it cannot own the lock, and when it does it necessarily receives
      // a later position than every ticket already visible here.
      if (!receipt && ageMs >= staleGraceMs) {
        await removeUniqueOwner(path, queue);
      }
      continue;
    }

    owners.push({
      version: 1,
      pid: filename.pid,
      token: filename.token,
      createdAt,
      path,
      ticket,
    });
  }
  return owners;
}

/** Acquire a crash-recoverable cross-process lease, or return null on timeout. */
export async function acquireProcessFileLock(
  lockPath: string,
  options: ProcessFileLockOptions = {},
): Promise<ProcessFileLease | null> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const pollMs = options.pollMs ?? 5;
  const staleGraceMs = options.staleGraceMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new TypeError("process-lock timeout must be a non-negative number");
  }
  if (!Number.isFinite(pollMs) || pollMs < 1) {
    throw new TypeError("process-lock poll interval must be at least 1 ms");
  }
  if (!Number.isFinite(staleGraceMs) || staleGraceMs < 0) {
    throw new TypeError("process-lock stale grace must be a non-negative number");
  }

  const queue = queuePath(lockPath);
  await ensureQueue(queue);
  const token = randomUUID();
  const createdAt = Date.now();
  const ownerPath = resolve(queue, ownerName(process.pid, token));
  let leaseReturned = false;

  try {
    await writeExclusiveOwner(ownerPath, {
      version: 1,
      pid: process.pid,
      createdAt,
      token,
    });
    await syncDirectory(queue);
    await appendTicket(queue, token);

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let tickets = await readTicketOrder(queue);
      let ownTicket = tickets.get(token);
      if (ownTicket === undefined) {
        // A queue can be removed and recreated at the same path while this
        // process still holds an incremental parser cache. Filesystems may
        // recycle inode numbers, so a missing token is the authoritative cue
        // to discard the cache and re-read the immutable log from byte zero.
        ticketCaches.delete(queue);
        tickets = await readTicketOrder(queue);
        ownTicket = tickets.get(token);
      }
      if (ownTicket === undefined) {
        throw new Error("Refused: process-lock ticket was not durably recorded.");
      }
      const owners = await scanActiveOwners(queue, staleGraceMs, tickets);
      if (!owners.some((owner) => owner.token === token)) {
        throw new Error("Refused: process-lock ownership receipt disappeared.");
      }
      if (!owners.some((owner) => owner.token !== token && owner.ticket < ownTicket)) {
        let released = false;
        leaseReturned = true;
        return {
          token,
          release: async () => {
            if (released) return;
            released = true;
            await removeUniqueOwner(ownerPath, queue);
          },
        };
      }
      if (Date.now() >= deadline) return null;
      await new Promise((resolveWait) => setTimeout(resolveWait, pollMs));
    }
  } finally {
    if (!leaseReturned) {
      await removeUniqueOwner(ownerPath, queue).catch(() => {});
    }
  }
}

export function _processLockQueuePathForTests(lockPath: string): string {
  return queuePath(lockPath);
}
