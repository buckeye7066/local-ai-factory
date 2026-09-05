import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireProcessFileLock } from "../storage/processFileLock.js";

async function killAndWait(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit", { signal: AbortSignal.timeout(5_000) });
  child.kill("SIGKILL");
  await exited;
}

describe("process-lock crash recovery", () => {
  it("recovers a durably ticketed dead owner before the stale grace expires", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-lock-crash-"));
    const lockPath = join(root, "audit.lock");
    let child: ChildProcess | undefined;
    let recovered: Awaited<ReturnType<typeof acquireProcessFileLock>> = null;
    try {
      const source = `
        import { acquireProcessFileLock } from './src/server/storage/processFileLock.ts';
        const lease = await acquireProcessFileLock(${JSON.stringify(lockPath)});
        if (!lease) throw new Error('Child did not acquire the lock');
        process.stdout.write('OWNER_LOCKED');
        setInterval(() => {}, 1000);
      `;
      child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "--eval", source],
        {
          cwd: resolve(process.cwd()),
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let errors = "";
      child.stderr?.on("data", (chunk) => {
        errors += String(chunk);
      });
      const [message] = await once(child.stdout!, "data", {
        signal: AbortSignal.timeout(20_000),
      });
      expect(String(message), errors).toBe("OWNER_LOCKED");
      await killAndWait(child);

      // A confirmed dead writer cannot still own its UUID receipt. Waiting
      // 30 seconds here would make the normal 10-second audit acquisition fail.
      recovered = await acquireProcessFileLock(lockPath, {
        timeoutMs: 1_000,
        pollMs: 5,
        staleGraceMs: 30_000,
      });
      expect(recovered).not.toBeNull();
    } finally {
      await recovered?.release();
      if (child) await killAndWait(child);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never preempts a live owner even when its grace is zero", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-lock-live-"));
    const lockPath = join(root, "audit.lock");
    const owner = await acquireProcessFileLock(lockPath);
    let contender: Awaited<ReturnType<typeof acquireProcessFileLock>> = null;
    try {
      expect(owner).not.toBeNull();
      contender = await acquireProcessFileLock(lockPath, {
        timeoutMs: 50,
        pollMs: 5,
        staleGraceMs: 0,
      });
      expect(contender).toBeNull();
    } finally {
      await contender?.release();
      await owner?.release();
      await rm(root, { recursive: true, force: true });
    }
  });
});
