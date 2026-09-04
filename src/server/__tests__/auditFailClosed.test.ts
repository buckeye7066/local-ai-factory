import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const dataRoot = resolve(process.cwd(), ".test-factory-data-audit-fail-closed");
const auditFile = resolve(dataRoot, "audit", "events.jsonl");

process.env.FACTORY_DATA_DIR = dataRoot;
const { appendAuditEvent, verifyAuditChain, _resetAuditCursorForTests } = await import(
  "../storage/auditLog.js"
);

beforeEach(async () => {
  await rm(dataRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
  _resetAuditCursorForTests();
});

afterAll(async () => {
  await rm(dataRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
  delete process.env.FACTORY_DATA_DIR;
});

describe("audit-chain corruption", () => {
  it("fails verification and refuses to append after malformed JSON", async () => {
    await appendAuditEvent({ type: "run.queued", runId: "run-1" });
    await appendFile(auditFile, '{"seq":2,"type":"run.started"', "utf8");

    await expect(verifyAuditChain()).resolves.toEqual({ ok: false, badSeq: 2 });
    await expect(
      appendAuditEvent({ type: "run.started", runId: "run-1" }),
    ).rejects.toThrow(/corrupt audit chain.*sequence 2/i);
  });

  it("treats an empty, not-yet-created audit log as an intact empty chain", async () => {
    await mkdir(dataRoot, { recursive: true });
    await expect(verifyAuditChain()).resolves.toEqual({ ok: true, badSeq: null });
  });

  it("recovers a lock left by a process that no longer exists", async () => {
    const auditDirectory = resolve(dataRoot, "audit");
    await mkdir(auditDirectory, { recursive: true });
    await writeFile(
      resolve(auditDirectory, ".append.lock"),
      JSON.stringify({
        pid: 2_147_483_647,
        acquiredAt: Date.now() - 1_000,
        token: "abandoned-test-lock",
      }),
      "utf8",
    );

    await expect(
      appendAuditEvent({ type: "run.queued", runId: "run-after-crash" }),
    ).resolves.toMatchObject({ seq: 1 });
    await expect(verifyAuditChain()).resolves.toEqual({ ok: true, badSeq: null });
  });
});
