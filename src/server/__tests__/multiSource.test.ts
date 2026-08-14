import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { loadConfig } from "../config.js";
import { ingestAdditionalSource } from "../orchestrator/ingestAdditionalSource.js";
import { repoResolverAgent } from "../agents/repoResolverAgent.js";
import type { LLMProvider, GenerateJsonInput } from "../../shared/types.js";

const cleanupPaths: string[] = [];
afterAll(async () => {
  await Promise.all(cleanupPaths.map((p) => rm(p, { recursive: true, force: true })));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

class ScriptedProvider implements LLMProvider {
  readonly name = "mock" as const;
  calls = 0;
  constructor(private script: unknown[]) {}
  isConfigured() {
    return true;
  }
  async generateText() {
    return { text: "", provider: this.name };
  }
  async generateJson<T>(input: GenerateJsonInput<T>): Promise<T> {
    const raw = this.script[this.calls];
    this.calls += 1;
    if (raw === undefined) throw new Error("ScriptedProvider ran out of script.");
    return input.schema.parse(raw) as T;
  }
}

async function makeTmpGitRepo(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `factory-multisrc-${name}-`));
  cleanupPaths.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name }));
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

describe("ingestAdditionalSource", () => {
  it("ingests a local git repo (owned or not) read-only for gleaning, never inPlace", async () => {
    const src = await makeTmpGitRepo("source-app");
    const workspaceRoot = await mkdtemp(join(tmpdir(), "factory-multisrc-ws-"));
    cleanupPaths.push(workspaceRoot);
    const config = { ...loadConfig({}), workspaceRoot, allowUntrustedScripts: false };

    const ctx = await ingestAdditionalSource(
      config,
      { type: "path", location: src, inPlace: true },
      "11111111",
      0,
    );

    expect(ctx.label).toBe("source-app");
    expect(ctx.manifestExcerpt).toContain("source-app");
    // inPlace:true on the input is IGNORED for additional sources — the
    // source directory itself must be untouched (no branch created there).
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: src,
    })
      .toString()
      .trim();
    expect(branch).not.toMatch(/^factory-deck\//);
  });

  it("falls back to a plain fetch for a non-repo directory/URL — 'not just repos'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            url: "https://example.com/some-api-docs",
            headers: new Headers({ "content-type": "text/html" }),
            arrayBuffer: async () =>
              new TextEncoder().encode(
                "<html><body>Some API docs content here.</body></html>",
              ).buffer,
          }) as unknown as Response,
      ),
    );
    const config = loadConfig({});
    const ctx = await ingestAdditionalSource(
      config,
      { type: "git", location: "https://example.com/some-api-docs" },
      "22222222",
      0,
    );
    expect(ctx.fileTreeExcerpt).toBe(""); // not a codebase — nothing to list
    expect(ctx.readmeExcerpt).toContain("fetched web page");
    expect(ctx.readmeExcerpt).toContain("Some API docs content");
  });

  it("ingests a plain (non-git) local folder as a reference too — 'apps and programs', not just git repos", async () => {
    const dir = await mkdtemp(join(tmpdir(), "factory-multisrc-plain-"));
    cleanupPaths.push(dir);
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "plain-program" }),
    );
    const workspaceRoot = await mkdtemp(join(tmpdir(), "factory-multisrc-ws2-"));
    cleanupPaths.push(workspaceRoot);
    const config = { ...loadConfig({}), workspaceRoot, allowUntrustedScripts: false };

    const ctx = await ingestAdditionalSource(
      config,
      { type: "path", location: dir },
      "33333333",
      0,
    );
    expect(ctx.label).toBe("plain-program");
  });
});

describe("repoResolverAgent — multi-program combination", () => {
  it("resolves a primary target AND additional sources from a two-URL prompt (fast path skipped for multi-URL)", async () => {
    const provider = new ScriptedProvider([
      {
        thought: "two repos referenced — combine them",
        action: "resolve",
        repoType: "git",
        location: "https://github.com/owner/target-app",
        additionalSources: [
          { repoType: "git", location: "https://github.com/owner/reference-app" },
        ],
        goals: ["Port the auth system from reference-app into target-app"],
      },
    ]);
    const result = await repoResolverAgent(
      { provider },
      "combine https://github.com/owner/target-app and https://github.com/owner/reference-app — take the auth system from the second into the first",
    );
    expect(result.repoSource).toEqual({
      type: "git",
      location: "https://github.com/owner/target-app",
    });
    expect(result.additionalSources).toEqual([
      { type: "git", location: "https://github.com/owner/reference-app" },
    ]);
    expect(result.goals[0]).toContain("Port the auth system");
  });

  it("single-URL prompts still take the fast path with an empty additionalSources array", async () => {
    const provider = new ScriptedProvider([]); // must never be called
    const result = await repoResolverAgent(
      { provider },
      "fix the bug at https://github.com/owner/one-repo",
    );
    expect(provider.calls).toBe(0);
    expect(result.additionalSources).toEqual([]);
  });
});
