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
