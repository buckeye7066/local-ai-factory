import { describe, it, expect, afterAll, vi } from "vitest";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { startRun } from "../orchestrator/runFactory.js";
import {
  requestCancel,
  isCancelRequested,
  clearCancel,
  throwIfCancelled,
  RunCancelledError,
} from "../orchestrator/cancellation.js";
import { loadConfig, loadSecrets } from "../config.js";

const tmpRoot = resolve(process.cwd(), ".test-workspaces-cancel");

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("cancellation primitives", () => {
  it("tracks, checks, and clears cancel requests", () => {
    expect(isCancelRequested("x")).toBe(false);
    requestCancel("x");
    expect(isCancelRequested("x")).toBe(true);
    expect(() => throwIfCancelled("x")).toThrow(RunCancelledError);
    clearCancel("x");
    expect(isCancelRequested("x")).toBe(false);
    expect(() => throwIfCancelled("x")).not.toThrow();
  });
});

describe("cancelling a run", () => {
  it("stops a demo run cleanly with status 'cancelled'", async () => {
    const config = {
      ...loadConfig({}),
      workspaceRoot: tmpRoot,
      allowUntrustedScripts: false,
    };
    const run = startRun({
      idea: "Build a chore tracker",
      options: { demo: true },
      config,
      secrets: loadSecrets({}),
    });
    // Cancel before the first stage checkpoint fires.
    requestCancel(run.id);

    await vi.waitFor(
      () => {
        expect(["completed", "failed", "cancelled"]).toContain(run.status);
        // The flag is cleared in executeRun's `finally`, which runs just AFTER
        // the terminal status is set + flushed — so wait for the flag to clear
        // rather than sampling it in the same tick the status becomes terminal.
        expect(isCancelRequested(run.id)).toBe(false);
      },
      { timeout: 10_000 },
    );

    expect(run.status).toBe("cancelled");
    expect(run.error).toBeNull();
    // The cancel flag is cleared so the id could never block a future run.
    expect(isCancelRequested(run.id)).toBe(false);
    // No stage may be left dangling in "active".
    expect(run.stages.every((s) => s.status !== "active")).toBe(true);
  });
});
