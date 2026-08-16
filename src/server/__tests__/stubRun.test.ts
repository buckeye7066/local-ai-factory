import { describe, it, expect, afterAll } from "vitest";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { runFactory } from "../orchestrator/runFactory.js";
import { loadConfig, loadSecrets } from "../config.js";

const tmpRoot = resolve(process.cwd(), ".test-workspaces");

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("stub demo run (end-to-end, offline)", () => {
  it("completes the full assembly line with one repair loop", async () => {
    const config = {
      ...loadConfig({}),
      workspaceRoot: tmpRoot,
      allowUntrustedScripts: false,
    };
    const run = await runFactory({
      idea: "Build a Bible reading habit tracker",
      options: { demo: true },
      config,
      secrets: loadSecrets({}),
    });

    expect(run.status).toBe("completed");
    expect(run.demo).toBe(true);
    expect(run.appName).toBe("VerseKeeper");
    // Every stage reached a terminal state (no stage left pending/active).
    expect(
      run.stages.every((s) => s.status !== "pending" && s.status !== "active"),
    ).toBe(true);
    // The stub injects exactly one QA failure → exactly one repair loop.
    expect(run.repairLoops).toBe(1);
    // Files were generated and a report produced.
    expect(run.files.length).toBeGreaterThan(3);
    expect(run.finalReport).not.toBeNull();
    // A hermetic stub run executes NO commands, so "passing" would be a
    // fabricated claim — testStatus is honestly "unknown" (qaGrounding.ts).
    expect(run.finalReport?.testStatus).toBe("unknown");
    // Demo run used only the stub — no real provider calls counted.
    expect(run.providerUsage.anthropic.calls).toBe(0);
    expect(run.providerUsage.openai.calls).toBe(0);
    // Demo now uses mock; stub remains for back-compat only.
    expect(run.providerUsage.mock.calls).toBeGreaterThan(0);
    expect(run.codeProvider).toBe("mock");
  });

  it("does not execute commands when script execution is disabled (hermetic)", async () => {
    const config = {
      ...loadConfig({}),
      workspaceRoot: tmpRoot,
      allowUntrustedScripts: false,
    };
    const run = await runFactory({
      idea: "Build a chore tracker",
      options: { demo: true },
      config,
      secrets: loadSecrets({}),
    });
    const commandLogs = run.logs.filter((l) => l.kind === "command_run");
    expect(commandLogs.length).toBeGreaterThan(0);
    expect(
      commandLogs.every((l) => /ALLOW_UNTRUSTED_SCRIPTS|Refused/i.test(l.message)),
    ).toBe(true);
  });
});
