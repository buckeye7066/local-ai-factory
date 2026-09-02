import { describe, expect, it, vi } from "vitest";

const failure = vi.hoisted(() => ({
  message: "disk unavailable OPENAI_API_KEY=sk-test-startup-secret-0123456789",
}));

vi.mock("../storage/runsStore.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../storage/runsStore.js")>();
  return {
    ...actual,
    saveRun: vi.fn(async () => {
      throw new Error(failure.message);
    }),
  };
});

import { loadConfig, loadSecrets } from "../config.js";
import { startRun } from "../orchestrator/runFactory.js";

describe("Factory Deck background startup", () => {
  it("fails visibly instead of leaving a queued ghost when persistence rejects", async () => {
    const run = startRun({
      idea: "Build a task tracker",
      options: { demo: true },
      config: loadConfig({}),
      secrets: loadSecrets({}),
    });

    await vi.waitFor(() => expect(run.status).toBe("failed"));

    expect(run.resumable).toBe(false);
    expect(run.error).toContain("Run could not start or persist:");
    expect(run.error).not.toContain("sk-test-startup-secret-0123456789");
    expect(run.error).toContain("[REDACTED");
    expect(run.logs.at(-1)?.kind).toBe("error");
    expect(run.logs.at(-1)?.message).toBe(run.error);
    expect(run.errorLedger).toHaveLength(1);
    expect(run.errorLedger[0]?.message).toBe(run.error);
    expect(run.errorLedger[0]?.message).not.toContain(
      "sk-test-startup-secret-0123456789",
    );
  });
});
