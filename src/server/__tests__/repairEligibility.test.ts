import { describe, expect, it } from "vitest";
import type { QaReport } from "../../shared/schemas.js";
import { shouldSkipRepairForIncompleteVerification } from "../orchestrator/repairEligibility.js";

function report(issues: QaReport["issues"]): QaReport {
  return { summary: "grounded QA", passed: false, issues };
}

describe("repair eligibility with incomplete verification", () => {
  it("repairs a failed executable test even when its coverage becomes incomplete", () => {
    expect(
      shouldSkipRepairForIncompleteVerification({
        qa: report([]),
        testExit: 1,
        incompleteVerification: 30,
      }),
    ).toBe(false);
  });

  it("repairs an actionable QA defect before trying to complete evidence", () => {
    expect(
      shouldSkipRepairForIncompleteVerification({
        qa: report([
          {
            severity: "high",
            title: "Negative task numbers are routed as unknown commands",
            detail: "The executed workflow test failed.",
            file: "src/cli.ts",
            repairInstruction: "Validate the numeric argument before dispatch.",
          },
        ]),
        testExit: 0,
        incompleteVerification: 2,
      }),
    ).toBe(false);
  });

  it("skips file repair when missing execution evidence is the only blocker", () => {
    expect(
      shouldSkipRepairForIncompleteVerification({
        qa: report([
          {
            severity: "critical",
            title: "Required verification did not execute: Windows workflow",
            detail: "This host cannot supply Windows evidence.",
            file: null,
            repairInstruction: "Run the exact candidate on Windows.",
          },
        ]),
        testExit: null,
        incompleteVerification: 1,
      }),
    ).toBe(true);
  });

  it("does not apply the incomplete-evidence skip when verification is complete", () => {
    expect(
      shouldSkipRepairForIncompleteVerification({
        qa: report([]),
        testExit: 0,
        incompleteVerification: 0,
      }),
    ).toBe(false);
  });
});
