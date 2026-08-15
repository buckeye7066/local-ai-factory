import { describe, expect, it } from "vitest";
import { groundQaReport } from "../orchestrator/qaGrounding.js";
import type { QaReport } from "../../shared/schemas.js";

const llmPass: QaReport = { summary: "Looks great.", passed: true, issues: [] };
const llmFail: QaReport = {
  summary: "Broken.",
  passed: false,
  issues: [
    {
      severity: "critical",
      title: "usaspendingGov.js has a parse error at line 101 column 39",
      detail: "fabricated",
      file: "backend/connectors/usaspendingGov.js",
      repairInstruction: "fix the parse error",
    },
  ],
};

describe("groundQaReport — executed evidence is the verdict authority", () => {
  it("a fabricated FAILURE cannot survive all-green executed commands (the 700222c1 class)", () => {
    const grounded = groundQaReport(llmFail, {
      executed: [
        { command: "npm ci", exitCode: 0, outputTail: "added 100 packages" },
        { command: "npm test", exitCode: 0, outputTail: "all green" },
      ],
    });
    expect(grounded.passed).toBe(true);
    expect(grounded.summary).toContain("overridden");
    // The model's claimed issues are retained as advisory, never invented away.
    expect(grounded.issues).toHaveLength(1);
  });

  it("a fabricated PASS cannot survive a failing executed command (the c72fdb26 class)", () => {
    const grounded = groundQaReport(llmPass, {
      executed: [
        {
          command: "npm test",
          exitCode: 1,
          outputTail: "FAIL src/lib/format.js no-restricted-syntax at 125:8",
        },
      ],
    });
    expect(grounded.passed).toBe(false);
    expect(grounded.issues[0]!.title).toContain("npm test");
    expect(grounded.issues[0]!.title).toContain("exit 1");
    // The synthetic issue carries the REAL output, so the repair agent
    // chases the actual error rather than a model hallucination.
    expect(grounded.issues[0]!.detail).toContain("no-restricted-syntax");
    expect(grounded.issues[0]!.severity).toBe("critical");
  });

  it("synthetic failing-command issues are PREPENDED ahead of model-authored issues", () => {
    const grounded = groundQaReport(llmFail, {
      executed: [
        { command: "npm test", exitCode: 2, outputTail: "real failure output" },
      ],
    });
    expect(grounded.passed).toBe(false);
    expect(grounded.issues[0]!.title).toContain("Executed command failed");
    expect(grounded.issues[1]!.title).toContain("parse error");
  });

  it("an honest executed failure keeps its failing verdict (no flip, no override note)", () => {
    const grounded = groundQaReport(llmFail, {
      executed: [{ command: "npm test", exitCode: 1, outputTail: "boom" }],
    });
    expect(grounded.passed).toBe(false);
    expect(grounded.summary).not.toContain("overridden");
  });

  it("zero executed commands leaves the model verdict but labels it unverified", () => {
    const grounded = groundQaReport(llmPass, { executed: [] });
    expect(grounded.passed).toBe(true);
    expect(grounded.summary).toContain("[unverified");
  });

  it("bounds the evidence tail carried inside a synthetic issue", () => {
    const grounded = groundQaReport(llmPass, {
      executed: [
        {
          command: "npm test",
          exitCode: 1,
          outputTail: "x".repeat(50_000) + "THE-REAL-ERROR-AT-THE-END",
        },
      ],
    });
    expect(grounded.issues[0]!.detail.length).toBeLessThanOrEqual(6000);
    // Errors print last — the tail must keep the END of the output.
    expect(grounded.issues[0]!.detail).toContain("THE-REAL-ERROR-AT-THE-END");
  });
});
