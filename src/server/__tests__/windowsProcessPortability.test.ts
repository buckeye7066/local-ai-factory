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
