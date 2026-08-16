import { afterAll, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  chooseTarget,
  deployRun,
  resolveNpmCli,
  type ExecFn,
} from "../orchestrator/deployRun.js";
import type { ExecResult } from "../workspace/gitOps.js";

const ROOT = resolve(process.cwd(), ".test-deploy-workspaces");
afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "", spawnError: null });
const fail = (stderr: string): ExecResult => ({ code: 1, stdout: "", stderr, spawnError: null });

function fakeExec(script: Array<(args: string[]) => ExecResult>) {
  const calls: string[][] = [];
  let i = 0;
  const impl: ExecFn = async (_bin, args) => {
    calls.push(args);
    const step = script[Math.min(i, script.length - 1)]!;
    i++;
    return step(args);
  };
  return { impl, calls };
}

async function serverWorkspace(name: string): Promise<string> {
  const dir = resolve(ROOT, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    resolve(dir, "package.json"),
    JSON.stringify({ name, scripts: { start: "node server.js" } }),
  );
  return dir;
}

async function staticWorkspace(name: string): Promise<string> {
  const dir = resolve(ROOT, name);
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, "index.html"), "<!doctype html><h1>hi</h1>");
  return dir;
}

const fetchOk = (async () => ({ status: 200 })) as unknown as typeof fetch;
const fetchDown = (async () => ({ status: 503 })) as unknown as typeof fetch;

describe("chooseTarget — mechanical shape detection", () => {
  it("routes start-script apps to Railway and index.html apps to Vercel", async () => {
    expect(chooseTarget(await serverWorkspace("srv")).target).toBe("railway");
    expect(chooseTarget(await staticWorkspace("web")).target).toBe("vercel");
  });
  it("declines honestly when the shape fits neither host", async () => {
    const dir = resolve(ROOT, "bare");
    await mkdir(dir, { recursive: true });
    const res = chooseTarget(dir);
    expect(res.target).toBeNull();
    expect(res.reason).toMatch(/cannot pick a host/i);
  });
});

describe("resolveNpmCli", () => {
  it("returns null for a CLI that is not installed", () => {
    expect(resolveNpmCli("definitely-not-a-real-cli/bin/x.js")).toBeNull();
  });
});

describe("deployRun — Railway lane", () => {
  it("init → up → domain → probe, claims live only after the URL answers", async () => {
    const ws = await serverWorkspace("srv-live");
    const { impl, calls } = fakeExec([
      (a) => (a.includes("init") ? ok("Created project") : ok("")),
      (a) => (a.includes("up") ? ok("Build started") : ok("")),
      (a) => (a.includes("domain") ? ok("https://srv-live.up.railway.app") : ok("")),
    ]);
    const res = await deployRun({
      workspacePath: ws, appName: "Srv Live!", runId: "r1",
      execImpl: impl, fetchImpl: fetchOk, sleepImpl: async () => {}, probeTimeoutMs: 1,
    });
    expect(res).toMatchObject({
      deployed: true, verified: true, target: "railway",
      url: "https://srv-live.up.railway.app",
    });
    // node <cli.js> subcommands — the slug is lowercase/dash, never raw.
    expect(calls[0]).toContain("--name");
    expect(calls[0]).toContain("srv-live");
    expect(calls[1]).toContain("--detach");
  });

  it("reports deployed-but-unverified when the URL never answers", async () => {
    const ws = await serverWorkspace("srv-down");
    const { impl } = fakeExec([
      () => ok("Created project"),
      () => ok("Build started"),
      () => ok("https://srv-down.up.railway.app"),
    ]);
    const res = await deployRun({
      workspacePath: ws, appName: "srv-down", runId: "r2",
      execImpl: impl, fetchImpl: fetchDown, sleepImpl: async () => {}, probeTimeoutMs: 1,
    });
    expect(res.deployed).toBe(true);
    expect(res.verified).toBe(false);
    expect(res.reason).toMatch(/did not answer/i);
  });

  it("fails honestly when railway up fails", async () => {
    const ws = await serverWorkspace("srv-fail");
    const { impl } = fakeExec([
      () => ok("Created project"),
      () => fail("Nixpacks was unable to generate a build plan"),
    ]);
    const res = await deployRun({
      workspacePath: ws, appName: "srv-fail", runId: "r3",
      execImpl: impl, fetchImpl: fetchOk, sleepImpl: async () => {}, probeTimeoutMs: 1,
    });
    expect(res.deployed).toBe(false);
    expect(res.reason).toMatch(/railway up failed.*Nixpacks/i);
  });

  it("tolerates an already-initialized project dir", async () => {
    const ws = await serverWorkspace("srv-again");
    const { impl } = fakeExec([
      () => fail("Project already exists"),
      () => ok("Build started"),
      () => ok("https://srv-again.up.railway.app"),
    ]);
    const res = await deployRun({
      workspacePath: ws, appName: "srv-again", runId: "r4",
      execImpl: impl, fetchImpl: fetchOk, sleepImpl: async () => {}, probeTimeoutMs: 1,
    });
    expect(res.deployed).toBe(true);
    expect(res.verified).toBe(true);
  });
});

describe("deployRun — Vercel lane", () => {
  it("link → deploy --prod → probe", async () => {
    const ws = await staticWorkspace("web-live");
    const { impl, calls } = fakeExec([
      (a) => (a.includes("link") ? ok("Linked") : ok("")),
      (a) => (a.includes("deploy") ? ok("https://web-live.vercel.app") : ok("")),
    ]);
    const res = await deployRun({
      workspacePath: ws, appName: "web-live", runId: "r5",
      execImpl: impl, fetchImpl: fetchOk, sleepImpl: async () => {}, probeTimeoutMs: 1,
    });
    expect(res).toMatchObject({
      deployed: true, verified: true, target: "vercel",
      url: "https://web-live.vercel.app",
    });
    expect(calls[1]).toContain("--prod");
    expect(calls[1]).toContain("--yes");
  });

  it("never claims a URL it did not receive", async () => {
    const ws = await staticWorkspace("web-nourl");
    const { impl } = fakeExec([
      () => ok("Linked"),
      () => ok("Deployment queued"),
    ]);
    const res = await deployRun({
      workspacePath: ws, appName: "web-nourl", runId: "r6",
      execImpl: impl, fetchImpl: fetchOk, sleepImpl: async () => {}, probeTimeoutMs: 1,
    });
    expect(res.url).toBeNull();
    expect(res.verified).toBe(false);
    expect(res.reason).toMatch(/no production URL/i);
  });
});
