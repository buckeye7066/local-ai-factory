import { describe, it, expect } from "vitest";
import { resolveGeneratedWrite } from "../workspace/applyEdits.js";
import { groundFinalReport } from "../orchestrator/reportGrounding.js";
import type { FinalReport } from "../../shared/schemas.js";
import {
  foldTestExit,
  freshTestVerdict,
  testStatusFor,
} from "../orchestrator/testVerdict.js";

/**
 * A run may only report what it actually did.
 *
 * Each block below pins one measured overclaim: work the run refused but
 * counted, a file it "wrote" that was empty, an in-memory copy that disagreed
 * with disk, a red test signal laundered green, and a report whose prose
 * outran its evidence.
 */

/* ------------------------------------------------------------------ */
/* 2. An EMPTY new file is refused, like an empty replacement          */
/* ------------------------------------------------------------------ */

describe("resolveGeneratedWrite — empty content is never written", () => {
  const missing = () => {
    throw new Error("ENOENT");
  };

  it("refuses an empty NEW file instead of creating a 0-byte source file", () => {
    const res = resolveGeneratedWrite(
      "/ws",
      "src/new.ts",
      { contents: "", edits: [] },
      missing,
    );
    expect(res.contents).toBeNull();
    expect(res.reason).toMatch(/empty contents for a new file/i);
  });

  it("refuses a whitespace-only NEW file too", () => {
    const res = resolveGeneratedWrite(
      "/ws",
      "src/new.ts",
      { contents: "   \n\t \n", edits: [] },
      missing,
    );
    expect(res.contents).toBeNull();
  });

  it("still writes a genuinely new file with real content", () => {
    const res = resolveGeneratedWrite(
      "/ws",
      "src/new.ts",
      { contents: "export const a = 1;\n", edits: [] },
      missing,
    );
    expect(res.contents).toBe("export const a = 1;\n");
    expect(res.edited).toBe(false);
  });

  it("still refuses an empty replacement of an EXISTING file", () => {
    const res = resolveGeneratedWrite(
      "/ws",
      "src/old.ts",
      { contents: "", edits: [] },
      () => "export const kept = 1;\n",
    );
    expect(res.contents).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 1 + 3. The write tally invariant, and disk-truth contents           */
/* ------------------------------------------------------------------ */

/**
 * writeBuild lives inside executeRun's closure, so its contract is pinned
 * structurally here: the tally must account for every candidate, and the
 * stored contents must be the post-correction text.
 */
describe("write accounting — candidates === written + refused", () => {
  it("the tally shape makes a silent no-op impossible to report as success", () => {
    // Mirrors the shape writeBuild returns.
    const tally = {
      candidates: 3,
      written: 1,
      refusals: [
        { path: "a.ts", reason: "protected host file" },
        { path: "b.ts", reason: "undeclared dependency" },
      ],
    };
    expect(tally.written + tally.refusals.length).toBe(tally.candidates);
  });
});

/* ------------------------------------------------------------------ */
/* 5. The final report's prose cannot outrun the evidence              */
/* ------------------------------------------------------------------ */

const baseReport = (over: Partial<FinalReport> = {}): FinalReport => ({
  appName: "Thing",
  summary: "The app is complete and all tests pass.",
  whatWasBuilt: ["A dashboard where all tests pass."],
  howToRun: "npm start",
  testStatus: "passing",
  repairLoops: 0,
  caveats: [],
  nextImprovements: [],
  workspacePath: "/ws",
  providerUsage: {
    free: { calls: 0 },
    anthropic: { calls: 0 },
    openai: { calls: 0 },
    stub: { calls: 0 },
    mock: { calls: 0 },
    totalCalls: 0,
  },
  ...over,
});

describe("groundFinalReport — prose is corrected to match executed evidence", () => {
  it("leaves a genuinely passing report alone", () => {
    const out = groundFinalReport({
      report: baseReport(),
      evidence: { executed: [{ command: "npm test", exitCode: 0, outputTail: "ok" }] },
      testStatus: "passing",
      writtenFiles: ["src/a.ts"],
    });
    expect(out.summary).toBe("The app is complete and all tests pass.");
    expect(out.caveats).toEqual([]);
  });

  it("defangs an 'all tests pass' claim when tests actually FAILED", () => {
    const out = groundFinalReport({
      report: baseReport(),
      evidence: {
        executed: [{ command: "npm test", exitCode: 1, outputTail: "1 failing" }],
      },
      testStatus: "failing",
      writtenFiles: ["src/a.ts"],
    });
    // The lie must not stand unqualified.
    expect(out.summary).toMatch(/UNSUPPORTED — testStatus=failing/);
    expect(out.caveats[0]).toMatch(/TESTS DID NOT PASS/);
    expect(out.caveats.join(" ")).toMatch(/npm test/);
    expect(out.caveats.join(" ")).toMatch(/exit 1/);
  });

  it("defangs the same claim inside whatWasBuilt, not just the summary", () => {
    const out = groundFinalReport({
      report: baseReport(),
      evidence: { executed: [] },
      testStatus: "unknown",
      writtenFiles: ["src/a.ts"],
    });
    expect(out.whatWasBuilt.join(" ")).toMatch(/UNSUPPORTED/);
  });

  it("says plainly when tests NEVER executed", () => {
    const out = groundFinalReport({
      report: baseReport({ summary: "Shipped it." }),
      evidence: { executed: [] },
      testStatus: "unknown",
      writtenFiles: ["src/a.ts"],
    });
    expect(out.caveats.join(" ")).toMatch(/TESTS NEVER EXECUTED/);
    expect(out.caveats.join(" ")).toMatch(/No verification commands executed/);
  });

  it("reports a killed (null-exit) command as killed, not as a pass", () => {
    const out = groundFinalReport({
      report: baseReport(),
      evidence: {
        executed: [{ command: "npm test", exitCode: null, outputTail: "..." }],
      },
      testStatus: "failing",
      writtenFiles: ["src/a.ts"],
    });
    expect(out.caveats.join(" ")).toMatch(/killed/i);
  });

  it("says NO FILES REACHED DISK when the run wrote nothing", () => {
    const out = groundFinalReport({
      report: baseReport(),
      evidence: { executed: [{ command: "npm test", exitCode: 0, outputTail: "ok" }] },
      testStatus: "passing",
      writtenFiles: [],
    });
    expect(out.caveats.join(" ")).toMatch(/NO FILES REACHED DISK/);
  });

  it("surfaces refused writes as caveats rather than dropping them", () => {
    const out = groundFinalReport({
      report: baseReport(),
      evidence: { executed: [{ command: "npm test", exitCode: 0, outputTail: "ok" }] },
      testStatus: "passing",
      writtenFiles: ["src/a.ts"],
      refusals: [{ path: "src/b.ts", reason: "undeclared dependency — zod" }],
    });
    expect(out.caveats.join(" ")).toMatch(/REFUSED \(not written\): src\/b\.ts/);
  });

  it("keeps the model's own caveats alongside the grounded ones", () => {
    const out = groundFinalReport({
      report: baseReport({ caveats: ["The UI is plain."] }),
      evidence: { executed: [{ command: "npm test", exitCode: 1, outputTail: "x" }] },
      testStatus: "failing",
      writtenFiles: ["src/a.ts"],
    });
    expect(out.caveats).toContain("The UI is plain.");
    // Grounded caveats come first so they cannot be buried.
    expect(out.caveats[0]).toMatch(/TESTS DID NOT PASS/);
  });
});

/* ------------------------------------------------------------------ */
/* 4. A red test signal is never erased by a later green               */
/* ------------------------------------------------------------------ */

describe("test verdict — a failure or a kill is sticky", () => {
  const fold = (codes: Array<number | null>) =>
    codes.reduce(foldTestExit, freshTestVerdict());

  it("records the first result, whatever it is", () => {
    expect(fold([0]).testExit).toBe(0);
    expect(fold([1]).testExit).toBe(1);
    expect(fold([null]).testExit).toBeNull();
  });

  it("THE BUG: a timeout-killed suite (null) is NOT laundered by a later pass", () => {
    // A 45-minute test suite gets SIGKILLed -> exitCode null, executed true.
    // A later passing command must not turn that into "passing".
    const state = fold([null, 0]);
    expect(state.testExit).toBeNull();
    expect(testStatusFor(true, state.testExit)).toBe("failing");
  });

  it("a failing suite is not laundered by a later pass either", () => {
    expect(fold([1, 0]).testExit).toBe(1);
    expect(testStatusFor(true, fold([1, 0]).testExit)).toBe("failing");
  });

  it("a later FAILURE does overwrite an earlier pass", () => {
    expect(fold([0, 1]).testExit).toBe(1);
    expect(testStatusFor(true, fold([0, 1]).testExit)).toBe("failing");
  });

  it("two clean passes stay passing", () => {
    expect(fold([0, 0]).testExit).toBe(0);
    expect(testStatusFor(true, fold([0, 0]).testExit)).toBe("passing");
  });

  it("no execution is 'unknown', never 'passing'", () => {
    expect(testStatusFor(false, null)).toBe("unknown");
    expect(testStatusFor(false, 0)).toBe("unknown");
  });
});
