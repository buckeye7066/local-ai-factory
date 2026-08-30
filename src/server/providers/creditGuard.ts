import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import type { CallIntent } from "../../shared/types.js";
import type { ProviderName } from "../../shared/schemas.js";
import { safeErrorMessage } from "../errors.js";
import {
  abandonPaidCall,
  reservePaidCall,
  settlePaidCall,
  type PaidCallReservation,
} from "./paidBudget.js";

/**
 * creditGuard.ts — an economic quality firewall around every production
 * Anthropic/OpenAI request made by Factory Deck or Purpose Foundry.
 *
 * What software can enforce:
 *  - no hidden SDK retries;
 *  - no repeated paid call for an identical request after a rejected result;
 *  - no paid-provider retry loop for malformed or schema-invalid output;
 *  - deterministic quality checks before an output is accepted locally;
 *  - an append-only receipt and a dispute packet for every rejected/error call;
 *  - provider circuit breaking after repeated rejected/error outcomes.
 *
 * What software cannot truthfully promise:
 *  - reversing a charge already posted by OpenAI or Anthropic. Their billing
 *    systems remain authoritative. A rejected attempt is recorded as disputed,
 *    never erased or relabelled as free. The generated packet preserves the
 *    request id, usage, hashes, and failure reason for a provider credit claim.
 *
 * Prompts and responses are never written to disk. Only hashes, byte counts,
 * request ids, token usage, intent metadata, and sanitized failure reasons are
 * persisted. This makes the ledger useful without turning it into a secret dump.
 */

export type CreditGuardOutcome =
  | "accepted"
  | "disputed"
  | "provider-error"
  | "blocked";

export interface CreditGuardUsage {
  inTokens: number;
  outTokens: number;
}

export interface CreditGuardCallResult<R> {
  raw: R;
  usage?: CreditGuardUsage;
  providerRequestId?: string | null;
  /** Text used only to calculate a response hash and byte count. */
  responseText?: string;
}

export interface CreditGuardEvaluation<T> {
  ok: boolean;
  value: T;
  reason?: string;
}

export interface CreditGuardAttempt<R, T> {
  provider: Extract<ProviderName, "anthropic" | "openai">;
  model?: string;
  operation: "generateText" | "generateJson";
  system: string;
  prompt: string;
  maxTokens: number;
  intent?: CallIntent;
  /** False only for isolated unit seams. Production registry always passes true. */
  managed: boolean;
  call: () => Promise<CreditGuardCallResult<R>>;
  evaluate: (raw: R) => CreditGuardEvaluation<T>;
  /**
   * Schema-invalid JSON is returned to generateJsonWithRepair so its final
   * Zod error remains precise. The paid providers use one attempt only, so this
   * never authorizes another billable repair call.
   */
  returnRejectedValue?: boolean;
}

interface CreditGuardLedgerEntry {
  schema: 1;
  id: string;
  ts: number;
  provider: "anthropic" | "openai";
  model: string | null;
  operation: "generateText" | "generateJson";
  outcome: CreditGuardOutcome;
  fingerprint: string;
  systemHash: string;
  promptHash: string;
  responseHash: string | null;
  systemBytes: number;
  promptBytes: number;
  responseBytes: number | null;
  providerRequestId: string | null;
  usage: CreditGuardUsage | null;
  intent: {
    role: string | null;
    purpose: string | null;
    needs: string[];
  };
  reason: string;
  disputePacket: string | null;
}

export interface CreditGuardStatus {
  enabled: boolean;
  last24h: {
    accepted: number;
    disputed: number;
    providerErrors: number;
    blocked: number;
  };
  openDisputes: number;
  ledgerPath: string;
  disputeDirectory: string;
}

const DAY_MS = 86_400_000;
const TEN_MINUTES_MS = 600_000;

function enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env.FACTORY_CREDIT_GUARD_ENABLED ?? "1")
    .trim()
    .toLowerCase();
  return !["0", "false", "off", "no"].includes(raw);
}

function nonNegativeInteger(
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function duplicateBlockMs(env: NodeJS.ProcessEnv = process.env): number {
  return nonNegativeInteger(
    env.FACTORY_CREDIT_GUARD_DUPLICATE_BLOCK_MS,
    DAY_MS,
  );
}

function circuitWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  return nonNegativeInteger(
    env.FACTORY_CREDIT_GUARD_CIRCUIT_WINDOW_MS,
    TEN_MINUTES_MS,
  );
}

function circuitThreshold(env: NodeJS.ProcessEnv = process.env): number {
  return nonNegativeInteger(
    env.FACTORY_CREDIT_GUARD_CIRCUIT_THRESHOLD,
    3,
  );
}

function dataRoot(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(process.cwd(), env.FACTORY_DATA_DIR || ".factory");
}

export function creditGuardLedgerPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolve(dataRoot(env), "credit-guard", "ledger.jsonl");
}

export function creditGuardDisputeDirectory(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolve(dataRoot(env), "credit-guard", "disputes");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function compactReason(value: unknown, fallback: string): string {
  return safeErrorMessage(value, fallback)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}

function intentSnapshot(intent: CallIntent | undefined): CreditGuardLedgerEntry["intent"] {
  return {
    role: intent?.role ?? null,
    purpose: intent?.purpose?.slice(0, 160) ?? null,
    needs: [...(intent?.needs ?? [])].slice(0, 12),
  };
}

function requestFingerprint(input: {
  provider: string;
  model?: string;
  operation: string;
  system: string;
  prompt: string;
  maxTokens: number;
  intent?: CallIntent;
}): {
  fingerprint: string;
  systemHash: string;
  promptHash: string;
} {
  const systemHash = sha256(input.system);
  const promptHash = sha256(input.prompt);
  const fingerprint = sha256(
    JSON.stringify({
      provider: input.provider,
      model: input.model ?? null,
      operation: input.operation,
      systemHash,
      promptHash,
      maxTokens: input.maxTokens,
      intent: intentSnapshot(input.intent),
    }),
  );
  return { fingerprint, systemHash, promptHash };
}

function parseLedgerLine(line: string): CreditGuardLedgerEntry | null {
  try {
    const value = JSON.parse(line) as Partial<CreditGuardLedgerEntry>;
    if (
      value.schema !== 1 ||
      typeof value.id !== "string" ||
      typeof value.ts !== "number" ||
      (value.provider !== "anthropic" && value.provider !== "openai") ||
      (value.outcome !== "accepted" &&
        value.outcome !== "disputed" &&
        value.outcome !== "provider-error" &&
        value.outcome !== "blocked") ||
      typeof value.fingerprint !== "string"
    ) {
      return null;
    }
    return value as CreditGuardLedgerEntry;
  } catch {
    return null;
  }
}

function readLedger(env: NodeJS.ProcessEnv = process.env): CreditGuardLedgerEntry[] {
  const path = creditGuardLedgerPath(env);
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map(parseLedgerLine)
      .filter((entry): entry is CreditGuardLedgerEntry => entry !== null);
  } catch {
    // A broken receipt ledger must fail closed at admission, not disappear.
    throw new CreditGuardCircuitOpenError(
      "Credit Guard ledger is unreadable; paid calls are blocked until it is repaired.",
    );
  }
}

function appendLedger(
  entry: CreditGuardLedgerEntry,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const path = creditGuardLedgerPath(env);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function writeDisputePacket(
  entry: CreditGuardLedgerEntry,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const directory = creditGuardDisputeDirectory(env);
  mkdirSync(directory, { recursive: true });
  const path = resolve(directory, `${entry.id}.json`);
  const packet = {
    schema: 1,
    kind: "provider-credit-dispute-evidence",
    createdAt: new Date(entry.ts).toISOString(),
    provider: entry.provider,
    model: entry.model,
    operation: entry.operation,
    outcome: entry.outcome,
    providerRequestId: entry.providerRequestId,
    usage: entry.usage,
    request: {
      fingerprint: entry.fingerprint,
      systemHash: entry.systemHash,
      promptHash: entry.promptHash,
      systemBytes: entry.systemBytes,
      promptBytes: entry.promptBytes,
      intent: entry.intent,
    },
    response: {
      hash: entry.responseHash,
      bytes: entry.responseBytes,
    },
    failureReason: entry.reason,
    billingReality:
      "The provider may already have billed this attempt. Credit Guard blocked local acceptance/repetition and preserved evidence; only the provider can reverse its external charge.",
  };
  writeFileSync(path, JSON.stringify(packet, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  return path;
}

function createEntry(input: {
  id: string;
  provider: "anthropic" | "openai";
  model?: string;
  operation: "generateText" | "generateJson";
  outcome: CreditGuardOutcome;
  fingerprint: string;
  systemHash: string;
  promptHash: string;
  responseText?: string;
  system: string;
  prompt: string;
  providerRequestId?: string | null;
  usage?: CreditGuardUsage;
  intent?: CallIntent;
  reason: string;
}): CreditGuardLedgerEntry {
  return {
    schema: 1,
    id: input.id,
    ts: Date.now(),
    provider: input.provider,
    model: input.model ?? null,
    operation: input.operation,
    outcome: input.outcome,
    fingerprint: input.fingerprint,
    systemHash: input.systemHash,
    promptHash: input.promptHash,
    responseHash:
      input.responseText === undefined ? null : sha256(input.responseText),
    systemBytes: byteLength(input.system),
    promptBytes: byteLength(input.prompt),
    responseBytes:
      input.responseText === undefined ? null : byteLength(input.responseText),
    providerRequestId: input.providerRequestId ?? null,
    usage: input.usage ?? null,
    intent: intentSnapshot(input.intent),
    reason: input.reason,
    disputePacket: null,
  };
}

function record(
  entry: CreditGuardLedgerEntry,
  env: NodeJS.ProcessEnv = process.env,
): CreditGuardLedgerEntry {
  if (entry.outcome === "disputed" || entry.outcome === "provider-error") {
    entry.disputePacket = writeDisputePacket(entry, env);
  }
  appendLedger(entry, env);
  return entry;
}

function assertAdmissible(input: {
  provider: "anthropic" | "openai";
  model?: string;
  operation: "generateText" | "generateJson";
  system: string;
  prompt: string;
  maxTokens: number;
  intent?: CallIntent;
  fingerprint: string;
  systemHash: string;
  promptHash: string;
}): void {
  const entries = readLedger();
  const now = Date.now();
  const duplicateCutoff = now - duplicateBlockMs();
  const duplicate = entries.find(
    (entry) =>
      entry.fingerprint === input.fingerprint &&
      entry.ts >= duplicateCutoff &&
      (entry.outcome === "disputed" || entry.outcome === "provider-error"),
  );
  if (duplicate) {
    const reason =
      `Identical paid request was already rejected at ${new Date(
        duplicate.ts,
      ).toISOString()} (${duplicate.outcome}); refusing to buy the same mistake twice.`;
    record(
      createEntry({
        id: randomUUID(),
        ...input,
        outcome: "blocked",
        reason,
      }),
    );
    throw new CreditGuardCircuitOpenError(reason);
  }

  const threshold = circuitThreshold();
  if (threshold === 0) return;
  const cutoff = now - circuitWindowMs();
  const recentFailures = entries.filter(
    (entry) =>
      entry.provider === input.provider &&
      entry.ts >= cutoff &&
      (entry.outcome === "disputed" || entry.outcome === "provider-error"),
  );
  if (recentFailures.length >= threshold) {
    const reason =
      `${input.provider} produced ${recentFailures.length} rejected/error paid attempt(s) ` +
      `inside the Credit Guard circuit window; paid routing is paused instead of compounding the loss.`;
    record(
      createEntry({
        id: randomUUID(),
        ...input,
        outcome: "blocked",
        reason,
      }),
    );
    throw new CreditGuardCircuitOpenError(reason);
  }
}

export class CreditGuardCircuitOpenError extends Error {
  readonly status = 402;

  constructor(message: string) {
    super(message);
    this.name = "CreditGuardCircuitOpenError";
  }
}

export class CreditGuardRejectedOutputError extends Error {
  readonly status = 422;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CreditGuardRejectedOutputError";
  }
}

/** Baseline checks shared by paid text calls before local acceptance. */
export function evaluatePaidText(
  text: string,
  intent?: CallIntent,
): CreditGuardEvaluation<string> {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    return { ok: false, value: text, reason: "Provider returned an empty response." };
  }
  if (/^(undefined|null|\[object Object\])$/i.test(trimmed)) {
    return {
      ok: false,
      value: text,
      reason: `Provider returned a non-answer sentinel: ${trimmed}.`,
    };
  }
  if (
    trimmed.length < 600 &&
    /internal server error|service unavailable|request failed|failed to generate|upstream error/i.test(
      trimmed,
    )
  ) {
    return {
      ok: false,
      value: text,
      reason: "Provider returned an error message instead of the requested work.",
    };
  }
  if (
    intent?.role === "author" &&
    trimmed.length < 800 &&
    /(?:cannot|can't|unable to) (?:access|open|edit|modify|run|test) (?:the |your )?(?:repository|repo|files|codebase)/i.test(
      trimmed,
    )
  ) {
    return {
      ok: false,
      value: text,
      reason:
        "Paid author route refused the repository operation it was selected to perform.",
    };
  }
  return { ok: true, value: text };
}

/**
 * Execute exactly one paid SDK attempt under Credit Guard.
 *
 * Production providers set managed=true. In isolated unit seams managed=false
 * preserves the same deterministic evaluation without touching the persistent
 * paid ledger or Credit Guard files.
 */
export async function runCreditGuardedPaidAttempt<R, T>(
  input: CreditGuardAttempt<R, T>,
): Promise<T> {
  if (!input.managed || !enabled()) {
    const result = await input.call();
    const evaluated = input.evaluate(result.raw);
    if (!evaluated.ok && !input.returnRejectedValue) {
      throw new CreditGuardRejectedOutputError(
        evaluated.reason || "Paid output failed local acceptance.",
      );
    }
    return evaluated.value;
  }

  const hashes = requestFingerprint(input);
  assertAdmissible({ ...input, ...hashes });

  const id = randomUUID();
  let reservation: PaidCallReservation | null = null;
  try {
    reservation = reservePaidCall(input.provider, {
      system: input.system,
      prompt: input.prompt,
      maxTokens: input.maxTokens,
    });
  } catch (error) {
    // PaidBudget already explains why admission was refused. Do not create a
    // dispute packet because no provider request occurred.
    throw error;
  }

  let called: CreditGuardCallResult<R>;
  try {
    called = await input.call();
  } catch (error) {
    abandonPaidCall(reservation);
    const reason = compactReason(error, "Provider request failed.");
    record(
      createEntry({
        id,
        ...input,
        ...hashes,
        outcome: "provider-error",
        reason,
      }),
    );
    throw error;
  }

  // Settle known provider usage before evaluation. A rejected result may still
  // have been externally billed; keeping the real usage is honest accounting.
  settlePaidCall(reservation, called.usage);

  let evaluated: CreditGuardEvaluation<T>;
  try {
    evaluated = input.evaluate(called.raw);
  } catch (error) {
    const reason = compactReason(error, "Provider output could not be evaluated.");
    record(
      createEntry({
        id,
        ...input,
        ...hashes,
        outcome: "disputed",
        responseText: called.responseText,
        providerRequestId: called.providerRequestId,
        usage: called.usage,
        reason,
      }),
    );
    throw new CreditGuardRejectedOutputError(reason, { cause: error });
  }

  if (!evaluated.ok) {
    const reason = compactReason(
      evaluated.reason,
      "Provider output failed local acceptance.",
    );
    record(
      createEntry({
        id,
        ...input,
        ...hashes,
        outcome: "disputed",
        responseText: called.responseText,
        providerRequestId: called.providerRequestId,
        usage: called.usage,
        reason,
      }),
    );
    if (!input.returnRejectedValue) {
      throw new CreditGuardRejectedOutputError(reason);
    }
    return evaluated.value;
  }

  record(
    createEntry({
      id,
      ...input,
      ...hashes,
      outcome: "accepted",
      responseText: called.responseText,
      providerRequestId: called.providerRequestId,
      usage: called.usage,
      reason: "Passed deterministic local acceptance.",
    }),
  );
  return evaluated.value;
}

export function creditGuardStatus(
  env: NodeJS.ProcessEnv = process.env,
): CreditGuardStatus {
  const entries = readLedger(env);
  const cutoff = Date.now() - DAY_MS;
  const recent = entries.filter((entry) => entry.ts >= cutoff);
  return {
    enabled: enabled(env),
    last24h: {
      accepted: recent.filter((entry) => entry.outcome === "accepted").length,
      disputed: recent.filter((entry) => entry.outcome === "disputed").length,
      providerErrors: recent.filter((entry) => entry.outcome === "provider-error")
        .length,
      blocked: recent.filter((entry) => entry.outcome === "blocked").length,
    },
    openDisputes: entries.filter(
      (entry) => entry.outcome === "disputed" || entry.outcome === "provider-error",
    ).length,
    ledgerPath: creditGuardLedgerPath(env),
    disputeDirectory: creditGuardDisputeDirectory(env),
  };
}
