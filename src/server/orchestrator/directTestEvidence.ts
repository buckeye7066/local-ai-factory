export type DirectTestRunner = "vitest" | "jest" | "playwright" | "pytest";

export interface DirectTestEvidence {
  valid: boolean;
  passedCount: number;
  skippedCount: number;
  passedTestNames: string[];
  reason?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function numberField(
  value: Record<string, unknown>,
  ...keys: string[]
): number {
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
  return (
    parseJson(stdout) ??
    parseJson(stderr) ??
    parseJson(`${stdout}\n${stderr}`)
  );
}

function finish(
  passedCount: number,
  skippedCount: number,
  names: Iterable<string>,
  parseReason?: string,
): DirectTestEvidence {
  const passedTestNames = [...new Set([...names].filter(Boolean))];
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
  if (!passedTestNames.length) {
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

function parseJestLike(root: Record<string, unknown>): DirectTestEvidence {
  const passedCount = numberField(root, "numPassedTests", "numPassedTestSuites");
  const skippedCount =
    numberField(root, "numPendingTests") +
    numberField(root, "numTodoTests");
  const names = new Set<string>();

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const object = asRecord(value);
    if (!object) return;
    const status = typeof object.status === "string"
      ? object.status.toLowerCase()
      : "";
    if (status === "passed" || status === "pass") {
      for (const key of ["title", "fullName", "name"]) {
        const name = object[key];
        if (typeof name === "string" && name.trim()) names.add(name.trim());
      }
    }
    for (const child of Object.values(object)) visit(child);
  };
  visit(root);
  return finish(passedCount, skippedCount, names);
}

function parsePlaywright(root: Record<string, unknown>): DirectTestEvidence {
  let passedCount = 0;
  let skippedCount = 0;
  const names = new Set<string>();

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
            typeof result?.status === "string"
              ? result.status.toLowerCase()
              : "";
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

function parsePytest(stdout: string, stderr: string): DirectTestEvidence {
  let passedCount = 0;
  let skippedCount = 0;
  const names = new Set<string>();
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
): DirectTestEvidence {
  if (runner === "pytest") return parsePytest(stdout, stderr);
  const parsed = jsonFrom(stdout, stderr);
  const root = asRecord(parsed);
  if (!root) {
    return finish(0, 0, [], `${runner} reporter output was not valid JSON`);
  }
  return runner === "playwright"
    ? parsePlaywright(root)
    : parseJestLike(root);
}
