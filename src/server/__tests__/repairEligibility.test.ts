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
        incompleteVerification: [
          {
            command: "acceptance coverage",
            reason: "the generated workflow was not observed",
          },
        ],
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
        incompleteVerification: [
          {
            command: "build",
            reason: "interactive UI changed but the host declares no build script",
          },
        ],
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
        incompleteVerification: [
          {
            command: "Windows workflow",
            reason: "This host cannot supply Windows evidence.",
          },
        ],
      }),
    ).toBe(true);
  });

  it.each([
    [
      "Windows portability defect",
      {
        command: "Windows process portability: src/cli.ts:9",
        reason: "shell-dependent child process invocation is not portable",
      },
    ],
    [
      "missing declared runner",
      {
        command: "tests/workflow.test.ts",
        reason: "no declared local Vitest/Jest/Pytest runner can execute this generated test directly",
      },
    ],
  ])("keeps repairing a %s", (_name, gap) => {
    expect(
      shouldSkipRepairForIncompleteVerification({
        qa: report([
          {
            severity: "critical",
            title: `Required verification did not execute: ${gap.command}`,
            detail: gap.reason,
            file: null,
            repairInstruction: "Repair the candidate and rerun verification.",
          },
        ]),
        testExit: 0,
        incompleteVerification: [gap],
      }),
    ).toBe(false);
  });

  it("does not apply the incomplete-evidence skip when verification is complete", () => {
    expect(
      shouldSkipRepairForIncompleteVerification({
        qa: report([]),
        testExit: 0,
        incompleteVerification: [],
      }),
    ).toBe(false);
  });
});
