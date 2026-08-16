import { afterAll, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { slugifyAppId, storePublish } from "../orchestrator/storePublish.js";
import type { ExecFn } from "../orchestrator/deployRun.js";
import type { ExecResult } from "../workspace/gitOps.js";

const ROOT = resolve(process.cwd(), ".test-store-publish");
afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

const ok = (stdout: string): ExecResult => ({
  code: 0,
  stdout,
  stderr: "",
  spawnError: null,
});
const fail = (stderr: string): ExecResult => ({
  code: 1,
  stdout: "",
  stderr,
  spawnError: null,
});

function fakeExec(script: Array<(args: string[]) => ExecResult>) {
  const calls: Array<{ bin: string; args: string[]; cwd: string }> = [];
  let i = 0;
  const impl: ExecFn = async (bin, args, cwd) => {
    calls.push({ bin, args, cwd });
    const step = script[Math.min(i, script.length - 1)]!;
    i++;
    return step(args);
  };
  return { impl, calls };
}

async function storeDirWith(
  name: string,
  apps: Array<{ id: string }>,
): Promise<string> {
  const dir = resolve(ROOT, name);
  await mkdir(resolve(dir, "apps"), { recursive: true });
  await writeFile(
    resolve(dir, "apps", "registry.json"),
    JSON.stringify({ version: 1, updated: "2026-08-16", apps }, null, 2),
  );
  return dir;
}

const liveWith = (ids: string[]) =>
  (async () => ({
    ok: true,
    json: async () => ({ apps: ids.map((id) => ({ id })) }),
  })) as unknown as typeof fetch;

describe("slugifyAppId", () => {
  it("kebab-cases names into PromoPilot-compatible ids", () => {
    expect(slugifyAppId("My Cool App 2")).toBe("my-cool-app-2");
    expect(slugifyAppId("  ---  ")).toBe(null);
    expect(slugifyAppId(null)).toBe(null);
  });
});

describe("storePublish", () => {
  it("appends the app, rebuilds, deploys, and verifies against the LIVE registry", async () => {
    const dir = await storeDirWith("happy", [{ id: "grantflow" }]);
    const { impl, calls } = fakeExec([
      () => ok("built"),
      () => ok("Aliased: https://axiombiolabs.org"),
    ]);
    const result = await storePublish({
      appName: "Test App",
      runId: "r1",
      url: "https://test-app.up.railway.app",
      tagline: "A test app.",
      storeDir: dir,
      execImpl: impl,
      cliPathImpl: (rel) => `/fake/${rel}`,
      fetchImpl: liveWith(["grantflow", "test-app"]),
    });
    expect(result).toMatchObject({
      published: true,
      verified: true,
      appId: "test-app",
    });
    // Registry on disk carries the new entry with the live URL.
    const registry = JSON.parse(
      await readFile(resolve(dir, "apps", "registry.json"), "utf8"),
    );
    const entry = registry.apps.find((a: { id: string }) => a.id === "test-app");
    expect(entry.links.web).toBe("https://test-app.up.railway.app");
    expect(entry.tagline).toBe("A test app.");
    // build-store.py ran in the store dir, then vercel --prod --yes.
    expect(calls[0]).toMatchObject({ bin: "python", cwd: dir });
    expect(calls[1]!.args).toContain("--prod");
  });

  it("never re-writes an app that is already listed (owner edits are sacred)", async () => {
    const dir = await storeDirWith("existing", [{ id: "test-app" }]);
    const { impl, calls } = fakeExec([() => ok("")]);
    const result = await storePublish({
      appName: "Test App",
      runId: "r2",
      url: "https://elsewhere.example",
      storeDir: dir,
      execImpl: impl,
      cliPathImpl: () => "/fake/vc.js",
      fetchImpl: liveWith(["test-app"]),
    });
    expect(result.published).toBe(false);
    expect(result.reason).toMatch(/already listed/);
    expect(calls.length).toBe(0); // no rebuild, no deploy
  });

  it("reports a failed rebuild honestly - registry updated, nothing published", async () => {
    const dir = await storeDirWith("buildfail", []);
    const { impl } = fakeExec([() => fail("SyntaxError: boom")]);
    const result = await storePublish({
      appName: "Broken Build",
      runId: "r3",
      url: "https://x.up.railway.app",
      storeDir: dir,
      execImpl: impl,
      cliPathImpl: () => "/fake/vc.js",
      fetchImpl: liveWith([]),
    });
    expect(result.published).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/rebuild failed/);
  });

  it("a deploy that succeeds but is not yet observed live is published-but-unverified", async () => {
    const dir = await storeDirWith("unverified", []);
    const { impl } = fakeExec([() => ok("built"), () => ok("deployed")]);
    const result = await storePublish({
      appName: "Slow Propagation",
      runId: "r4",
      url: "https://slow.up.railway.app",
      storeDir: dir,
      execImpl: impl,
      cliPathImpl: () => "/fake/vc.js",
      fetchImpl: liveWith(["something-else"]),
    });
    expect(result.published).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/not observed/);
  });

  it("declines honestly when the store registry does not exist", async () => {
    const result = await storePublish({
      appName: "No Store",
      runId: "r5",
      url: "https://x.example",
      storeDir: resolve(ROOT, "missing-dir"),
      execImpl: fakeExec([() => ok("")]).impl,
      cliPathImpl: () => "/fake/vc.js",
      fetchImpl: liveWith([]),
    });
    expect(result.published).toBe(false);
    expect(result.reason).toMatch(/not found/);
  });
});
