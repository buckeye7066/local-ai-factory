import { describe, it, expect } from "vitest";
import { runRepairLoop } from "../orchestrator/repairLoop.js";
import type { QaReport } from "../../shared/schemas.js";

const failing: QaReport = {
  summary: "still broken",
  passed: false,
  issues: [
    { severity: "high", title: "x", detail: "", file: null, repairInstruction: "" },
  ],
};
const passing: QaReport = { summary: "ok", passed: true, issues: [] };

describe("bounded repair loop", () => {
  it("stops immediately when QA already passes", async () => {
    let repairs = 0;
    const res = await runRepairLoop({
      maxLoops: 3,
      initialQa: passing,
      repair: async () => void repairs++,
      reverify: async () => passing,
    });
    expect(res.loops).toBe(0);
    expect(repairs).toBe(0);
    expect(res.finalQa.passed).toBe(true);
  });

  it("stops as soon as a repair makes QA pass", async () => {
    let calls = 0;
    const res = await runRepairLoop({
      maxLoops: 3,
      initialQa: failing,
      repair: async () => void calls++,
      reverify: async () => passing, // fixed after first repair
    });
    expect(res.loops).toBe(1);
    expect(calls).toBe(1);
    expect(res.finalQa.passed).toBe(true);
  });

  it("refreshes executable evidence before QA after every repair", async () => {
    const order: string[] = [];
    let reviews = 0;
    const res = await runRepairLoop({
      maxLoops: 2,
      initialQa: failing,
      repair: async () => void order.push("repair"),
      verify: async () => void order.push("verify"),
      reverify: async () => {
        order.push("qa");
        reviews += 1;
        return reviews === 2 ? passing : failing;
      },
    });

    expect(res.loops).toBe(2);
    expect(order).toEqual(["repair", "verify", "qa", "repair", "verify", "qa"]);
    expect(res.finalQa.passed).toBe(true);
  });

  it("stops before another paid repair when fresh evidence becomes non-repairable", async () => {
    let calls = 0;
    let evidenceOnly = false;
    const res = await runRepairLoop({
      maxLoops: 3,
      initialQa: failing,
      shouldStop: () => evidenceOnly,
      repair: async () => void calls++,
      verify: async () => {
        evidenceOnly = true;
      },
      reverify: async () => failing,
    });

    expect(res.loops).toBe(1);
    expect(calls).toBe(1);
    expect(res.finalQa.passed).toBe(false);
    expect(res.stoppedEarly).toBe(true);
  });

  it("NEVER exceeds maxLoops even if QA keeps failing", async () => {
    let calls = 0;
    const res = await runRepairLoop({
      maxLoops: 3,
      initialQa: failing,
      repair: async () => void calls++,
      reverify: async () => failing, // never fixed
    });
    expect(res.loops).toBe(3);
    expect(calls).toBe(3);
    expect(res.finalQa.passed).toBe(false);
  });
});
