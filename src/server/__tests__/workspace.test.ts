import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { safeResolve, WorkspacePathError } from "../workspace/fileWriter.js";
import {
  isAllowed,
  isInsideWorkspace,
  runCommand,
} from "../workspace/commandRunner.js";
import { workspaceSlug } from "../workspace/createWorkspace.js";

const ROOT = resolve(process.cwd(), "workspaces", "demo-app");

describe("workspace path safety", () => {
  it("resolves a normal relative path inside the workspace", () => {
    const p = safeResolve(ROOT, "src/App.tsx");
    expect(p.startsWith(resolve(ROOT))).toBe(true);
  });

  it("rejects path traversal with ..", () => {
    expect(() => safeResolve(ROOT, "../../etc/passwd")).toThrow(WorkspacePathError);
    expect(() => safeResolve(ROOT, "../secret.txt")).toThrow(WorkspacePathError);
  });

  it("rejects absolute paths", () => {
    expect(() => safeResolve(ROOT, "/etc/hosts")).toThrow(WorkspacePathError);
  });

  it("rejects empty paths", () => {
    expect(() => safeResolve(ROOT, "")).toThrow(WorkspacePathError);
  });
});

describe("command allowlist", () => {
  it("allows package-manager subcommands", () => {
    expect(isAllowed("pnpm", ["install"])).toBe(true);
    expect(isAllowed("pnpm", ["test"])).toBe(true);
    expect(isAllowed("npm", ["run", "build"])).toBe(true);
  });

  it("blocks anything not on the allowlist", () => {
    expect(isAllowed("rm", ["-rf", "/"])).toBe(false);
    expect(isAllowed("curl", ["http://evil"])).toBe(false);
    expect(isAllowed("pnpm", ["dlx", "anything"])).toBe(false);
    expect(isAllowed("git", ["push"])).toBe(false);
  });

  it("refuses to run outside the workspace", () => {
    expect(isInsideWorkspace(ROOT, resolve(ROOT, "src"))).toBe(true);
    expect(isInsideWorkspace(ROOT, resolve(ROOT, ".."))).toBe(false);
  });

  it("does not execute non-allowlisted commands", async () => {
    const res = await runCommand(
      { bin: "rm", args: ["-rf", "."], cwd: ROOT },
      { workspaceRoot: ROOT },
    );
    expect(res.allowed).toBe(false);
    expect(res.executed).toBe(false);
  });

  it("refuses script-executing commands when script execution is disabled", async () => {
    const res = await runCommand(
      { bin: "pnpm", args: ["install"], cwd: ROOT },
      { workspaceRoot: ROOT }, // allowScriptExecution unset → hermetic refusal
    );
    expect(res.allowed).toBe(false);
    expect(res.executed).toBe(false);
    expect(res.reason).toContain("ALLOW_UNTRUSTED_SCRIPTS");
  });
});

describe("workspace slug", () => {
  it("produces a filesystem-safe slug", () => {
    const slug = workspaceSlug("My Cool App!!", "abcd1234efgh");
    expect(slug).toMatch(/^my-cool-app-abcd1234$/);
  });
});
