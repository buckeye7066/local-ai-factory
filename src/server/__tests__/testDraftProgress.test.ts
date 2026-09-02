import { describe, expect, it } from "vitest";
import { FactoryCheckpointSchema } from "../orchestrator/checkpoint.js";
import { nextTestDraftToGenerate } from "../orchestrator/testDraftProgress.js";

describe("test draft resume progress", () => {
  it("never replays a checkpointed corrective draft", () => {
    expect(nextTestDraftToGenerate(false, undefined)).toBe(1);
    expect(nextTestDraftToGenerate(true, undefined)).toBe(2);
    expect(nextTestDraftToGenerate(true, 2)).toBe(3);
    expect(nextTestDraftToGenerate(true, 3)).toBe(4);
  });

  it("persists the bounded draft number while keeping legacy v3 checkpoints valid", () => {
    const base = {
      schemaVersion: 3 as const,
      runId: "11111111-1111-4111-8111-111111111111",
      idea: "build a checklist",
      options: {},
      updatedAt: 1,
    };
    expect(FactoryCheckpointSchema.parse(base).testPlanDraft).toBeUndefined();
    expect(
      FactoryCheckpointSchema.parse({ ...base, testPlanDraft: 3 }).testPlanDraft,
    ).toBe(3);
    expect(() =>
      FactoryCheckpointSchema.parse({ ...base, testPlanDraft: 4 }),
    ).toThrow();
  });
});
