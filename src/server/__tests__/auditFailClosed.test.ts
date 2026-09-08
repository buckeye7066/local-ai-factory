import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { appendFile, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const dataRoot = resolve(process.cwd(), ".test-factory-data-audit-fail-closed");
const auditFile = resolve(dataRoot, "audit", "events.jsonl");

process.env.FACTORY_DATA_DIR = dataRoot;
const {
  appendAuditEvent,
  verifyAuditChain,
  recoverAuditChain,
  _resetAuditCursorForTests,
} = await import("../storage/auditLog.js");
const { buildAttribution, writeAttribution } =
  await import("../storage/attribution.js");
import type { RunRecord } from "../../shared/schemas.js";

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
  it("preserves interleaved legacy records and explicitly restarts a bound chain", async () => {
    const first = await appendAuditEvent({ type: "run.queued", runId: "run-1" });
    await appendAuditEvent({ type: "run.started", runId: "run-1" });
    // Old processes cached the tail independently: a second writer forked
    // sequence 2 from the same prior record, matching the installed failure.
    const body = {
      type: "run.queued",
      runId: "run-2",
      seq: 2,
      ts: Date.now(),
      prevHash: first.hash,
    };
    const fork = {
      ...body,
      hash: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
    };
    await appendFile(auditFile, `${JSON.stringify(fork)}\n`);
    const original = await readFile(auditFile);
    await expect(
      appendAuditEvent({ type: "run.started", runId: "run-2" }),
    ).rejects.toThrow(/corrupt audit chain/);

    const recovery = await recoverAuditChain();
    expect(recovery).toMatchObject({ recovered: true, badSeq: 3 });
    expect(await readFile(recovery.archivePath!)).toEqual(original);
    expect(JSON.parse((await readFile(auditFile, "utf8")).trim())).toMatchObject({
      type: "audit.recovered",
      seq: 1,
      meta: { archiveSha256: recovery.archiveSha256 },
    });
    await expect(
      appendAuditEvent({ type: "run.queued", runId: "new-run" }),
    ).resolves.toMatchObject({ seq: 2 });
    await expect(verifyAuditChain()).resolves.toEqual({ ok: true, badSeq: null });
    const after = await readFile(auditFile);
    await expect(recoverAuditChain()).resolves.toEqual({ recovered: false });
    expect(await readFile(auditFile)).toEqual(after);

    await appendFile(recovery.archivePath!, "tampered");
    await expect(verifyAuditChain()).resolves.toEqual({ ok: false, badSeq: 1 });
    await expect(
      appendAuditEvent({ type: "run.started", runId: "new-run" }),
    ).rejects.toThrow(/archive digest/);
  });

  it("preserves truncated bytes without pretending the old history verified", async () => {
    await appendAuditEvent({ type: "run.queued", runId: "run-1" });
    await appendFile(auditFile, '{"seq":2');
    const original = await readFile(auditFile);
    const recovery = await recoverAuditChain();
    expect(recovery.reason).toMatch(/malformed JSON/);
    expect(await readFile(recovery.archivePath!)).toEqual(original);
    await expect(verifyAuditChain()).resolves.toEqual({ ok: true, badSeq: null });
  });

  it("keeps audit-bound attribution bytes intact when the same run resumes", async () => {
    const run = {
      id: "00000000-0000-4000-8000-000000000075",
      workspacePath: null,
    } as RunRecord;
    const attr = buildAttribution(run, {
      allowUntrustedScripts: false,
      testResult: "not_run",
      auditSeq: null,
    });
    const first = await writeAttribution(attr);
    const original = await readFile(first.path);
    await appendAuditEvent({
      type: "attribution.written",
      runId: run.id,
      detail: first.path,
      meta: { manifestSha256: first.manifestSha256 },
    });
    attr.testResult = "passing";
    const second = await writeAttribution(attr);
    expect(second.path).not.toBe(first.path);
    expect(attr.commitPath).toBe(second.path);
    expect(await readFile(first.path)).toEqual(original);
    await appendAuditEvent({
      type: "attribution.written",
      runId: run.id,
      detail: second.path,
      meta: { manifestSha256: second.manifestSha256 },
    });
    await expect(
      appendAuditEvent({ type: "run.queued", runId: "later-run" }),
    ).resolves.toMatchObject({ seq: 3 });
    await expect(verifyAuditChain()).resolves.toEqual({ ok: true, badSeq: null });
  });

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
