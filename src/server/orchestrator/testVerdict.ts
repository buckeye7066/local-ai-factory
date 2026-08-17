/**
 * testVerdict.ts — a RED test signal is sticky.
 *
 * A run can execute several test commands. The old accumulator was:
 *
 *     if (res.exitCode !== 0 || testExit === null) testExit = res.exitCode;
 *
 * using `testExit === null` to mean "no result recorded yet". But a test suite
 * KILLED by the 45-minute timeout also closes with `exitCode: null` (SIGKILL,
 * still `executed: true`). So a timed-out suite set `testExit = null`, and the
 * very next passing test command matched `testExit === null` and overwrote it
 * with 0 — laundering a killed suite into testStatus "passing".
 *
 * The fix separates "have we recorded anything yet" from the exit value: a
 * clean 0 may never replace a result that was already observed.
 */

export interface TestVerdictState {
  /** Exit code that currently stands as the run's test outcome. */
  testExit: number | null;
  /** True once ANY test command has reported a result. */
  anyTestRecorded: boolean;
}

/** The empty state at the start of a verification pass. */
export function freshTestVerdict(): TestVerdictState {
  return { testExit: null, anyTestRecorded: false };
}

/**
 * Fold one executed test command's exit code into the running verdict.
 *
 * - The first result always lands (including a `null` from a killed suite).
 * - A non-zero or `null` result always overwrites — the most recent real
 *   failure is the one worth reporting.
 * - A clean `0` NEVER overwrites an already-recorded result, so a failed or
 *   killed suite cannot be laundered green by a later passing command.
 */
export function foldTestExit(
  state: TestVerdictState,
  exitCode: number | null,
): TestVerdictState {
  const cleanPass = exitCode === 0;
  if (!state.anyTestRecorded || !cleanPass) {
    return { testExit: exitCode, anyTestRecorded: true };
  }
  return { testExit: state.testExit, anyTestRecorded: true };
}

/**
 * The run's stamped test verdict. "passing" requires a test command to have
 * actually executed AND exited 0 — nothing else may claim it.
 */
export function testStatusFor(
  testsExecuted: boolean,
  testExit: number | null,
): "passing" | "failing" | "unknown" {
  if (!testsExecuted) return "unknown";
  return testExit === 0 ? "passing" : "failing";
}

/**
 * RELEVANCE: "passing" must mean THIS RUN's tests passed (2026-08-16, live
 * GrantFlow slice 5590b773). The run wrote src/lib/storage.test.ts and
 * src/App.test.tsx, `npm test` executed the repository's PRE-EXISTING suite
 * (a login/database backend), exited 0 — and the report stamped
 * "Tests passing" beside a caveat saying the output belonged to a different
 * project. An exit code knows nothing about WHICH tests ran; the executed
 * output does: every JS test runner prints the test file paths it executed.
 *
 * Matching uses the normalized generated relative path. Basename-only matching
 * can be fooled by a pre-existing test with the same name elsewhere in a monorepo.
 * Conservative on purpose:
 *  - the run wrote NO change-specific tests → green degrades to "unknown";
 *  - ANY written test is absent from output → green degrades to "unknown";
 *  - ALL written tests appear               → "passing" may stand;
 *  - "failing"/"unknown" are NEVER upgraded by this check.
 */
const TEST_FILE_RE =
  /(\.(test|spec)\.[cm]?[jt]sx?$)|(^|[\\/])__tests__[\\/]|(^|[\\/])test_[^\\/]+\.py$|_test\.py$/i;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function outputMentionsRelativePath(output: string, path: string): boolean {
  const normalizedOutput = output
    .replace(/\\/g, "/")
    .replace(/(^|[\s"\'(])\.\//gm, "$1");
  const relativePath = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!relativePath) return false;
  const token = new RegExp(
    `(?:^|[\\s"\'(])${escapeRegex(relativePath)}(?=$|[\\s"\'():,])`,
    "m",
  );
  return token.test(normalizedOutput);
}
export function writtenTestFiles(writtenFiles: string[]): string[] {
  return writtenFiles.filter((p) => TEST_FILE_RE.test(p));
}

export interface RelevantTestVerdict {
  status: "passing" | "failing" | "unknown";
  /** Written-by-this-run test files the executed output never mentioned. */
  uncoveredTestFiles: string[];
  /** True when a green exit was degraded because none of them ran. */
  degraded: boolean;
}

export function relevantTestStatus(
  testsExecuted: boolean,
  testExit: number | null,
  writtenFiles: string[],
  executedOutput: string,
): RelevantTestVerdict {
  const base = testStatusFor(testsExecuted, testExit);
  const ownTests = writtenTestFiles(writtenFiles);
  if (!ownTests.length) {
    return {
      status: base === "passing" ? "unknown" : base,
      uncoveredTestFiles: [],
      degraded: base === "passing",
    };
  }
  const covered = ownTests.filter((path) =>
    outputMentionsRelativePath(executedOutput, path),
  );
  const uncovered = ownTests.filter((p) => !covered.includes(p));
  if (base !== "passing") {
    return { status: base, uncoveredTestFiles: uncovered, degraded: false };
  }
  if (uncovered.length > 0) {
    return { status: "unknown", uncoveredTestFiles: uncovered, degraded: true };
  }
  return { status: "passing", uncoveredTestFiles: [], degraded: false };
}
