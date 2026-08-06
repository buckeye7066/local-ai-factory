import { describe, it, expect, afterAll, vi } from "vitest";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Round-9 #7 — a failed run's `run.error` is persisted and returned by
 * /api/runs/:runId. A provider/library error can carry a secret-shaped value;
 * it must be redacted before it is stored/served. We force a failure whose
 * message embeds a secret and assert the persisted error is redacted.
 */

const SECRET = "sk-ant-DEADBEEFdeadbeef0123456789";

vi.mock("../agents/productSpecAgent.js", () => ({
  productSpecAgent: async () => {
    throw new Error(`provider failed: OPENAI_API_KEY=${SECRET} (400 bad request)`);
  },
}));

import { startRun } from "../orchestrator/runFactory.js";
import { loadConfig, loadSecrets } from "../config.js";

const tmpRoot = resolve(process.cwd(), ".test-workspaces-errredact");

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("Round-9 #7 run.error is redacted before persistence/serving", () => {
  it("masks a secret-shaped token in the failed run's error", async () => {
    const config = { ...loadConfig({}), workspaceRoot: tmpRoot, dryRunCommands: true };
    const run = startRun({
      idea: "Build a chore tracker",
      options: { demo: true },
      config,
      secrets: loadSecrets({}),
    });

    await vi.waitFor(
      () => expect(["completed", "failed", "cancelled"]).toContain(run.status),
      { timeout: 10_000 },
    );

    expect(run.status).toBe("failed");
    expect(run.error).toBeTruthy();
    // The raw secret must NOT be present…
    expect(run.error!).not.toContain(SECRET);
    // …and a redaction placeholder must be.
    expect(run.error!).toMatch(/\[REDACTED/);
  });
});
