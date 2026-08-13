import { describe, it, expect, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { ingestExistingRepo, IngestError } from "../workspace/ingestRepo.js";

const cleanupPaths: string[] = [];
afterAll(async () => {
  await Promise.all(cleanupPaths.map((p) => rm(p, { recursive: true, force: true })));
});

async function makeTmpGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "factory-ingest-src-"));
  cleanupPaths.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "existing-app" }));
  await writeFile(join(dir, "README.md"), "# existing-app\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

async function makeTmpPlainDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "factory-ingest-plain-"));
  cleanupPaths.push(dir);
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "plain-app" }));
  await mkdir(join(dir, "node_modules", "somepkg"), { recursive: true });
  await writeFile(
    join(dir, "node_modules", "somepkg", "index.js"),
    "module.exports = {};",
  );
  return dir;
}

describe("ingestExistingRepo", () => {
  it("clones a local git repo into an isolated workspace (type: git, local path as clonable location)", async () => {
    const src = await makeTmpGitRepo();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "factory-ws-"));
    cleanupPaths.push(workspaceRoot);

    const result = await ingestExistingRepo(
      workspaceRoot,
      { type: "git", location: src },
      "11111111-1111-1111-1111-111111111111",
    );

    expect(result.inPlace).toBe(false);
    expect(result.isGitRepo).toBe(true);
    expect(result.branch).toMatch(/^factory-deck\//);
    // Isolated: never the source path itself.
    expect(resolve(result.path)).not.toBe(resolve(src));
    // Content actually cloned.
    const pkg = await readFile(join(result.path, "package.json"), "utf8");
    expect(JSON.parse(pkg).name).toBe("existing-app");
    // origin severed — nothing in the pipeline can push back to the source.
    expect(() =>
      execFileSync("git", ["remote", "get-url", "origin"], { cwd: result.path }),
    ).toThrow();
  });

  it("clones a git working tree found at a local path when type: path (no inPlace)", async () => {
    const src = await makeTmpGitRepo();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "factory-ws-"));
    cleanupPaths.push(workspaceRoot);

    const result = await ingestExistingRepo(
      workspaceRoot,
      { type: "path", location: src },
      "22222222-2222-2222-2222-222222222222",
    );
    expect(result.inPlace).toBe(false);
    expect(result.isGitRepo).toBe(true);
    expect(resolve(result.path)).not.toBe(resolve(src));
  });

  it("copies a plain (non-git) directory, excluding node_modules", async () => {
    const src = await makeTmpPlainDir();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "factory-ws-"));
    cleanupPaths.push(workspaceRoot);

    const result = await ingestExistingRepo(
      workspaceRoot,
      { type: "path", location: src },
      "33333333-3333-3333-3333-333333333333",
    );
    expect(result.isGitRepo).toBe(false);
    expect(result.inPlace).toBe(false);
    const pkg = await readFile(join(result.path, "package.json"), "utf8");
    expect(JSON.parse(pkg).name).toBe("plain-app");
    // node_modules excluded from the copy.
    await expect(stat(join(result.path, "node_modules"))).rejects.toThrow();
  });

  it("inPlace operates directly on the real path and checks out a dedicated branch", async () => {
    const src = await makeTmpGitRepo();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "factory-ws-"));
    cleanupPaths.push(workspaceRoot);

    const result = await ingestExistingRepo(
      workspaceRoot,
      { type: "path", location: src, inPlace: true },
      "44444444-4444-4444-4444-444444444444",
    );
    expect(result.inPlace).toBe(true);
    expect(result.path).toBe(resolve(src));
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: src,
    })
      .toString()
      .trim();
    expect(branch).toBe(result.branch);
    expect(branch).toMatch(/^factory-deck\//);
  });

  it("inPlace refuses a non-git directory", async () => {
    const src = await makeTmpPlainDir();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "factory-ws-"));
    cleanupPaths.push(workspaceRoot);
    await expect(
      ingestExistingRepo(
        workspaceRoot,
        { type: "path", location: src, inPlace: true },
        "55555555-5555-5555-5555-555555555555",
      ),
    ).rejects.toThrow(IngestError);
  });

  it("refuses a nonexistent local path", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "factory-ws-"));
    cleanupPaths.push(workspaceRoot);
    await expect(
      ingestExistingRepo(
        workspaceRoot,
        { type: "path", location: join(workspaceRoot, "does-not-exist") },
        "66666666-6666-6666-6666-666666666666",
      ),
    ).rejects.toThrow(IngestError);
  });

  it("refuses a location that looks like a flag (argv-injection shape)", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "factory-ws-"));
    cleanupPaths.push(workspaceRoot);
    await expect(
      ingestExistingRepo(
        workspaceRoot,
        { type: "git", location: "--upload-pack=evil" },
        "77777777-7777-7777-7777-777777777777",
      ),
    ).rejects.toThrow(IngestError);
  });
});
