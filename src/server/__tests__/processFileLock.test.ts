import { afterEach, describe, expect, it } from "vitest";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  _processLockQueuePathForTests,
  acquireProcessFileLock,
} from "../storage/processFileLock.js";

const directory = resolve(process.cwd(), ".test-factory-process-lock");
const lockPath = resolve(directory, "owner.lock");
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("cross-process file lock", () => {
  it("serializes concurrent contenders without a shared unlink target", async () => {
    let active = 0;
    let maximumActive = 0;
    const order: number[] = [];

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        (async () => {
          const lease = await acquireProcessFileLock(lockPath, {
            timeoutMs: 5_000,
            pollMs: 1,
            staleGraceMs: 1_000,
          });
          expect(lease).not.toBeNull();
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          order.push(index);
          await new Promise((resolveWait) => setTimeout(resolveWait, 2));
          active -= 1;
          await lease!.release();
        })(),
      ),
    );

    expect(maximumActive).toBe(1);
    expect(order).toHaveLength(20);
    const queue = _processLockQueuePathForTests(lockPath);
    await expect(readdir(queue)).resolves.toEqual(["tickets.log"]);
  });

  it("serializes independent Node processes in one durable critical section", async () => {
    await mkdir(directory, { recursive: true });
    const tracePath = resolve(directory, "critical-section.log");
    const workerPath = resolve(
      process.cwd(),
      "src/server/__tests__/helpers/processLockWorker.ts",
    );

    await Promise.all(
      Array.from({ length: 8 }, () =>
        execFileAsync(
          process.execPath,
          ["--import", "tsx", workerPath, lockPath, tracePath, "15"],
          { cwd: process.cwd(), timeout: 20_000 },
        ),
      ),
    );

    const lines = (await readFile(tracePath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(16);
    for (let index = 0; index < lines.length; index += 2) {
      const start = /^start (.+)$/.exec(lines[index]!);
      const end = /^end (.+)$/.exec(lines[index + 1]!);
      expect(start).not.toBeNull();
      expect(end?.[1]).toBe(start?.[1]);
    }
  }, 30_000);

  it("keeps a later contender out until the current owner releases", async () => {
    const first = await acquireProcessFileLock(lockPath, { pollMs: 1 });
    expect(first).not.toBeNull();
    let secondEntered = false;
    const secondPromise = acquireProcessFileLock(lockPath, {
      timeoutMs: 5_000,
      pollMs: 1,
    }).then((lease) => {
      secondEntered = true;
      return lease;
    });

    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    expect(secondEntered).toBe(false);
    await first!.release();
    const second = await secondPromise;
    expect(second).not.toBeNull();
    await second!.release();
  });

  it("forgets cached ticket state when a queue is recreated at the same path", async () => {
    const first = await acquireProcessFileLock(lockPath, { pollMs: 1 });
    expect(first).not.toBeNull();
    await first!.release();

    const queue = _processLockQueuePathForTests(lockPath);
    await rm(queue, { recursive: true, force: true });

    const second = await acquireProcessFileLock(lockPath, {
      timeoutMs: 1_000,
      pollMs: 1,
    });
    expect(second).not.toBeNull();
    await second!.release();
    await expect(readdir(queue)).resolves.toEqual(["tickets.log"]);
  });

  it("reclaims a dead contender by its unique UUID pathname", async () => {
    const queue = _processLockQueuePathForTests(lockPath);
    await mkdir(queue, { recursive: true });
    const token = "00000000-0000-4000-8000-000000000051";
    const pid = 2_147_483_647;
    const path = resolve(queue, `owner.${pid}.${token}.json`);
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        pid,
        createdAt: Date.now() - 60_000,
        token,
      }),
      "utf8",
    );
    await writeFile(resolve(queue, "tickets.log"), `${token}\n`, "utf8");

    const lease = await acquireProcessFileLock(lockPath, {
      timeoutMs: 1_000,
      pollMs: 1,
      staleGraceMs: 0,
    });
    expect(lease).not.toBeNull();
    await lease!.release();
    await expect(readdir(queue)).resolves.toEqual(["tickets.log"]);
  });

  it("does not treat an unticketed partial owner as a lease and clears it after grace", async () => {
    const queue = _processLockQueuePathForTests(lockPath);
    await mkdir(queue, { recursive: true });
    const malformedName = "owner.2147483647.00000000-0000-4000-8000-000000000052.json";
    const malformed = resolve(queue, malformedName);
    await writeFile(malformed, '{"version":', "utf8");

    const first = await acquireProcessFileLock(lockPath, {
      timeoutMs: 1_000,
      pollMs: 1,
      staleGraceMs: 60_000,
    });
    expect(first).not.toBeNull();
    await first!.release();
    await expect(readdir(queue).then((names) => names.sort())).resolves.toEqual([
      malformedName,
      "tickets.log",
    ]);

    const second = await acquireProcessFileLock(lockPath, {
      timeoutMs: 1_000,
      pollMs: 1,
      staleGraceMs: 0,
    });
    expect(second).not.toBeNull();
    await second!.release();
    await expect(readdir(queue)).resolves.toEqual(["tickets.log"]);
  });
});
