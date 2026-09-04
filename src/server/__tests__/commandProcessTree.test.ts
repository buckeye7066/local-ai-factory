import {
  chmodSync,
  existsSync,
  mkdirSync,
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
      const state = join(root, "sandbox-state");
      const sentinel = join(root, "grandchild-survived.txt");
      const previousPath = process.env.PATH;
      const previousImage = process.env.FACTORY_VERIFICATION_SANDBOX_IMAGE;
      const previousState = process.env.FACTORY_VERIFICATION_SANDBOX_STATE_ROOT;
      try {
        mkdirSync(workspace);
        mkdirSync(trusted);
        const grandchild = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(
          sentinel,
        )}, "survived"), 800); setTimeout(() => {}, 5000);`;
        const shim = join(trusted, "docker");
        writeFileSync(
          shim,
          `#!/bin/sh\nif [ "$1" = "run" ]; then\n  ${JSON.stringify(
            process.execPath,
          )} -e ${JSON.stringify(grandchild)} &\n  sleep 5\nfi\n`,
        );
        chmodSync(shim, 0o755);
        process.env.PATH = [trusted, previousPath ?? ""].join(delimiter);
        process.env.FACTORY_VERIFICATION_SANDBOX_IMAGE = "test-verifier:latest";
        process.env.FACTORY_VERIFICATION_SANDBOX_STATE_ROOT = state;

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
        if (previousImage === undefined) {
          delete process.env.FACTORY_VERIFICATION_SANDBOX_IMAGE;
        } else {
          process.env.FACTORY_VERIFICATION_SANDBOX_IMAGE = previousImage;
        }
        if (previousState === undefined) {
          delete process.env.FACTORY_VERIFICATION_SANDBOX_STATE_ROOT;
        } else {
          process.env.FACTORY_VERIFICATION_SANDBOX_STATE_ROOT = previousState;
        }
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "retains only bounded stdout and stderr tails",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "factory-output-tail-"));
      const workspace = join(root, "workspace");
      const trusted = join(root, "trusted");
      const state = join(root, "sandbox-state");
      const previousPath = process.env.PATH;
      const previousImage = process.env.FACTORY_VERIFICATION_SANDBOX_IMAGE;
      const previousState = process.env.FACTORY_VERIFICATION_SANDBOX_STATE_ROOT;
      try {
        mkdirSync(workspace);
        mkdirSync(trusted);
        const shim = join(trusted, "docker");
        const script =
          'process.stdout.write("x".repeat(20000)); ' +
          'process.stderr.write("y".repeat(20000));';
        writeFileSync(
          shim,
          `#!/bin/sh\nif [ "$1" = "run" ]; then\n  ${JSON.stringify(
            process.execPath,
          )} -e ${JSON.stringify(script)}\nfi\n`,
        );
        chmodSync(shim, 0o755);
        process.env.PATH = [trusted, previousPath ?? ""].join(delimiter);
        process.env.FACTORY_VERIFICATION_SANDBOX_IMAGE = "test-verifier:latest";
        process.env.FACTORY_VERIFICATION_SANDBOX_STATE_ROOT = state;

        const result = await runCommand(
          { bin: "pnpm", args: ["test"], cwd: workspace },
          {
            workspaceRoot: workspace,
            allowScriptExecution: true,
            timeoutMs: 5_000,
          },
        );

        expect(result.executed).toBe(true);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("x".repeat(8_000));
        expect(result.stderr).toBe("y".repeat(8_000));
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        if (previousImage === undefined) {
          delete process.env.FACTORY_VERIFICATION_SANDBOX_IMAGE;
        } else {
          process.env.FACTORY_VERIFICATION_SANDBOX_IMAGE = previousImage;
        }
        if (previousState === undefined) {
          delete process.env.FACTORY_VERIFICATION_SANDBOX_STATE_ROOT;
        } else {
          process.env.FACTORY_VERIFICATION_SANDBOX_STATE_ROOT = previousState;
        }
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
