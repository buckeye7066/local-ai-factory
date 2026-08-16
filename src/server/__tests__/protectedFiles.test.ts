import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assessProtectedHostWrite,
  _resetProtectedFilesCache,
} from "../workspace/protectedFiles.js";

const workspaces: string[] = [];
function gitWorkspace(files: Record<string, string>): string {
  const path = mkdtempSync(join(tmpdir(), "factory-protected-"));
  workspaces.push(path);
  for (const [rel, contents] of Object.entries(files)) {
    writeFileSync(join(path, rel), contents);
  }
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", path, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "host");
  return path;
}
afterEach(() => {
  _resetProtectedFilesCache();
  for (const path of workspaces.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

const HOST_MANIFEST = JSON.stringify({
  name: "grant-flow",
  scripts: Object.fromEntries(
    Array.from({ length: 87 }, (_, i) => [`script${i}`, "echo ok"]),
  ),
});

describe("assessProtectedHostWrite", () => {
  it("refuses the a8a9c84a stub: a 192-byte replacement of a 10KB tracked package.json", () => {
    const ws = gitWorkspace({
      "package.json": HOST_MANIFEST,
      "package-lock.json": "{}",
    });
    const stub =
      '{"name":"grant-flow","private":true,"type":"module","scripts":{"test":"vitest run"}}';
    const verdict = assessProtectedHostWrite(ws, "package.json", stub);
    expect(verdict.refused).toBe(true);
    expect(verdict.reason).toMatch(/collapse the host manifest/);
  });

  it("ALLOWS additive package.json edits (adding a dependency must keep working)", () => {
    const ws = gitWorkspace({ "package.json": HOST_MANIFEST });
    const grown = HOST_MANIFEST.replace(
      '"name"',
      '"devDependencies":{"axe-core":"^4.9.0"},"name"',
    );
    expect(assessProtectedHostWrite(ws, "package.json", grown).refused).toBe(false);
  });

  it("refuses every generated write to tracked lockfiles", () => {
    const ws = gitWorkspace({
      "package.json": HOST_MANIFEST,
      "package-lock.json": "{}",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    });
    for (const lock of ["package-lock.json", "pnpm-lock.yaml"]) {
      const verdict = assessProtectedHostWrite(ws, lock, "anything");
      expect(verdict.refused, lock).toBe(true);
      expect(verdict.reason).toMatch(/derived artifacts/);
    }
  });

  it("refuses replacing a tracked root tool config, and the new-variant hijack beside it", () => {
    const ws = gitWorkspace({
      "package.json": HOST_MANIFEST,
      "vitest.config.js": "export default {}\n",
    });
    expect(
      assessProtectedHostWrite(ws, "vitest.config.js", "export default { hijacked: true }").refused,
    ).toBe(true);
    // The subtle one: NEW vitest.config.ts outranks the tracked .js in vitest's
    // resolution — writing it redirects discovery without touching a tracked file.
    const hijack = assessProtectedHostWrite(ws, "vitest.config.ts", "export default {}");
    expect(hijack.refused).toBe(true);
    expect(hijack.reason).toMatch(/take precedence/);
  });

  it("allows a root tool config for a tool the host does NOT use, and non-root configs", () => {
    const ws = gitWorkspace({ "package.json": HOST_MANIFEST });
    expect(assessProtectedHostWrite(ws, "playwright.config.ts", "export default {}").refused).toBe(false);
    expect(assessProtectedHostWrite(ws, "packages/sub/vitest.config.ts", "export default {}").refused).toBe(false);
  });

  it("is inert for non-git (new-app) workspaces", () => {
    const path = mkdtempSync(join(tmpdir(), "factory-protected-nogit-"));
    workspaces.push(path);
    writeFileSync(join(path, "package.json"), HOST_MANIFEST);
    expect(assessProtectedHostWrite(path, "package.json", "{}").refused).toBe(false);
  });
});
