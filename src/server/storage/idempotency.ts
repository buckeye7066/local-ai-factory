import { mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { writeFileContained } from "./runsStore.js";

/**
 * idempotency.ts — durable client idempotency keys for POST /api/runs.
 * Same key + idea hash returns the existing runId instead of starting a duplicate.
 */

const DATA_ROOT = resolve(process.cwd(), process.env.FACTORY_DATA_DIR || ".factory");
const IDEM_DIR = join(DATA_ROOT, "idempotency");

const memory = new Map<
  string,
  { runId: string; ideaHash: string; createdAt: number }
>();

function safeKeyFilename(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex");
  return `${hash}.json`;
}

export function hashIdea(idea: string): string {
  return createHash("sha256").update(idea).digest("hex").slice(0, 32);
}

export async function lookupIdempotency(
  key: string,
  idea: string,
): Promise<{ runId: string } | null> {
  const ideaHash = hashIdea(idea);
  const mem = memory.get(key);
  if (mem) {
    if (mem.ideaHash !== ideaHash) return null; // conflict — caller should 409
    return { runId: mem.runId };
  }
  try {
    await mkdir(IDEM_DIR, { recursive: true });
    const raw = await readFile(join(IDEM_DIR, safeKeyFilename(key)), "utf8");
    const parsed = JSON.parse(raw) as {
      runId: string;
      ideaHash: string;
      createdAt: number;
    };
    memory.set(key, parsed);
    if (parsed.ideaHash !== ideaHash) return null;
    return { runId: parsed.runId };
  } catch {
    return null;
  }
}

export async function rememberIdempotency(
  key: string,
  idea: string,
  runId: string,
): Promise<void> {
  const record = {
    runId,
    ideaHash: hashIdea(idea),
    createdAt: Date.now(),
  };
  memory.set(key, record);
  await mkdir(IDEM_DIR, { recursive: true });
  await writeFileContained(
    join(IDEM_DIR, safeKeyFilename(key)),
    JSON.stringify(record),
  );
}

/** True when the key exists but was used with a different idea (HTTP 409). */
export async function isIdempotencyConflict(
  key: string,
  idea: string,
): Promise<boolean> {
  const ideaHash = hashIdea(idea);
  const mem = memory.get(key);
  if (mem) return mem.ideaHash !== ideaHash;
  try {
    const raw = await readFile(join(IDEM_DIR, safeKeyFilename(key)), "utf8");
    const parsed = JSON.parse(raw) as { ideaHash: string };
    return parsed.ideaHash !== ideaHash;
  } catch {
    return false;
  }
}
