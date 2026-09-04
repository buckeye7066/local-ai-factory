import { describe, it, expect, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readProjectRoster,
  matchRoster,
  searchFilesystemForProject,
} from "../tools/projectRoster.js";

const cleanupPaths: string[] = [];
afterAll(async () => {
  await Promise.all(
    cleanupPaths.map((p) =>
      rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
    ),
  );
});

const SAMPLE_CLAUDE_MD = `# CLAUDE.md

| Repo | Canonical local path | Stack | Notes |
|---|---|---|---|
| GrantFlow | \`~/GrantFlow\` | React+Express+PostgreSQL | Grant-mgmt SaaS |
| FutureU | \`D:\\Projects\\FutureU\` | React+Express | K-12 homeschool platform |
| ForgePress | \`D:\\Projects\\ForgePress\` | Electron+React19 | canonical |
`;

describe("readProjectRoster", () => {
  it("parses repo name + canonical path rows out of a CLAUDE.md table", async () => {
    const dir = await mkdtemp(join(tmpdir(), "factory-roster-"));
    cleanupPaths.push(dir);
    const claudeMdPath = join(dir, "CLAUDE.md");
    await writeFile(claudeMdPath, SAMPLE_CLAUDE_MD);

    const roster = await readProjectRoster(claudeMdPath);
    expect(roster.map((r) => r.name)).toEqual(
      expect.arrayContaining(["GrantFlow", "FutureU", "ForgePress"]),
    );
    const futureU = roster.find((r) => r.name === "FutureU");
    expect(futureU?.path).toBe("D:\\Projects\\FutureU");
  });

  it("returns an empty array when the file doesn't exist", async () => {
    const roster = await readProjectRoster(join(tmpdir(), "does-not-exist-claude.md"));
    expect(roster).toEqual([]);
  });
});

describe("matchRoster", () => {
  it("matches a project referenced by name inside a longer sentence", async () => {
    const roster = [
      { name: "GrantFlow", path: "/x/GrantFlow" },
      { name: "FutureU", path: "/x/FutureU" },
    ];
    const hit = matchRoster("improve error handling in FutureU please", roster);
    expect(hit?.name).toBe("FutureU");
  });

  it("returns null when nothing matches", async () => {
    const roster = [{ name: "GrantFlow", path: "/x/GrantFlow" }];
    expect(matchRoster("do something to Unrelated Project Name", roster)).toBeNull();
  });
});

describe("searchFilesystemForProject", () => {
  it("finds a git repo directory matching a fuzzy name under a search root", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-fsroot-"));
    cleanupPaths.push(root);
    const projectDir = join(root, "my-cool-project");
    await mkdir(join(projectDir, ".git"), { recursive: true });
    await mkdir(join(root, "not-a-repo"), { recursive: true });

    const found = await searchFilesystemForProject("cool project", [root]);
    expect(found.some((f) => f.path === projectDir)).toBe(true);
    expect(found.every((f) => f.name !== "not-a-repo")).toBe(true);
  });
});
