import type { FinalReport } from "../../shared/schemas.js";
import type { VerificationEvidence } from "./qaGrounding.js";

/**
 * reportGrounding.ts — the FINAL REPORT's prose must not outrun the evidence.
 *
 * The structural fields of a FinalReport (testStatus, repairLoops,
 * workspacePath, providerUsage) were already stamped by the orchestrator and
 * are trustworthy. Its PROSE was not: `summary`, `whatWasBuilt` and `caveats`
 * come from a model that was handed only the spec and the QA report, never the
 * executed evidence. So a run could stamp `testStatus: "failing"` and, two
 * fields away, tell the owner "the app is complete and all tests pass".
 *
 * This applies the same rule the QA verdict already follows (see
 * qaGrounding.ts): executed commands are the authority, and the report is
 * corrected to match them deterministically — not by asking the model nicely.
 */

/** Cap the evidence tail quoted into a caveat. */
const CAVEAT_TAIL_CHARS = 400;

/** Phrases that assert unqualified success. Matched only to REMOVE a lie. */
const SUCCESS_CLAIM =
  /\b(all|every)\s+(the\s+)?(unit\s+|integration\s+)?tests?\s+(are\s+|now\s+)?(pass|passes|passed|passing|green|succeed|succeeded)\b|\btests?\s+(all\s+)?(pass|passing|green)\b|\bfully\s+(tested|working|complete)\b|\bproduction[- ]ready\b/gi;

export interface GroundReportInput {
  report: FinalReport;
  evidence: VerificationEvidence;
  /** The orchestrator's stamped, authoritative verdict. */
  testStatus: FinalReport["testStatus"];
  /** Paths that genuinely reached disk this run. */
  writtenFiles: string[];
  /** Files a guard refused to write, with reasons. */
  refusals?: Array<{ path: string; reason: string }>;
  /** Test files WRITTEN BY THIS RUN that the executed output never mentioned
   *  (see relevantTestStatus). Named here so the gap can never be silent. */
  uncoveredTestFiles?: string[];
  /** Rendered error-ledger lines (errorLedger.ts) — the report's "Errors" section. */
  errors?: string[];
}

/**
 * Force the report's prose to agree with what actually executed.
 *
 * - `testStatus` other than "passing" ⇒ a caveat naming the real outcome, and
 *   any unqualified "all tests pass" style claim in the prose is defanged.
 * - Every failing command contributes a caveat carrying its real exit code.
 * - A run that wrote NOTHING says so, however confident the model sounds.
 * - Refused writes are surfaced as caveats rather than silently dropped.
 */
export function groundFinalReport(input: GroundReportInput): FinalReport {
  const { report, evidence, testStatus, writtenFiles } = input;
  const refusals = input.refusals ?? [];
  const executed = evidence.executed;
  const failures = executed.filter((r) => r.exitCode !== 0);

  const caveats: string[] = [];

  if (testStatus === "passing") {
    // Nothing to correct — the prose and the evidence agree.
  } else if (testStatus === "failing") {
    caveats.push(
      `TESTS DID NOT PASS. The orchestrator recorded testStatus="failing" from ` +
        `executed commands. This build is NOT verified working.`,
    );
  } else {
    caveats.push(
      `TESTS NEVER EXECUTED (testStatus="unknown"). Nothing here is evidence ` +
        `that the code runs — no test command was executed in the workspace.`,
    );
  }

  for (const f of failures) {
    caveats.push(
      `Executed command FAILED: ${f.command} (exit ${f.exitCode ?? "null — killed, e.g. by timeout"}). ` +
        `Output tail: ${f.outputTail.trim().slice(-CAVEAT_TAIL_CHARS)}`,
    );
  }

  if (!executed.length) {
    caveats.push(
      "No verification commands executed at all, so every claim below rests on " +
        "model judgment rather than observed behaviour.",
    );
  }

  if (!writtenFiles.length) {
    caveats.push(
      "NO FILES REACHED DISK in this run — the report describes intended work, " +
        "not delivered work.",
    );
  }

  for (const r of refusals) {
    caveats.push(`Generated file REFUSED (not written): ${r.path} — ${r.reason}`);
  }

  const uncovered = input.uncoveredTestFiles ?? [];
  if (uncovered.length) {
    caveats.push(
      `THIS RUN'S OWN TESTS DID NOT RUN: the executed test output never ` +
        `mentioned ${uncovered.join(", ")}. Whatever suite did run, it is not ` +
        `evidence for the files this run wrote.`,
    );
  }

  // Defang unqualified success claims when the evidence does not support them.
  // The model's wording is preserved but marked, so the owner sees both what
  // it said and that the run did not earn it.
  const needsDefang = testStatus !== "passing";
  const defang = (text: string): string =>
    needsDefang
      ? text.replace(SUCCESS_CLAIM, (m) => `${m} [UNSUPPORTED — testStatus=${testStatus}]`)
      : text;

  // "What was built" is a FACT the orchestrator holds, not a model opinion.
  // Live run 5590b773 rendered "Nothing recorded." while seven written files
  // were named elsewhere on the same card — the reviewer simply returned an
  // empty list and nothing corrected it. When the model records nothing but
  // files demonstrably reached disk, the mechanical file list IS the answer.
  const modelBuilt = (report.whatWasBuilt ?? []).map(defang);
  const whatWasBuilt =
    modelBuilt.length || !writtenFiles.length
      ? modelBuilt
      : writtenFiles.map((p) => `${p} (from the run's write log)`);

  return {
    ...report,
    summary: defang(report.summary),
    whatWasBuilt,
    // Grounded caveats come FIRST so they cannot be buried under model prose.
    caveats: [...caveats, ...(report.caveats ?? []).map(defang)],
    // The "Errors" section is the ledger, verbatim — never model prose.
    errors: [...(input.errors ?? [])],
  };
}
