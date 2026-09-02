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
          const propertyFile = require("node:child_process").execFile;
          const namespaceFile = makeAsync(child.execFile);
          const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
          launch(npmCommand, ["test"]);
          child.execFile(npmCommand, ["test"]);
          launchSync(npmCommand, ["test"]);
          await runFile(npmCommand, ["test"]);
          await propertyFile(npmCommand, ["test"]);
          await namespaceFile(npmCommand, ["test"]);
        `,
      },
    ]);

    expect(issues).toHaveLength(6);
    expect(issues.map((issue) => issue.reason)).toEqual([
      expect.stringContaining("spawn directly"),
      expect.stringContaining("execFile directly"),
      expect.stringContaining("spawnSync directly"),
      expect.stringContaining("execFile directly"),
      expect.stringContaining("execFile directly"),
      expect.stringContaining("execFile directly"),
    ]);
  });

  it("detects interpolated batch suffixes without crossing lexical shadows", () => {
    const issues = assessWindowsProcessPortability([
      {
        path: "tests/scopes.test.ts",
        contents: `
          import { spawn as launch } from "node:child_process";
          const tool = "npm";
          function invoke(launch: (command: string) => void) {
            launch("npm.cmd");
          }
          launch(\`\${tool}.cmd\`, ["test"]);
        `,
      },
    ]);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      path: "tests/scopes.test.ts",
      reason: expect.stringContaining("spawn directly"),
    });
  });

  it("resolves tracked namespace destructuring, import-equals, and util namespaces", () => {
    const issues = assessWindowsProcessPortability([
      {
        path: "tests/commonjsAliases.test.ts",
        contents: `
          import childImport = require("node:child_process");
          import * as util from "node:util";
          const child = require("node:child_process");
          const { spawn: launch, execFile } = child;
          const runFile = util.promisify(execFile);
          launch("npm.cmd", ["test"]);
          await runFile("yarn.cmd", ["test"]);
          childImport.spawn("pnpm.cmd", ["test"]);
        `,
      },
    ]);

    expect(issues).toHaveLength(3);
    expect(issues.map((issue) => issue.reason)).toEqual([
      expect.stringContaining("spawn directly"),
      expect.stringContaining("execFile directly"),
      expect.stringContaining("spawn directly"),
    ]);
  });

  it("keeps loop-header shadows inside their lexical loop scope", () => {
    const issues = assessWindowsProcessPortability([
      {
        path: "tests/loopScopes.test.ts",
        contents: `
          import { spawn } from "node:child_process";
          declare const callbacks: Array<(command: string) => void>;
          for (const spawn of callbacks) {
            spawn("npm.cmd");
          }
          spawn("npm.cmd", ["test"]);
        `,
      },
    ]);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.reason).toContain("spawn directly");
  });

  it("tracks selected command properties without poisoning sibling values", () => {
    const issues = assessWindowsProcessPortability([
      {
        path: "tests/commandProperties.test.ts",
        contents: `
          import { spawn } from "node:child_process";
          const commands = {
            windows: "npm.cmd",
            native: process.execPath,
          };
          spawn(commands.native, ["dist/index.js"]);
          spawn(commands.windows, ["test"]);
        `,
      },
    ]);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.reason).toContain("spawn directly");
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
            import { execFile } from "node:child_process";
            import { promisify } from "node:util";
            const execFileAsync = promisify(execFile);
            const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
            await execFileAsync(npmCommand, ["test"], {
              shell: true as const,
            } satisfies { shell: boolean });
            await execFileAsync(process.execPath, ["dist/index.js", "help"]);
          `,
        },
      ]),
    ).toEqual([]);
  });

  it("respects object spread ordering when proving shell is true", () => {
    const issues = assessWindowsProcessPortability([
      {
        path: "tests/shellSpreads.test.ts",
        contents: `
          import { spawn } from "node:child_process";
          const defaults = { shell: false };
          spawn("npm.cmd", ["test"], { shell: true, ...defaults });
          spawn("npm.cmd", ["test"], { ...defaults, shell: true });
        `,
      },
    ]);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.line).toBe(4);
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
