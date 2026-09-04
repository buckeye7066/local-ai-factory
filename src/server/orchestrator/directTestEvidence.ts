import {
  MAX_TEST_NAME_CHARS,
  MAX_TEST_PLAN_COVERAGE_ENTRIES,
} from "../../shared/schemas.js";

export type DirectTestRunner = "vitest" | "jest" | "playwright" | "pytest";

export interface DirectTestEvidence {
  valid: boolean;
  passedCount: number;
  skippedCount: number;
  passedTestNames: string[];
  reason?: string;
}

export const MAX_PERSISTED_PASSED_TEST_NAMES = MAX_TEST_PLAN_COVERAGE_ENTRIES;
export const MAX_PERSISTED_TEST_NAME_CHARS = MAX_TEST_NAME_CHARS;

export function boundPassedTestNames(names: Iterable<string>): string[] {
  const bounded: string[] = [];
  const seen = new Set<string>();
  for (const rawName of names) {
    const name = rawName.trim();
    // Never truncate evidence: a long reporter title could otherwise become
    // indistinguishable from a different mapped title with the same prefix.
    if (!name || name.length > MAX_PERSISTED_TEST_NAME_CHARS || seen.has(name)) {
      continue;
    }
    seen.add(name);
    bounded.push(name);
    if (bounded.length === MAX_PERSISTED_PASSED_TEST_NAMES) break;
  }
  return bounded;
}

class PassedTestNameCollector {
  private readonly required: Set<string>;
  private readonly matched: string[] = [];
  private readonly matchedSet = new Set<string>();
  private readonly samples: string[] = [];
  private readonly sampleSet = new Set<string>();
  hasReportedName = false;

  constructor(requiredTestNames: Iterable<string>) {
    this.required = new Set(boundPassedTestNames(requiredTestNames));
  }

  add(rawName: string): void {
    const name = rawName.trim();
    if (!name) return;
    this.hasReportedName = true;
    // Required acceptance titles are retained even when they appear after
    // hundreds of thousands of unrelated parameterized reporter entries.
    if (this.required.has(name) && !this.matchedSet.has(name)) {
      this.matchedSet.add(name);
      this.matched.push(name);
    }
    if (
      name.length <= MAX_PERSISTED_TEST_NAME_CHARS &&
      this.samples.length < MAX_PERSISTED_PASSED_TEST_NAMES &&
      !this.sampleSet.has(name)
    ) {
      this.sampleSet.add(name);
      this.samples.push(name);
    }
  }

  persistedNames(): string[] {
    return boundPassedTestNames([...this.matched, ...this.samples]);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function numberField(value: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const found = value[key];
    if (typeof found === "number" && Number.isFinite(found)) return found;
  }
  return 0;
}

function parseJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first < 0 || last <= first) return null;
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      return null;
    }
  }
}

function jsonFrom(stdout: string, stderr: string): unknown | null {
  return parseJson(stdout) ?? parseJson(stderr) ?? parseJson(`${stdout}\n${stderr}`);
}

function finish(
  passedCount: number,
  skippedCount: number,
  names: PassedTestNameCollector,
  parseReason?: string,
): DirectTestEvidence {
  const passedTestNames = names.persistedNames();
  if (parseReason) {
    return {
      valid: false,
      passedCount,
      skippedCount,
      passedTestNames,
      reason: parseReason,
    };
  }
  if (passedCount < 1) {
    return {
      valid: false,
      passedCount,
      skippedCount,
      passedTestNames,
      reason: "runner reported zero passed tests",
    };
  }
  if (skippedCount > 0) {
    return {
      valid: false,
      passedCount,
      skippedCount,
      passedTestNames,
      reason: `runner reported ${skippedCount} skipped/pending test(s)`,
    };
  }
  if (!names.hasReportedName) {
    return {
      valid: false,
      passedCount,
      skippedCount,
      passedTestNames,
      reason: "runner did not identify any passed test names",
    };
  }
  return { valid: true, passedCount, skippedCount, passedTestNames };
}

function parseJestLike(
  root: Record<string, unknown>,
  requiredTestNames: Iterable<string>,
): DirectTestEvidence {
  const passedCount = numberField(root, "numPassedTests", "numPassedTestSuites");
  const skippedCount =
    numberField(root, "numPendingTests") + numberField(root, "numTodoTests");
  const names = new PassedTestNameCollector(requiredTestNames);

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const object = asRecord(value);
    if (!object) return;
    const status = typeof object.status === "string" ? object.status.toLowerCase() : "";
    if (status === "passed" || status === "pass") {
      for (const key of ["title", "fullName", "name"]) {
        const name = object[key];
        if (typeof name === "string") names.add(name);
      }
    }
    for (const child of Object.values(object)) visit(child);
  };
  visit(root);
  return finish(passedCount, skippedCount, names);
}

function parsePlaywright(
  root: Record<string, unknown>,
  requiredTestNames: Iterable<string>,
): DirectTestEvidence {
  let passedCount = 0;
  let skippedCount = 0;
  const names = new PassedTestNameCollector(requiredTestNames);

  const visitSuite = (value: unknown): void => {
    const suite = asRecord(value);
    if (!suite) return;
    const specs = Array.isArray(suite.specs) ? suite.specs : [];
    for (const rawSpec of specs) {
      const spec = asRecord(rawSpec);
      if (!spec) continue;
      const title = typeof spec.title === "string" ? spec.title.trim() : "";
      const tests = Array.isArray(spec.tests) ? spec.tests : [];
      let specPassed = false;
      for (const rawTest of tests) {
        const test = asRecord(rawTest);
        if (!test) continue;
        const results = Array.isArray(test.results) ? test.results : [];
        if (!results.length) {
          const expected =
            typeof test.expectedStatus === "string"
              ? test.expectedStatus.toLowerCase()
              : "";
          if (expected === "skipped") skippedCount += 1;
        }
        for (const rawResult of results) {
          const result = asRecord(rawResult);
          const status =
            typeof result?.status === "string" ? result.status.toLowerCase() : "";
          if (status === "passed") {
            passedCount += 1;
            specPassed = true;
          } else if (status === "skipped") {
            skippedCount += 1;
          }
        }
      }
      if (specPassed && title) names.add(title);
    }
    for (const child of Array.isArray(suite.suites) ? suite.suites : []) {
      visitSuite(child);
    }
  };

  for (const suite of Array.isArray(root.suites) ? root.suites : []) {
    visitSuite(suite);
  }
  return finish(passedCount, skippedCount, names);
}

function parsePytest(
  stdout: string,
  stderr: string,
  requiredTestNames: Iterable<string>,
): DirectTestEvidence {
  let passedCount = 0;
  let skippedCount = 0;
  const names = new PassedTestNameCollector(requiredTestNames);
  for (const line of `${stdout}\n${stderr}`.split(/\r?\n/)) {
    const match =
      /^\s*(?:[^\s:]+\/)*[^\s:]+\.py(?:::([^\s]+))?\s+(PASSED|SKIPPED|XFAIL|XPASS)\b/i.exec(
        line,
      );
    if (!match) continue;
    const status = match[2]!.toUpperCase();
    if (status === "PASSED") {
      passedCount += 1;
      const node = (match[1] ?? "").split("::").pop() ?? "";
      const name = node.replace(/\[.*\]$/, "");
      if (name) names.add(name);
    } else {
      skippedCount += 1;
    }
  }
  return finish(passedCount, skippedCount, names);
}

/**
 * Parse only engine-selected structured/verbose runner output. Arbitrary
 * filename text is never proof that a test ran.
 */
export function parseDirectTestEvidence(
  runner: DirectTestRunner,
  stdout: string,
  stderr: string,
  requiredTestNames: Iterable<string> = [],
): DirectTestEvidence {
  if (runner === "pytest") return parsePytest(stdout, stderr, requiredTestNames);
  const parsed = jsonFrom(stdout, stderr);
  const root = asRecord(parsed);
  if (!root) {
    return finish(
      0,
      0,
      new PassedTestNameCollector(requiredTestNames),
      `${runner} reporter output was not valid JSON`,
    );
  }
  return runner === "playwright"
    ? parsePlaywright(root, requiredTestNames)
    : parseJestLike(root, requiredTestNames);
}
