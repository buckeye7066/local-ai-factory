import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile, symlink } from "node:fs/promises";
import { constants as FS } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileContained } from "../storage/runsStore.js";

/**
 * Round-11 #6 — the store now writes through a file descriptor, re-checking the
 * opened target (fstat) is a regular file and using O_NOFOLLOW where the platform
 * supports it. This NARROWS the lstat→write TOCTOU window; on Windows (no
 * O_NOFOLLOW) it is documented as not fully closed.
 */

const HAS_NOFOLLOW = typeof FS.O_NOFOLLOW === "number" && FS.O_NOFOLLOW !== 0;

const scratch: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "factfd-"));
  scratch.push(d);
  return d;
}
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("Round-11 #6 writeFileContained", () => {
  it("writes normally to a fresh path", async () => {
    const p = join(tmp(), "run.json");
    await writeFileContained(p, JSON.stringify({ ok: true }));
    expect(JSON.parse(await readFile(p, "utf8"))).toEqual({ ok: true });
  });

  it("refuses to write when the target is not a regular file (directory)", async () => {
    const dir = join(tmp(), "id.json");
    await mkdir(dir, { recursive: true });
    // Opening a directory for write fails (EISDIR) / the fstat re-check refuses.
    await expect(writeFileContained(dir, "x")).rejects.toThrow();
  });

  it(
    HAS_NOFOLLOW
      ? "refuses to follow a symlinked target (O_NOFOLLOW)"
      : "documents that O_NOFOLLOW is unavailable on this platform (Windows)",
    async () => {
      if (!HAS_NOFOLLOW) {
        // Honest: this platform cannot refuse a symlink at open time; the
        // residual is documented. Nothing to assert about O_NOFOLLOW here.
        expect(HAS_NOFOLLOW).toBe(false);
        return;
      }
      const base = tmp();
      const target = join(base, "outside.json");
      await writeFile(target, "{}", "utf8");
      const link = join(base, "link.json");
      await symlink(target, link, "file");
      await expect(writeFileContained(link, "y")).rejects.toThrow();
      // The target behind the symlink was not overwritten.
      expect(await readFile(target, "utf8")).toBe("{}");
    },
  );
});
