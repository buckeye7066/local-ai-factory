import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile, symlink } from "node:fs/promises";
import { constants as FS } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileContained } from "../storage/runsStore.js";

/**
 * Round-11 #6 — the store writes and fsyncs an exclusive sibling, then atomically
 * renames it over the live record. O_NOFOLLOW is used for the temporary inode
 * where available, and an existing final-component symlink is refused.
 */

const HAS_NOFOLLOW = typeof FS.O_NOFOLLOW === "number" && FS.O_NOFOLLOW !== 0;

const scratch: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "factfd-"));
  scratch.push(d);
  return d;
}
afterAll(() => {
  for (const d of scratch)
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("Round-11 #6 writeFileContained", () => {
  it("writes normally to a fresh path", async () => {
    const p = join(tmp(), "run.json");
    await writeFileContained(p, JSON.stringify({ ok: true }));
    expect(JSON.parse(await readFile(p, "utf8"))).toEqual({ ok: true });
  });

  it("atomically replaces an existing regular record", async () => {
    const p = join(tmp(), "run.json");
    await writeFile(p, JSON.stringify({ generation: 1 }), "utf8");
    await writeFileContained(p, JSON.stringify({ generation: 2 }));
    expect(JSON.parse(await readFile(p, "utf8"))).toEqual({ generation: 2 });
  });

  it("refuses to write when the target is not a regular file (directory)", async () => {
    const dir = join(tmp(), "id.json");
    await mkdir(dir, { recursive: true });
    // Opening a directory for write fails (EISDIR) / the fstat re-check refuses.
    await expect(writeFileContained(dir, "x")).rejects.toThrow();
  });

  it(
    HAS_NOFOLLOW
      ? "refuses a symlinked target while O_NOFOLLOW protects the sibling"
      : "refuses a symlinked target even without O_NOFOLLOW on Windows",
    async () => {
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
