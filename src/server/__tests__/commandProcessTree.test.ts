import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../workspace/commandRunner.js";

describe("POSIX command process-tree cleanup", () => {
  it.runIf(process.platform !== "win32")(
    "kills package-manager grandchildren on timeout",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "factory-process-tree-"));
      const workspace = join(root, "workspace");
      const trusted = join(root, "trusted");
      const sentinel = join(root, "grandchild-survived.txt");
      const previousPath = process.env.PATH;
      try {
        const { mkdirSync } = await import("node:fs");
        mkdirSync(workspace);
        mkdirSync(trusted);
        const grandchild =
          `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(
            sentinel,
          )}, "survived"), 800); setTimeout(() => {}, 5000);`;
        const shim = join(trusted, "pnpm");
        writeFileSync(
          shim,
          `#!/bin/sh\n${JSON.stringify(process.execPath)} -e ${JSON.stringify(
            grandchild,
          )} &\nsleep 5\n`,
        );
        chmodSync(shim, 0o755);
        process.env.PATH = [trusted, previousPath ?? ""].join(delimiter);

        const result = await runCommand(
          { bin: "pnpm", args: ["test"], cwd: workspace },
          {
            workspaceRoot: workspace,
            allowScriptExecution: true,
            timeoutMs: 100,
          },
        );

        expect(result.executed).toBe(false);
        expect(result.reason).toMatch(/timed out/i);
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        expect(existsSync(sentinel)).toBe(false);
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
