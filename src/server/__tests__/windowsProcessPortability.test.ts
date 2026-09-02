import { describe, expect, it } from "vitest";
import { assessWindowsProcessPortability } from "../workspace/windowsProcessPortability.js";

describe("Windows child-process portability audit", () => {
  it("rejects the exact npm.cmd execFile pattern observed on the Windows runner", () => {
    const issues = assessWindowsProcessPortability([
      {
        path: "tests/cliProcess.test.ts",
        contents: `
          import { execFile } from "node:child_process";
          import { promisify } from "node:util";
          const execFileAsync = promisify(execFile);
          const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
          await execFileAsync(npmCommand, ["run", "build"]);
        `,
      },
    ]);

    expect(issues).toEqual([
      expect.objectContaining({
        path: "tests/cliProcess.test.ts",
        reason: expect.stringContaining("spawn EINVAL"),
      }),
    ]);
  });

  it("resolves aliased imports, namespaces, require destructuring, and promisify", () => {
    const issues = assessWindowsProcessPortability([
      {
        path: "tests/aliases.test.ts",
        contents: `
          import * as child from "node:child_process";
          import { spawn as launch, execFile } from "child_process";
          import { promisify as makeAsync } from "node:util";
          const { spawnSync: launchSync } = require("node:child_process");
          const runFile = makeAsync(execFile);
          const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
          launch(npmCommand, ["test"]);
          child.execFile(npmCommand, ["test"]);
          launchSync(npmCommand, ["test"]);
          await runFile(npmCommand, ["test"]);
        `,
      },
    ]);

    expect(issues).toHaveLength(4);
    expect(issues.map((issue) => issue.reason)).toEqual([
      expect.stringContaining("spawn directly"),
      expect.stringContaining("execFile directly"),
      expect.stringContaining("spawnSync directly"),
      expect.stringContaining("execFile directly"),
    ]);
  });

  it("ignores comments, fixture strings, and unrelated same-named functions", () => {
    expect(
      assessWindowsProcessPortability([
        {
          path: "tests/fixtures.test.ts",
          contents: `
            // execFile("npm.cmd", ["test"]);
            const fixture = 'spawn("npm.cmd", ["test"])';
            function spawn(command: string) { return command; }
            spawn("npm.cmd");
          `,
        },
      ]),
    ).toEqual([]);
  });

  it("accepts real executables and deliberately shell-enabled wrappers", () => {
    expect(
      assessWindowsProcessPortability([
        {
          path: "tests/portable.test.ts",
          contents: `
            const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
            await execFileAsync(npmCommand, ["test"], { shell: true });
            await execFileAsync(process.execPath, ["dist/index.js", "help"]);
          `,
        },
      ]),
    ).toEqual([]);
  });

  it("does not interpret prose or non-code files as process launches", () => {
    expect(
      assessWindowsProcessPortability([
        {
          path: "README.md",
          contents: "Use npm.cmd on Windows; execFile is discussed here.",
        },
      ]),
    ).toEqual([]);
  });
});
