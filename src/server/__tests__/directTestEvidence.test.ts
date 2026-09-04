import { describe, expect, it } from "vitest";
import {
  MAX_PERSISTED_PASSED_TEST_NAMES,
  MAX_PERSISTED_TEST_NAME_CHARS,
  parseDirectTestEvidence,
} from "../orchestrator/directTestEvidence.js";
import {
  MAX_TEST_PLAN_COVERAGE_ENTRIES,
  TestPlanSchema,
} from "../../shared/schemas.js";

describe("parseDirectTestEvidence", () => {
  it("accepts structured Vitest/Jest output and keeps exact passed titles", () => {
    const output = JSON.stringify({
      numPassedTests: 1,
      numPendingTests: 0,
      numTodoTests: 0,
      testResults: [
        {
          assertionResults: [
            {
              status: "passed",
              title: "profile persists after reload",
              fullName: "profile profile persists after reload",
            },
          ],
        },
      ],
    });
    expect(parseDirectTestEvidence("vitest", output, "")).toMatchObject({
      valid: true,
      passedCount: 1,
      skippedCount: 0,
      passedTestNames: expect.arrayContaining(["profile persists after reload"]),
    });
    expect(parseDirectTestEvidence("jest", "", output).valid).toBe(true);
  });

  it("rejects malformed, zero-pass, and skipped structured results", () => {
    expect(parseDirectTestEvidence("vitest", "src/App.test.tsx", "").valid).toBe(false);
    expect(
      parseDirectTestEvidence(
        "jest",
        JSON.stringify({ numPassedTests: 0, numPendingTests: 0 }),
        "",
      ).reason,
    ).toMatch(/zero passed/i);
    expect(
      parseDirectTestEvidence(
        "vitest",
        JSON.stringify({
          numPassedTests: 1,
          numPendingTests: 1,
          testResults: [
            {
              assertionResults: [{ status: "passed", title: "one" }],
            },
          ],
        }),
        "",
      ).reason,
    ).toMatch(/skipped|pending/i);
  });

  it("parses Playwright JSON and refuses skipped-only journeys", () => {
    const passed = JSON.stringify({
      suites: [
        {
          specs: [
            {
              title: "profile persists after reload",
              tests: [{ results: [{ status: "passed" }] }],
            },
          ],
        },
      ],
    });
    expect(parseDirectTestEvidence("playwright", passed, "")).toEqual({
      valid: true,
      passedCount: 1,
      skippedCount: 0,
      passedTestNames: ["profile persists after reload"],
    });

    const skipped = JSON.stringify({
      suites: [
        {
          specs: [
            {
              title: "profile persists after reload",
              tests: [{ results: [{ status: "skipped" }] }],
            },
          ],
        },
      ],
    });
    expect(parseDirectTestEvidence("playwright", skipped, "").valid).toBe(false);
  });

  it("parses pytest -vv node ids and supports *_test.py paths", () => {
    const output = [
      "============================= test session starts =============================",
      "tests/calculator_test.py::test_add PASSED                              [100%]",
      "============================== 1 passed in 0.01s ==============================",
    ].join("\n");
    expect(parseDirectTestEvidence("pytest", output, "")).toEqual({
      valid: true,
      passedCount: 1,
      skippedCount: 0,
      passedTestNames: ["test_add"],
    });
  });

  it("bounds reporter-controlled test titles before they enter a checkpoint", () => {
    const mappedTitle = "mapped acceptance title";
    const assertionResults = Array.from(
      { length: MAX_PERSISTED_PASSED_TEST_NAMES + 50 },
      (_, index) => ({
        status: "passed",
        title: `${index}:${"x".repeat(MAX_PERSISTED_TEST_NAME_CHARS - 20)}`,
      }),
    );
    assertionResults.push({ status: "passed", title: mappedTitle });
    const parsed = parseDirectTestEvidence(
      "vitest",
      JSON.stringify({
        numPassedTests: assertionResults.length,
        numPendingTests: 0,
        testResults: [{ assertionResults }],
      }),
      "",
      [mappedTitle],
    );

    expect(parsed.valid).toBe(true);
    expect(parsed.passedTestNames).toHaveLength(MAX_PERSISTED_PASSED_TEST_NAMES);
    expect(parsed.passedTestNames).toContain(mappedTitle);
    expect(
      parsed.passedTestNames.every(
        (name) => name.length <= MAX_PERSISTED_TEST_NAME_CHARS,
      ),
    ).toBe(true);
  });

  it("never truncates an oversized reporter title into a mapped title", () => {
    const mappedTitle = "x".repeat(MAX_PERSISTED_TEST_NAME_CHARS);
    const parsed = parseDirectTestEvidence(
      "vitest",
      JSON.stringify({
        numPassedTests: 1,
        numPendingTests: 0,
        testResults: [
          {
            assertionResults: [
              { status: "passed", title: `${mappedTitle}-different-test` },
            ],
          },
        ],
      }),
      "",
      [mappedTitle],
    );

    expect(parsed.valid).toBe(true);
    expect(parsed.passedTestNames).not.toContain(mappedTitle);
  });

  it("bounds the acceptance contract to the durable exact-name capacity", () => {
    const coverage = Array.from(
      { length: MAX_TEST_PLAN_COVERAGE_ENTRIES + 1 },
      (_, index) => ({
        requirementId: `AC-${index}`,
        testPath: "tests/acceptance.test.ts",
        testName: `acceptance ${index}`,
        kind: "unit" as const,
      }),
    );
    const base = { testPlan: "acceptance", files: [] };

    expect(TestPlanSchema.safeParse({ ...base, coverage }).success).toBe(false);
    expect(
      TestPlanSchema.safeParse({
        ...base,
        coverage: [
          {
            ...coverage[0],
            testName: "x".repeat(MAX_PERSISTED_TEST_NAME_CHARS + 1),
          },
        ],
      }).success,
    ).toBe(false);
  });
});
