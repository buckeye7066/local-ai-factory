import { createHash } from "node:crypto";
import { constants as FS } from "node:fs";
import { mkdir, appendFile, open, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, join } from "node:path";
import { redactSecrets } from "../security/redact.js";
import { acquireProcessFileLock } from "./processFileLock.js";

/**
 * auditLog.ts — append-only, tamper-evident audit events for Factory Deck jobs.
 *
 * Each event carries `prevHash` of the prior line's content hash, forming a
 * hash chain. Verification walks the file and recomputes. Credentials are
 * redacted before any event is written. Appends are serialized so concurrent
 * runs cannot interleave and break the chain.
 */

const DATA_ROOT = resolve(process.cwd(), process.env.FACTORY_DATA_DIR || ".factory");
const AUDIT_DIR = join(DATA_ROOT, "audit");
const AUDIT_FILE = join(AUDIT_DIR, "events.jsonl");
const AUDIT_LOCK = join(AUDIT_DIR, ".append.lock");
const ATTRIBUTION_DIR = join(DATA_ROOT, "attribution");
const HAS_NOFOLLOW = typeof FS.O_NOFOLLOW === "number" && FS.O_NOFOLLOW !== 0;

export type AuditEventType =
  | "run.queued"
  | "run.started"
  | "run.resumed"
  | "run.completed"
  | "run.failed"
  | "run.cancelled"
  | "run.timeout"
  | "run.budget_exhausted"
  | "run.verification.held"
  | "run.readiness.blocked"
  | "run.readiness.pre_release_approved"
  | "run.readiness.ready"
  | "workspace.created"
  | "attribution.written"
  | "idempotency.hit"
  | "cleanup.workspace"
  // Deleting a run is a destructive, owner-initiated action — it belongs in the
  // tamper-evident chain alongside the run's own lifecycle.
  | "run.deleted"
  // Delivery: where a completed run's work was saved, and whether it landed.
  | "run.delivery.delivered"
  | "run.delivery.failed"
  | "run.delivery.skipped"
  | "run.delivery.planned"
  | "run.release.merged"
  // The PR is open with auto-merge armed and the host repo's checks are still
  // running — neither merged nor held. A distinct event because collapsing it
  // into either of the other two makes the audit trail lie about the trunk.
  | "run.release.pending"
  | "run.release.held"
  | "run.deploy.live"
  | "run.deploy.held"
  // Store: the app was posted to the owner's axiombiolabs.org App Store
  // registry (and PromoPilot picks it up from the same registry).
  | "run.store.listed"
  | "run.store.held"
  // Epics: large evolutions run as ordered slices, one released at a time.
  | "epic.created"
  | "epic.paused"
  | "epic.slice.released"
  | "epic.completed";

export interface AuditEventInput {
  type: AuditEventType;
  runId: string;
  detail?: string;
  meta?: Record<string, string | number | boolean | null>;
}

export interface AuditEvent extends AuditEventInput {
  seq: number;
  ts: number;
  prevHash: string;
  hash: string;
}

let seq = 0;
let lastHash = "genesis";
let chain: Promise<unknown> = Promise.resolve();

function hashLine(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}

/** Stable stringify so hash(input) == hash(JSON.parse(JSON.stringify(input))). */
function stableStringify(value: unknown): string {
  return JSON.stringify(value);
}

type AuditInspection =
  | { ok: true; seq: number; lastHash: string }
  | { ok: false; badSeq: number | null; reason: string };

function invalidAudit(
  badSeq: number | null,
  reason: string,
): Extract<AuditInspection, { ok: false }> {
  return { ok: false, badSeq, reason };
}

function pathInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function verifyAttributionBinding(
  event: Partial<AuditEvent>,
): Promise<string | null> {
  if (event.type !== "attribution.written") return null;
  const digest = event.meta?.manifestSha256;
  // Older audit events predate byte binding. New writers always include the
  // digest, and removing it later would itself break the audit hash chain.
  if (digest === undefined) return null;
  if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) {
    return "attribution event contains an invalid manifest digest";
  }
  if (typeof event.detail !== "string" || !pathInside(ATTRIBUTION_DIR, event.detail)) {
    return "attribution event points outside the attribution store";
  }
  const flags = FS.O_RDONLY | (HAS_NOFOLLOW ? FS.O_NOFOLLOW : 0);
  let handle;
  try {
    handle = await open(event.detail, flags);
    const stat = await handle.stat();
    if (!stat.isFile()) return "attribution manifest is not a regular file";
    const raw = await handle.readFile("utf8");
    if (hashLine(raw) !== digest)
      return "attribution manifest digest does not match audit";
  } catch (error) {
    return `attribution manifest could not be verified: ${String(error)}`;
  } finally {
    await handle?.close().catch(() => {});
  }
  return null;
}

/**
 * Parse and verify every byte already on disk before trusting its cursor.
 * A malformed/truncated JSON line is evidence loss, not an empty audit log.
 */
async function inspectAuditFile(): Promise<AuditInspection> {
  let raw: string;
  try {
    raw = await readFile(AUDIT_FILE, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, seq: 0, lastHash: "genesis" };
    }
    return invalidAudit(null, `audit log could not be read: ${String(error)}`);
  }

  const lines = raw.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let prev = "genesis";
  const attributionEvents: Array<{ event: Partial<AuditEvent>; seq: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const expectedSeq = index + 1;
    const line = lines[index]!;
    if (!line.trim()) {
      return invalidAudit(expectedSeq, "audit log contains an empty record");
    }
    let unknownEvent: unknown;
    try {
      unknownEvent = JSON.parse(line);
    } catch {
      return invalidAudit(expectedSeq, "audit log contains malformed JSON");
    }
    if (
      !unknownEvent ||
      typeof unknownEvent !== "object" ||
      Array.isArray(unknownEvent)
    ) {
      return invalidAudit(expectedSeq, "audit record is not an object");
    }
    const ev = unknownEvent as Partial<AuditEvent>;
    if (
      ev.seq !== expectedSeq ||
      typeof ev.ts !== "number" ||
      !Number.isFinite(ev.ts) ||
      typeof ev.type !== "string" ||
      typeof ev.runId !== "string" ||
      typeof ev.prevHash !== "string" ||
      typeof ev.hash !== "string"
    ) {
      return invalidAudit(expectedSeq, "audit record fields are invalid");
    }
    const { hash, ...rest } = ev;
    const expectedHash = hashLine(stableStringify(rest));
    if (ev.prevHash !== prev || hash !== expectedHash) {
      return invalidAudit(expectedSeq, "audit hash chain is invalid");
    }
    if (ev.type === "attribution.written") {
      attributionEvents.push({ event: ev, seq: expectedSeq });
    }
    prev = hash;
  }

  // Manifests are independent external receipts. Verify them concurrently so
  // append latency does not grow as the sum of every historical disk read,
  // while still refusing to trust or extend a ledger with any altered receipt.
  const attributionResults = await Promise.all(
    attributionEvents.map(async ({ event, seq: eventSeq }) => ({
      seq: eventSeq,
      problem: await verifyAttributionBinding(event),
    })),
  );
  const invalidAttribution = attributionResults.find(({ problem }) => problem);
  if (invalidAttribution?.problem) {
    return invalidAudit(invalidAttribution.seq, invalidAttribution.problem);
  }
  return { ok: true, seq: lines.length, lastHash: prev };
}

async function ensureLoaded(): Promise<void> {
  const inspected = await inspectAuditFile();
  if (!inspected.ok) {
    throw new Error(
      `Refused to append to corrupt audit chain${inspected.badSeq === null ? "" : ` at sequence ${inspected.badSeq}`}: ${inspected.reason}.`,
    );
  }
  // Refresh from the verified on-disk tail while holding the cross-process
  // append lock. A second Factory process may have extended the valid chain.
  seq = inspected.seq;
  lastHash = inspected.lastHash;
}

async function withAuditLock<T>(operation: () => Promise<T>): Promise<T> {
  await mkdir(AUDIT_DIR, { recursive: true });
  const lease = await acquireProcessFileLock(AUDIT_LOCK, {
    timeoutMs: 10_000,
    pollMs: 5,
    staleGraceMs: 30_000,
  });
  if (!lease) {
    throw new Error("Refused: audit append lock remained occupied.");
  }
  try {
    return await operation();
  } finally {
    await lease.release();
  }
}

export async function appendAuditEvent(input: AuditEventInput): Promise<AuditEvent> {
  const job = chain.then(() =>
    withAuditLock(async () => {
      await ensureLoaded();
      seq += 1;
      const body: Omit<AuditEvent, "hash"> = {
        type: input.type,
        runId: input.runId,
        detail: input.detail ? redactSecrets(input.detail) : undefined,
        meta: input.meta,
        seq,
        ts: Date.now(),
        prevHash: lastHash,
      };
      // Drop undefined keys so parse→stringify round-trips match.
      const compact = JSON.parse(stableStringify(body)) as Omit<AuditEvent, "hash">;
      const hash = hashLine(stableStringify(compact));
      const event: AuditEvent = { ...compact, hash };
      lastHash = hash;
      await appendFile(AUDIT_FILE, `${stableStringify(event)}\n`, "utf8");
      return event;
    }),
  );
  chain = job.catch(() => {});
  return job;
}

/** Verify the on-disk chain; returns first bad seq or null if intact. */
export async function verifyAuditChain(): Promise<{
  ok: boolean;
  badSeq: number | null;
}> {
  // Wait for in-flight appends so verification sees a consistent file.
  await chain.catch(() => {});
  const inspected = await withAuditLock(inspectAuditFile);
  return inspected.ok
    ? { ok: true, badSeq: null }
    : { ok: false, badSeq: inspected.badSeq };
}

/** Test helper: reset in-memory cursor (does not delete the file). */
export function _resetAuditCursorForTests(): void {
  seq = 0;
  lastHash = "genesis";
}
