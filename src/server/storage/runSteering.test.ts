import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { freshStages, type RunRecord } from "../../shared/schemas.js";
import {
  deleteRun,
  getRunForExecution,
  saveRun,
  submitRunSteering,
} from "./runsStore.js";

const created: string[] = [];

function queuedRun(): RunRecord {
  const id = randomUUID();
  created.push(id);
  return {
    id,
    idea: "Improve this program",
    status: "queued",
    resumable: false,
    demo: true,
    routingMode: "auto",
    codeProvider: "mock",
    reviewProvider: "mock",
    currentStage: null,
    stages: freshStages(),
    logs: [],
    files: [],
    repairLoops: 0,
    providerUsage: {
      free: { calls: 0 },
      anthropic: { calls: 0 },
      openai: { calls: 0 },
      stub: { calls: 0 },
      mock: { calls: 0 },
      totalCalls: 0,
    },
    finalReport: null,
    errorLedger: [],
    appName: null,
    workspacePath: null,
    destination: null,
    error: null,
    steering: [],
    acceptingSteering: true,
    attribution: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((id) => deleteRun(id)));
});

describe("submitRunSteering", () => {
  it("durably queues guidance on an active run", async () => {
    const run = queuedRun();
    await saveRun(run);

    const receipt = await submitRunSteering(
      run.id,
      "Keep the existing API stable.",
    );
    expect(receipt.ok).toBe(true);
    const stored = await getRunForExecution(run.id);
    expect(stored?.steering).toMatchObject([
      { instruction: "Keep the existing API stable.", status: "pending" },
    ]);
  });

  it("refuses guidance after the last model checkpoint", async () => {
    const run = queuedRun();
    run.acceptingSteering = false;
    await saveRun(run);

    const receipt = await submitRunSteering(run.id, "Change the release now.");
    expect(receipt).toMatchObject({ ok: false });
  });
});
