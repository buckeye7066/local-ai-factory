import { describe, it, expect } from "vitest";
import { argsAreShellSafe, runCommand } from "../workspace/commandRunner.js";

describe("argsAreShellSafe", () => {
  it("accepts plain package-manager argv tokens", () => {
    expect(argsAreShellSafe("pnpm", ["install"])).toBe(true);
    expect(argsAreShellSafe("pnpm", ["run", "build"])).toBe(true);
    expect(argsAreShellSafe("npx", ["tsc", "--noEmit"])).toBe(true);
  });

  it("rejects every shell metacharacter", () => {
    for (const evil of [
      "install && del /s C:\\",
      "test; rm -rf .",
      "run|whoami",
      "build > out.txt",
      'x"y',
      "a b",
      "`cmd`",
      "$(cmd)",
      "%PATH%",
    ]) {
      expect(argsAreShellSafe("pnpm", ["run", evil])).toBe(false);
    }
  });
});

describe("runCommand shell safety on Windows", () => {
  it.runIf(process.platform === "win32")(
    "refuses allowlisted commands whose args are not shell-safe",
    async () => {
      const res = await runCommand(
        { bin: "pnpm", args: ["run", "build && del /q *"], cwd: process.cwd() },
        // allowScriptExecution granted so we reach (and prove) the shell-safety
        // check itself, rather than being stopped earlier by the approval gate.
        { workspaceRoot: process.cwd(), dryRun: false, allowScriptExecution: true },
      );
      expect(res.executed).toBe(false);
      expect(res.allowed).toBe(false);
      expect(res.reason).toMatch(/unsafe characters/i);
    },
  );
});
