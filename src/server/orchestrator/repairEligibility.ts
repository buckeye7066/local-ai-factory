import type { QaReport } from "../../shared/schemas.js";

const SYNTHETIC_MISSING_EVIDENCE_TITLE = "Required verification did not execute:";

export type IncompleteVerificationGap = {
  command: string;
  reason: string;
};

export type IncompleteRepairDecision = {
  qa: Pick<QaReport, "passed" | "issues">;
  testExit: number | null;
  incompleteVerification: readonly IncompleteVerificationGap[];
};

/**
 * Only deterministic host/config limitations are evidence-only. Every unknown
 * gap remains repairable by default so candidate defects (portability,
 * manifests, runners, acceptance, or verification-tree mutations) keep their
 * bounded repair slots.
 */
export function isExternalEvidenceOnlyGap(gap: IncompleteVerificationGap): boolean {
  return [
    /compatibility is applicable but lacks executed evidence\.?$/i,
    /this host cannot supply .+ evidence/i,
    /script execution is disabled \(ALLOW_UNTRUSTED_SCRIPTS=0\)/i,
    /not found on a trusted PATH outside the workspace/i,
    /integrated verification sandbox is supported only on Linux/i,
    /Docker was not found on a trusted PATH/i,
    /verification sandbox configuration is invalid/i,
  ].some((pattern) => pattern.test(`${gap.command}: ${gap.reason}`));
}

/**
 * Missing external execution evidence alone cannot be repaired by editing
 * candidate files.
 *
 * A failed executable test, a repairable verification gap, or a separate
 * high/critical QA defect is different: the bounded repair loop must fix the
 * files and re-run verification.
 */
export function shouldSkipRepairForIncompleteVerification(
  decision: IncompleteRepairDecision,
): boolean {
  if (decision.incompleteVerification.length === 0 || decision.qa.passed) {
    return false;
  }
  if (!decision.incompleteVerification.every(isExternalEvidenceOnlyGap)) return false;
  if (decision.testExit !== null && decision.testExit !== 0) return false;

  const actionableQaDefect = decision.qa.issues.some(
    (issue) =>
      (issue.severity === "critical" || issue.severity === "high") &&
      !issue.title.startsWith(SYNTHETIC_MISSING_EVIDENCE_TITLE),
  );
  return !actionableQaDefect;
}
