import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch: string[] = [];

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "factory-atomic-write-"));
  scratch.push(path);
  return path;
}

afterEach(async () => {
  vi.doUnmock("node:fs/promises");
  vi.resetModules();
  await Promise.all(
    scratch
      .splice(0)
      .map((path) =>
        rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
      ),
  );
});

describe("writeWorkspaceFile atomic replacement", () => {
  it("replaces an existing file through a new inode and preserves its mode", async () => {
    const root = await workspace();
    const target = join(root, "script.sh");
    await writeFile(target, "before\n", "utf8");
    if (process.platform !== "win32") await chmod(target, 0o750);
    const before = await stat(target);
    const { writeWorkspaceFile } = await import("../workspace/fileWriter.js");

    const result = await writeWorkspaceFile(root, "script.sh", "after\n");
    const after = await stat(target);

    expect(result.existed).toBe(true);
    expect(await readFile(target, "utf8")).toBe("after\n");
    if (process.platform !== "win32") {
      expect(after.ino).not.toBe(before.ino);
      expect(after.mode & 0o777).toBe(0o750);
    }
    expect((await readdir(root)).filter((name) => name.includes(".factory-"))).toEqual(
      [],
    );
  });

  it("preserves the original bytes and removes the temp when commit fails", async () => {
    const root = await workspace();
    const target = join(root, "important.txt");
    await writeFile(target, "owner bytes\n", "utf8");
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      return {
        ...actual,
        rename: vi.fn(async () => {
          throw new Error("injected rename failure");
        }),
      };
    });
    const { writeWorkspaceFile } = await import("../workspace/fileWriter.js");

    await expect(
      writeWorkspaceFile(root, "important.txt", "replacement\n"),
    ).rejects.toThrow("injected rename failure");
    expect(await readFile(target, "utf8")).toBe("owner bytes\n");
    expect((await readdir(root)).filter((name) => name.includes(".factory-"))).toEqual(
      [],
    );
  });

  it.skipIf(process.platform === "win32")(
    "supports a valid near-NAME_MAX target without lengthening its temp basename",
    async () => {
      const root = await workspace();
      const name = `${"a".repeat(220)}.txt`;
      const { writeWorkspaceFile } = await import("../workspace/fileWriter.js");

      await writeWorkspaceFile(root, name, "bounded temp name\n");

      expect(await readFile(join(root, name), "utf8")).toBe("bounded temp name\n");
      expect(
        (await readdir(root)).filter((entry) => entry.includes(".factory-")),
      ).toEqual([]);
    },
  );
});
