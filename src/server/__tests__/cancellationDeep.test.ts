import { describe, it, expect, afterAll, vi } from "vitest";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Round-9 #2 + #3 — cancellation must stop work INSIDE an active stage:
 *  #2 a cancel mid `writeBuild` loop stops the remaining file writes;
 *  #3 a cancel that arrives while the final reviewer is in flight ends the run
 *     cancelled, not completed.
 *
 * We drive a real stub run and trip the cancel from inside the mocked seam at
 * the exact moment under test (first file write / the final-review call).
 */

const hooks = vi.hoisted(() => ({
  writeCalls: 0,
  onFirstWrite: undefined as (() => void) | undefined,
  finalReviewCalled: false,
  onFinalReview: undefined as (() => void) | undefined,
}));

vi.mock("../workspace/fileWriter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workspace/fileWriter.js")>();
  return {
    ...actual,
    writeWorkspaceFile: async (root: string, path: string, contents: string) => {
      hooks.writeCalls += 1;
      if (hooks.writeCalls === 1) hooks.onFirstWrite?.();
      return actual.writeWorkspaceFile(root, path, contents);
    },
  };
});

vi.mock("../agents/finalReviewerAgent.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../agents/finalReviewerAgent.js")>();
  return {
    ...actual,
    finalReviewerAgent: async (
      ...args: Parameters<typeof actual.finalReviewerAgent>
    ) => {
      hooks.finalReviewCalled = true;
      hooks.onFinalReview?.();
      return actual.finalReviewerAgent(...args);
    },
  };
});

import { startRun } from "../orchestrator/runFactory.js";
import { requestCancel, clearCancel } from "../orchestrator/cancellation.js";
import { loadConfig, loadSecrets } from "../config.js";

const tmpRoot = resolve(process.cwd(), ".test-workspaces-cancel-deep");

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

function demoConfig() {
  return { ...loadConfig({}), workspaceRoot: tmpRoot, allowUntrustedScripts: false };
}

describe("Round-9 #2 cancel mid writeBuild stops remaining writes", () => {
  it("writes only the first file, then cancels", async () => {
    hooks.writeCalls = 0;
    hooks.onFinalReview = undefined;
    const run = startRun({
      idea: "Build a chore tracker",
      options: { demo: true },
      config: demoConfig(),
      secrets: loadSecrets({}),
    });
    // Trip the cancel from inside the first writeWorkspaceFile call.
    hooks.onFirstWrite = () => requestCancel(run.id);

    await vi.waitFor(
      () => expect(["completed", "failed", "cancelled"]).toContain(run.status),
      { timeout: 10_000 },
    );

    expect(run.status).toBe("cancelled");
    // The builder emits several files; only the first is attempted before the
    // per-file cancel check stops the loop.
    expect(hooks.writeCalls).toBe(1);
    clearCancel(run.id);
  });
});

describe("Round-9 #3 cancel during final review ends cancelled, not completed", () => {
  it("does not mark the run completed when cancel arrives in the final-review call", async () => {
    hooks.writeCalls = 0;
    hooks.onFirstWrite = undefined; // let the build complete this time
    hooks.finalReviewCalled = false;
    const run = startRun({
      idea: "Build a chore tracker",
      options: { demo: true },
      config: demoConfig(),
      secrets: loadSecrets({}),
    });
    hooks.onFinalReview = () => requestCancel(run.id);

    await vi.waitFor(
      () => expect(["completed", "failed", "cancelled"]).toContain(run.status),
      { timeout: 10_000 },
    );

    expect(hooks.finalReviewCalled).toBe(true);
    expect(run.status).toBe("cancelled");
    // The terminal mutation was skipped by the post-await cancel check.
    expect(run.finalReport).toBeNull();
    clearCancel(run.id);
  });
});
