import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { appendFile, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
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

  it("recovers a queue owner left by a process that no longer exists", async () => {
    const queue = resolve(dataRoot, "audit", ".append.lock.owners");
    const token = "00000000-0000-4000-8000-000000000061";
    const pid = 2_147_483_647;
    await mkdir(queue, { recursive: true });
    await writeFile(
      resolve(queue, `owner.${pid}.${token}.json`),
      JSON.stringify({
        version: 1,
        pid,
        createdAt: Date.now() - 60_000,
        token,
      }),
      "utf8",
    );
    await writeFile(resolve(queue, "tickets.log"), `${token}\n`, "utf8");

    await expect(
      appendAuditEvent({ type: "run.queued", runId: "run-after-crash" }),
    ).resolves.toMatchObject({ seq: 1 });
    await expect(verifyAuditChain()).resolves.toEqual({ ok: true, badSeq: null });
  });

  it("recovers an old malformed queue contender left during a crashed write", async () => {
    const queue = resolve(dataRoot, "audit", ".append.lock.owners");
    const contender = resolve(
      queue,
      "owner.2147483647.00000000-0000-4000-8000-000000000062.json",
    );
    await mkdir(queue, { recursive: true });
    await writeFile(contender, '{"version":', "utf8");
    const stale = new Date(Date.now() - 60_000);
    await utimes(contender, stale, stale);

    await expect(
      appendAuditEvent({ type: "run.queued", runId: "run-after-partial-lock" }),
    ).resolves.toMatchObject({ seq: 1 });
    await expect(verifyAuditChain()).resolves.toEqual({ ok: true, badSeq: null });
  });
  it("fails verification when an audit-bound attribution manifest is changed", async () => {
    const attributionDirectory = resolve(dataRoot, "attribution");
    const path = resolve(
      attributionDirectory,
      "00000000-0000-4000-8000-000000000041.json",
    );
    await mkdir(attributionDirectory, { recursive: true });
    const original = JSON.stringify(
      { jobId: "00000000-0000-4000-8000-000000000041", generatedFiles: [] },
      null,
      2,
    );
    await writeFile(path, original, "utf8");
    const { createHash } = await import("node:crypto");
    const digest = createHash("sha256").update(original).digest("hex");
    await appendAuditEvent({
      type: "attribution.written",
      runId: "00000000-0000-4000-8000-000000000041",
      detail: path,
      meta: { testResult: "passing", manifestSha256: digest },
    });
    await expect(verifyAuditChain()).resolves.toEqual({ ok: true, badSeq: null });

    const changed = (await readFile(path, "utf8")).replace("[]", '[{"path":"forged"}]');
    await writeFile(path, changed, "utf8");
    await expect(verifyAuditChain()).resolves.toEqual({ ok: false, badSeq: 1 });
  });
});
