import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runCommand,
  hardenArgs,
  isScriptExecuting,
} from "../workspace/commandRunner.js";

/**
 * Round-7 finding #1 — `pnpm install` runs project-controlled code (a generated
 * `.pnpmfile.cjs` executes during resolution; `--ignore-scripts` does NOT
 * disable it). Installs must therefore be behind the same approval gate as
 * test/build, and pnpm installs must also get `--ignore-pnpmfile`.
 */

const scratch: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "factinst-"));
  scratch.push(d);
  return d;
}
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

/** Plant a hostile `.pnpmfile.cjs` that writes a sentinel if it is ever loaded. */
function plantHostilePnpmfile(ws: string, sentinel: string) {
  writeFileSync(
    join(ws, ".pnpmfile.cjs"),
    `const fs=require('fs');module.exports={hooks:{readPackage(pkg){` +
      `fs.writeFileSync(${JSON.stringify(sentinel)},'pwned');return pkg;}}};`,
  );
}

describe("Round-7 #1 pnpm install is gated + pnpmfile neutralized", () => {
  it("classifies install/ci as project-code-executing (so the gate applies)", () => {
    expect(isScriptExecuting("pnpm", ["install"])).toBe(true);
    expect(isScriptExecuting("npm", ["ci"])).toBe(true);
  });

  it("refuses `pnpm install` (script execution disabled) so a workspace .pnpmfile.cjs never runs", async () => {
    const ws = tmp();
    const sentinel = join(ws, "PWNED.txt");
    plantHostilePnpmfile(ws, sentinel);

    const res = await runCommand(
      { bin: "pnpm", args: ["install"], cwd: ws },
      { workspaceRoot: ws }, // allowScriptExecution unset → refused
    );

    expect(res.executed).toBe(false);
    expect(res.allowed).toBe(false);
    expect(res.reason).toMatch(/approval|ALLOW_UNTRUSTED_SCRIPTS/i);
    // The hook never ran because we never spawned pnpm.
    expect(existsSync(sentinel)).toBe(false);
  });

  it("adds --ignore-pnpmfile (and --ignore-scripts) for pnpm installs, idempotently", () => {
    expect(hardenArgs("pnpm", ["install"])).toEqual([
      "install",
      "--ignore-scripts",
      "--ignore-pnpmfile",
    ]);
    // Idempotent — no duplicate flags on re-hardening.
    expect(
      hardenArgs("pnpm", ["install", "--ignore-scripts", "--ignore-pnpmfile"]),
    ).toEqual(["install", "--ignore-scripts", "--ignore-pnpmfile"]);
    // npm/yarn have no pnpmfile — only --ignore-scripts is injected.
    expect(hardenArgs("npm", ["install"])).toEqual(["install", "--ignore-scripts"]);
    // Non-install commands are untouched.
    expect(hardenArgs("pnpm", ["test"])).toEqual(["test"]);
  });

  // Round-9 #1: substring-fragile check defeated by `--ignore-scripts=false`.
  it("strips caller-supplied --ignore-scripts=false / --ignore-pnpmfile=false and re-hardens (canonical flags win)", () => {
    const out = hardenArgs("pnpm", [
      "install",
      "--ignore-scripts=false",
      "--ignore-pnpmfile=false",
    ]);
    // The defeating variants are gone…
    expect(out).not.toContain("--ignore-scripts=false");
    expect(out).not.toContain("--ignore-pnpmfile=false");
    // …and the canonical hardening flags are present, appended last.
    expect(out).toEqual(["install", "--ignore-scripts", "--ignore-pnpmfile"]);
    // npm variant likewise re-hardened (no pnpmfile flag for npm).
    expect(hardenArgs("npm", ["install", "--ignore-scripts=false"])).toEqual([
      "install",
      "--ignore-scripts",
    ]);
  });

  // Round-10 #1: the strip must be case-INSENSITIVE.
  it("strips mixed-case --Ignore-Scripts / --IGNORE-PNPMFILE variants too", () => {
    const out = hardenArgs("pnpm", [
      "install",
      "--Ignore-Scripts=false",
      "--IGNORE-PNPMFILE=false",
    ]);
    expect(out).not.toContain("--Ignore-Scripts=false");
    expect(out).not.toContain("--IGNORE-PNPMFILE=false");
    expect(out).toEqual(["install", "--ignore-scripts", "--ignore-pnpmfile"]);
  });
});
