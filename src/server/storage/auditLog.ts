import { createHash } from "node:crypto";
import { mkdir, appendFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { redactSecrets } from "../security/redact.js";

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
let loaded = false;
let chain: Promise<unknown> = Promise.resolve();

function hashLine(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}

/** Stable stringify so hash(input) == hash(JSON.parse(JSON.stringify(input))). */
function stableStringify(value: unknown): string {
  return JSON.stringify(value);
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await readFile(AUDIT_FILE, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const ev = JSON.parse(line) as AuditEvent;
        if (typeof ev.seq === "number") seq = Math.max(seq, ev.seq);
        if (typeof ev.hash === "string") lastHash = ev.hash;
      } catch {
        /* skip corrupt line */
      }
    }
  } catch {
    /* no file yet */
  }
}

export async function appendAuditEvent(input: AuditEventInput): Promise<AuditEvent> {
  const job = chain.then(async () => {
    await ensureLoaded();
    await mkdir(AUDIT_DIR, { recursive: true });
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
  });
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
  let prev = "genesis";
  try {
    const raw = await readFile(AUDIT_FILE, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    for (const line of lines) {
      const ev = JSON.parse(line) as AuditEvent;
      const { hash, ...rest } = ev;
      const expected = hashLine(stableStringify(rest));
      if (ev.prevHash !== prev || hash !== expected) {
        return { ok: false, badSeq: ev.seq };
      }
      prev = hash;
    }
  } catch {
    return { ok: true, badSeq: null };
  }
  return { ok: true, badSeq: null };
}

/** Test helper: reset in-memory cursor (does not delete the file). */
export function _resetAuditCursorForTests(): void {
  seq = 0;
  lastHash = "genesis";
  loaded = false;
}
