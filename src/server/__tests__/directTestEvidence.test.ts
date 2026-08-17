import { describe, expect, it } from "vitest";
import { parseDirectTestEvidence } from "../orchestrator/directTestEvidence.js";

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
});
