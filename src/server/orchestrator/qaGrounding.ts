import type { QaReport } from "../../shared/schemas.js";

/**
 * qaGrounding.ts — executed evidence is the QA verdict authority.
 *
 * The QA critic is an LLM. Two shipped runs proved it fabricates in BOTH
 * directions: run c72fdb26 reported passing tests that never executed, and
 * runs 700222c1 / dac77d5c reported concrete blockers (parse errors with line
 * numbers, loose-equality violations) that do not exist in the delivered
 * tree. The critic is useful as a DIAGNOSTICIAN — summarizing why a command
 * failed, proposing repairs — but it must never be the AUTHORITY on whether
 * the build passes.
 *
 * The rule, mirroring the owner's global honesty contract:
 *   - When verification commands EXECUTED, `passed` is exactly "every
 *     executed command exited 0". The model cannot flip an executed green to
 *     red or an executed red to green.
 *   - Every FAILING command contributes a synthetic critical issue carrying
 *     its real output tail, prepended ahead of model-authored issues, so the
 *     repair agent chases the actual error before any model speculation.
 *   - When NOTHING executed, the model verdict stands but is labeled
 *     "[unverified]" so no downstream surface can present it as test
 *     evidence.
 */

export interface ExecutedCommandResult {
  command: string;
  exitCode: number | null;
  /** Only test-command output may establish that a generated test executed. */
  isTest?: boolean;
  /** Exact engine-selected generated test, when this was a direct runner command. */
  directTestPath?: string;
  /** True only for a browser-runner invocation. */
  isBrowser?: boolean;
  /** OS that actually executed this command; durable across checkpoint resume. */
  hostPlatform?: NodeJS.Platform;
  /** Targets proven by this successful command/output at the runner boundary. */
  verifiedTargets?: Array<"windows" | "webkit" | "macos" | "ios" | "android">;
  runner?: "vitest" | "jest" | "playwright" | "pytest";
  /** True only when the runner produced parseable, non-skipped passing evidence. */
  directEvidenceValid?: boolean;
  passedCount?: number;
  skippedCount?: number;
  /** Exact titles reported passed by the structured direct runner. */
  passedTestNames?: string[];
  /** Bounded tail of the command's stdout+stderr (evidence, not the model's memory of it). */
  outputTail: string;
}

export interface VerificationEvidence {
  /** Commands that actually ran (skipped/blocked commands are not evidence). */
  executed: ExecutedCommandResult[];
  /** Required commands that were blocked, unavailable, or could not execute. */
  incomplete?: Array<{ command: string; reason: string }>;
  /** Exact checked bytes for every path eligible for delivery. */
  fileDigests?: Record<string, string>;
  /** Runner-report roots first created by verification, never pre-existing product files. */
  platformRuntimeOutputRoots?: string[];
  /** Report parents allowed to produce only new, unsealed runner outputs on other hosts. */
  platformRuntimeReportParents?: string[];
  /** Complete candidate manifest sealed before cross-runner artifact transfer. */
  platformArtifactSnapshot?: Record<string, string>;
}

/** Cap the per-command evidence carried inside a QA issue. Errors print last. */
const ISSUE_TAIL_CHARS = 6000;

export function groundQaReport(qa: QaReport, evidence: VerificationEvidence): QaReport {
  const executed = evidence.executed;
  const incomplete = evidence.incomplete ?? [];
  if (!executed.length && !incomplete.length) {
    return {
      ...qa,
      summary: `[unverified — no commands executed; model judgment only] ${qa.summary}`,
    };
  }

  const failures = executed.filter((r) => r.exitCode !== 0);
  // Command failures and missing required commands are authoritative, but
  // green commands only prove what they exercised. They must never erase a
  // code/acceptance blocker found by the critic.
  const groundedPassed = failures.length === 0 && incomplete.length === 0 && qa.passed;

  const syntheticIssues = [
    ...failures.map((f) => ({
      severity: "critical" as const,
      title: `Executed command failed: ${f.command} (exit ${f.exitCode ?? "null"})`,
      detail: f.outputTail.slice(-ISSUE_TAIL_CHARS),
      file: null,
      repairInstruction:
        "Make this command exit 0. The output above is the authoritative error " +
        "evidence — repair exactly what it reports and do not invent other errors.",
    })),
    ...incomplete.map((item) => ({
      severity: "critical" as const,
      title: `Required verification did not execute: ${item.command}`,
      detail: item.reason,
      file: null,
      repairInstruction:
        "Restore the declared local verification tool or harness and execute this required check.",
    })),
  ];

  const commandFailureOverrodePass =
    qa.passed && (failures.length > 0 || incomplete.length > 0);
  const prefix =
    `[grounded: ${executed.length} command(s) executed, ${failures.length} failed, ${incomplete.length} incomplete` +
    (commandFailureOverrodePass
      ? "; passing model verdict overridden by missing/failing evidence"
      : "") +
    `] `;

  return {
    summary: prefix + qa.summary,
    passed: groundedPassed,
    issues: [...syntheticIssues, ...qa.issues],
  };
}
