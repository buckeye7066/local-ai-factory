import { describe, it, expect, afterAll, vi } from "vitest";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Round-10 #4 + #5 — the persisted + API-served copies of `run.idea` and
 * `run.finalReport` must be redacted, while the model still receives the RAW
 * idea. We capture the idea the (mocked) product-spec agent receives and inject
 * a secret-bearing final report to prove both.
 */

const IDEA_SECRET = "sk-ant-IDEAsecret0123456789abcdef";
const REPORT_SECRET = "sk-ant-REPORTsecret0123456789abcd";

const cap = vi.hoisted(() => ({ ideaSeenByModel: "" }));

vi.mock("../agents/productSpecAgent.js", () => ({
  productSpecAgent: async (_ctx: unknown, idea: string) => {
    cap.ideaSeenByModel = idea;
    return {
      appName: "T",
      tagline: "",
      targetUser: "u",
      coreFeatures: ["f"],
      dataModel: [],
      userFlows: [],
      acceptanceCriteria: ["a"],
    };
  },
}));

vi.mock("../agents/finalReviewerAgent.js", () => ({
  finalReviewerAgent: async () => ({
    appName: "T",
    summary: `built ok, token=${REPORT_SECRET}`,
    whatWasBuilt: [`used OPENAI_API_KEY=${REPORT_SECRET}`],
    howToRun: "run it",
    testStatus: "unknown",
    repairLoops: 0,
    caveats: [`note: ${REPORT_SECRET}`],
    nextImprovements: [],
    workspacePath: "(ws)",
    providerUsage: {
      anthropic: { calls: 0 },
      openai: { calls: 0 },
      stub: { calls: 0 },
      totalCalls: 0,
    },
  }),
}));

import { startRun } from "../orchestrator/runFactory.js";
import { loadConfig, loadSecrets } from "../config.js";

const tmpRoot = resolve(process.cwd(), ".test-workspaces-served");

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("Round-10 #4 + #5 served idea + finalReport are redacted; model gets raw idea", () => {
  it("redacts run.idea and every finalReport string, but passes the raw idea to the model", async () => {
    const config = { ...loadConfig({}), workspaceRoot: tmpRoot, dryRunCommands: true };
    const run = startRun({
      idea: `Build a tracker OPENAI_API_KEY=${IDEA_SECRET}`,
      options: { demo: true },
      config,
      secrets: loadSecrets({}),
    });

    await vi.waitFor(
      () => expect(["completed", "failed", "cancelled"]).toContain(run.status),
      { timeout: 10_000 },
    );
    expect(run.status).toBe("completed");

    // #4 — the model saw the RAW idea…
    expect(cap.ideaSeenByModel).toContain(IDEA_SECRET);
    // …but the persisted/served copy is redacted.
    expect(run.idea).not.toContain(IDEA_SECRET);
    expect(run.idea).toMatch(/\[REDACTED/);

    // #5 — every finalReport string field is redacted.
    const fr = run.finalReport!;
    expect(fr).not.toBeNull();
    expect(JSON.stringify(fr)).not.toContain(REPORT_SECRET);
    expect(fr.summary).toMatch(/\[REDACTED/);
    expect(fr.caveats.join(" ")).toMatch(/\[REDACTED/);
    expect(fr.whatWasBuilt.join(" ")).toMatch(/\[REDACTED/);
  });
});
