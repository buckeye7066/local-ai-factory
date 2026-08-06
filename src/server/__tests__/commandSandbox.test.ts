import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter, resolve, sep } from "node:path";
import {
  sanitizeChildEnv,
  looksLikeCredentialUrl,
  isScriptExecuting,
  resolvePmBinary,
  isInsideWorkspace,
  runCommand,
} from "../workspace/commandRunner.js";
import {
  toHealth,
  isFactoryHealthPayload,
  loadConfig,
  loadSecrets,
} from "../config.js";

/**
 * Defense-in-depth sandbox tests (Codex follow-up). These prove the boundaries
 * hold even when DRY_RUN is OFF — without ever executing an untrusted product.
 */

const scratch: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "factsbx-"));
  scratch.push(d);
  return d;
}
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

/* #1 — credential-bearing URLs/DSNs must not reach the child env. */
describe("#1 sanitizeChildEnv drops credential URLs / DSNs (allowlist)", () => {
  it("keeps only allowlisted names; drops DATABASE_URL and MONGODB_URI", () => {
    const clean = sanitizeChildEnv({
      PATH: "/usr/bin",
      HOME: "/home/x",
      NODE_ENV: "production",
      DATABASE_URL: "postgres://user:pass@db.internal:5432/app",
      MONGODB_URI: "mongodb+srv://admin:hunter2@cluster0.mongodb.net/prod",
      REDIS_URL: "redis://:sekret@cache:6379",
      SUPABASE_ANON: "public-but-not-allowlisted",
      ANTHROPIC_API_KEY: "sk-ant-leak",
    });
    expect(clean.PATH).toBe("/usr/bin");
    expect(clean.HOME).toBe("/home/x");
    expect(clean.NODE_ENV).toBe("production");
    expect(clean.DATABASE_URL).toBeUndefined();
    expect(clean.MONGODB_URI).toBeUndefined();
    expect(clean.REDIS_URL).toBeUndefined();
    expect(clean.SUPABASE_ANON).toBeUndefined();
    expect(clean.ANTHROPIC_API_KEY).toBeUndefined();
    const blob = JSON.stringify(clean);
    expect(blob).not.toContain("pass");
    expect(blob).not.toContain("hunter2");
    expect(blob).not.toContain("sekret");
  });

  it("classifies credential URLs by value", () => {
    expect(looksLikeCredentialUrl("postgres://u:p@h/db")).toBe(true);
    expect(looksLikeCredentialUrl("mongodb+srv://a:b@c.net")).toBe(true);
    expect(looksLikeCredentialUrl("https://example.com/path")).toBe(false);
    expect(looksLikeCredentialUrl("/usr/local/bin")).toBe(false);
  });

  it("strips workspace directories out of PATH", () => {
    const ws = resolve("/tmp/ws-xyz");
    const path = ["/usr/bin", join(ws, "node_modules/.bin"), "/bin"].join(delimiter);
    const clean = sanitizeChildEnv({ PATH: path }, ws);
    expect(clean.PATH).not.toContain(ws);
    expect(clean.PATH).toContain("/usr/bin");
  });
});

/* #2/#3 — package-manager script execution is untrusted + gated.
 * Round-7 finding #1: installs are gated too (a project `.pnpmfile.cjs` runs
 * during resolution and --ignore-scripts does NOT disable it). */
describe("#2/#3 model-authored scripts require explicit approval", () => {
  it("classifies EVERY allowlisted command as project-code-executing (incl. install)", () => {
    expect(isScriptExecuting("pnpm", ["install"])).toBe(true);
    expect(isScriptExecuting("npm", ["ci"])).toBe(true);
    expect(isScriptExecuting("pnpm", ["test"])).toBe(true);
    expect(isScriptExecuting("pnpm", ["build"])).toBe(true);
    expect(isScriptExecuting("npm", ["run", "start"])).toBe(true);
    expect(isScriptExecuting("npx", ["tsc"])).toBe(true);
  });

  it("refuses `pnpm test` when dry-run is OFF and no approval given", async () => {
    const ws = tmp();
    const res = await runCommand(
      { bin: "pnpm", args: ["test"], cwd: ws },
      { workspaceRoot: ws, dryRun: false }, // dry-run off, but NOT approved
    );
    expect(res.executed).toBe(false);
    expect(res.allowed).toBe(false);
    expect(res.reason).toMatch(/explicit approval|ALLOW_UNTRUSTED_SCRIPTS/i);
  });
});

/* #4 — a package manager planted in the workspace must never shadow the real one. */
describe("#4 resolvePmBinary never resolves from the workspace", () => {
  it("skips a workspace pnpm.cmd even when it is first on PATH", () => {
    const root = tmp();
    const ws = join(root, "ws");
    const trusted = join(root, "trusted");
    mkdirSync(ws, { recursive: true });
    mkdirSync(trusted, { recursive: true });
    // Plant a malicious PM shim in the workspace and a real one in a trusted dir.
    for (const dir of [ws, trusted]) {
      writeFileSync(join(dir, "pnpm"), "#!/bin/sh\n");
      writeFileSync(join(dir, "pnpm.cmd"), "@echo off\n");
    }
    const pathEnv = [ws, trusted].join(delimiter); // workspace FIRST
    const resolved = resolvePmBinary("pnpm", ws, pathEnv);
    expect(resolved).not.toBeNull();
    expect(resolved!.startsWith(resolve(trusted))).toBe(true);
    expect(resolved!.startsWith(resolve(ws) + sep)).toBe(false);
  });

  it("returns null when the only candidate is inside the workspace", () => {
    const ws = tmp();
    writeFileSync(join(ws, "pnpm"), "#!/bin/sh\n");
    writeFileSync(join(ws, "pnpm.cmd"), "@echo off\n");
    expect(resolvePmBinary("pnpm", ws, ws)).toBeNull();
  });
});

/* #5 — the jail is a boundary check, documented as NOT a runtime FS sandbox. */
describe("#5 workspace cwd boundary check", () => {
  it("accepts the root and paths inside, rejects paths outside", () => {
    const root = resolve("/tmp/jail");
    expect(isInsideWorkspace(root, root)).toBe(true);
    expect(isInsideWorkspace(root, join(root, "src"))).toBe(true);
    expect(isInsideWorkspace(root, join(root, ".."))).toBe(false);
    expect(isInsideWorkspace(root, "/etc")).toBe(false);
  });
});

/* #6 — an occupied port is only "ours" if the health marker matches. */
describe("#6 Factory Deck health signature", () => {
  it("accepts a real Factory Deck health payload", () => {
    const health = toHealth(loadConfig({}), loadSecrets({}));
    expect(isFactoryHealthPayload(health)).toBe(true);
  });

  it("rejects foreign / missing-marker payloads", () => {
    expect(isFactoryHealthPayload({ ok: true })).toBe(false); // no service marker
    expect(isFactoryHealthPayload({ status: "ok" })).toBe(false);
    expect(isFactoryHealthPayload({ ok: true, service: "grafana" })).toBe(false);
    expect(isFactoryHealthPayload(null)).toBe(false);
    expect(isFactoryHealthPayload("factory-deck")).toBe(false);
  });
});
