import type { QaReport } from "../../shared/schemas.js";

const SYNTHETIC_MISSING_EVIDENCE_TITLE = "Required verification did not execute:";

export type IncompleteRepairDecision = {
  qa: Pick<QaReport, "passed" | "issues">;
  testExit: number | null;
  incompleteVerification: number;
};

/**
 * Missing execution evidence alone cannot be repaired by editing files.
 *
 * A failed executable test or a separate high/critical QA defect is different:
 * the incomplete coverage is then a consequence of a real repairable failure.
 * The bounded repair loop must fix the files and re-run verification instead of
 * treating that consequence as a reason to skip repair entirely.
 */
export function shouldSkipRepairForIncompleteVerification(
  decision: IncompleteRepairDecision,
): boolean {
  if (decision.incompleteVerification <= 0 || decision.qa.passed) return false;
  if (decision.testExit !== null && decision.testExit !== 0) return false;

  const actionableQaDefect = decision.qa.issues.some(
    (issue) =>
      (issue.severity === "critical" || issue.severity === "high") &&
      !issue.title.startsWith(SYNTHETIC_MISSING_EVIDENCE_TITLE),
  );
  return !actionableQaDefect;
}
