import { afterEach, describe, expect, it, vi } from "vitest";
import { constants as FS } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const scratch: string[] = [];

function platform(value: string): void {
  Object.defineProperty(process, "platform", { ...originalPlatform, value });
}

async function loadWithReadFault(fault: (path: string) => void) {
  vi.doMock("node:fs/promises", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs/promises")>();
    return {
      ...actual,
      open: async (...args: Parameters<typeof actual.open>) => {
        const [path, flags] = args;
        if (
          typeof path === "string" &&
          basename(path).startsWith("owner.") &&
          typeof flags === "number" &&
          (flags & (FS.O_WRONLY | FS.O_RDWR)) === 0
        ) {
          fault(path);
        }
        return actual.open(...args);
      },
    };
  });
  return import("../storage/processFileLock.js");
}

async function lockPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "factory-lock-read-"));
  scratch.push(root);
  return join(root, "audit.lock");
}

function failure(code: string): Error & { code: string } {
  return Object.assign(new Error(`injected owner-read ${code}`), { code });
}

afterEach(async () => {
  Object.defineProperty(process, "platform", originalPlatform);
  vi.doUnmock("node:fs/promises");
  vi.resetModules();
  await Promise.all(
    scratch.splice(0).map((root) =>
      rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
    ),
  );
});

describe("Windows process-lock owner-read races", () => {
  it.each(["EPERM", "EACCES", "EBUSY"])(
    "rechecks a transient %s before issuing a lease",
    async (code) => {
      platform("win32");
      let reads = 0;
      const { acquireProcessFileLock } = await loadWithReadFault(() => {
        reads += 1;
        if (reads === 1) throw failure(code);
      });
      const path = await lockPath();
      const lease = await acquireProcessFileLock(path, {
        timeoutMs: 2_000,
        pollMs: 1,
      });
      try {
        expect(lease).not.toBeNull();
        expect(reads).toBeGreaterThanOrEqual(2);
      } finally {
        await lease?.release();
      }
      await expect(readdir(`${path}.owners`)).resolves.toEqual(["tickets.log"]);
    },
  );

  it("never skips an unreadable live owner to admit a later contender", async () => {
    platform("win32");
    let blocked = "";
    let denied = 0;
    const { acquireProcessFileLock } = await loadWithReadFault((path) => {
      if (path === blocked) {
        denied += 1;
        throw failure("EPERM");
      }
    });
    const path = await lockPath();
    const first = await acquireProcessFileLock(path);
    expect(first).not.toBeNull();
    blocked = join(`${path}.owners`, `owner.${process.pid}.${first!.token}.json`);
    const original = await readFile(blocked, "utf8");
    let second: Awaited<ReturnType<typeof acquireProcessFileLock>> = null;
    try {
      second = await acquireProcessFileLock(path, { timeoutMs: 100, pollMs: 2 });
      expect(second).toBeNull();
      expect(denied).toBeGreaterThan(0);
      expect(await readFile(blocked, "utf8")).toBe(original);
      expect((await readdir(`${path}.owners`)).sort()).toEqual(
        [basename(blocked), "tickets.log"].sort(),
      );
    } finally {
      blocked = "";
      await second?.release();
      await first?.release();
    }
    const recovered = await acquireProcessFileLock(path);
    try {
      expect(recovered).not.toBeNull();
    } finally {
      await recovered?.release();
    }
  });

  it("times out and removes its own receipt when reads stay indeterminate", async () => {
    platform("win32");
    const { acquireProcessFileLock } = await loadWithReadFault(() => {
      throw failure("EPERM");
    });
    const path = await lockPath();
    await expect(
      acquireProcessFileLock(path, { timeoutMs: 0, pollMs: 1 }),
    ).resolves.toBeNull();
    await expect(readdir(`${path}.owners`)).resolves.toEqual(["tickets.log"]);
  });

  it.each([
    ["linux", "EPERM"],
    ["win32", "EIO"],
  ])("preserves %s %s errors instead of masking them", async (host, code) => {
    platform(host);
    const { acquireProcessFileLock } = await loadWithReadFault(() => {
      throw failure(code);
    });
    const path = await lockPath();
    await expect(acquireProcessFileLock(path)).rejects.toMatchObject({ code });
    await expect(readdir(`${path}.owners`)).resolves.toEqual(["tickets.log"]);
  });
});
