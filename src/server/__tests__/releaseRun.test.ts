import { describe, expect, it } from "vitest";
import {
  isPaperOnlyDelivery,
  releaseEligible,
  releaseRun,
  repoSlug,
} from "../orchestrator/releaseRun.js";
import type { ExecResult } from "../workspace/gitOps.js";

const ok = (stdout: string): ExecResult => ({
  code: 0,
  stdout,
  stderr: "",
  spawnError: null,
});
const fail = (stderr: string): ExecResult => ({
  code: 1,
  stdout: "",
  stderr,
  spawnError: null,
});

const VERIFIED_SHA = "abc123verified";

function fakeGh(script: Array<(args: string[]) => ExecResult>, headSha = VERIFIED_SHA) {
  const calls: string[][] = [];
  let i = 0;
  const impl = async (args: string[]): Promise<ExecResult> => {
    calls.push(args);
    if (args.includes("headRefOid")) return ok(headSha);
    const step = script[Math.min(i, script.length - 1)]!;
    i++;
    return step(args);
  };
  return { impl, calls };
}

const BASE = {
  repoUrl: "https://github.com/buckeye7066/GrantFlow",
  branch: "factory-deck/testrun1",
  runId: "testrun1-0000-0000",
  appName: "GrantFlow",
  verifiedCommitSha: VERIFIED_SHA,
  caveats: [],
  sleepImpl: async () => {},
  checkTimeoutMs: 1000,
};

describe("repoSlug", () => {
  it("parses https and ssh remotes and rejects non-github targets", () => {
    expect(repoSlug("https://github.com/a/b")).toBe("a/b");
    expect(repoSlug("git@github.com:a/b.git")).toBe("a/b");
    expect(repoSlug("C:\\somewhere\\local")).toBeNull();
  });
});

describe("releaseEligible — the evidence gate", () => {
  it("refuses when grounded QA failed", () => {
    expect(releaseEligible({ qaPassed: false, testStatus: "passing" }).eligible).toBe(
      false,
    );
  });
  it("refuses when tests failed or never executed", () => {
    expect(releaseEligible({ qaPassed: true, testStatus: "failing" }).eligible).toBe(
      false,
    );
    const unknown = releaseEligible({ qaPassed: true, testStatus: "unknown" });
    expect(unknown.eligible).toBe(false);
    expect(unknown.reason).toMatch(/no test command executed/i);
  });
  it("passes only with QA green AND tests executed green", () => {
    expect(releaseEligible({ qaPassed: true, testStatus: "passing" }).eligible).toBe(
      true,
    );
  });

  it("refuses a paper-only delivery even with QA and tests green (run a1d8866f class)", () => {
    const gate = releaseEligible({
      qaPassed: true,
      testStatus: "passing",
      paperOnly: true,
    });
    expect(gate.eligible).toBe(false);
    expect(gate.reason).toMatch(/no wired product change/i);
  });
});

describe("isPaperOnlyDelivery", () => {
  it("classifies run a1d8866f's actual delivery as paper", () => {
    expect(
      isPaperOnlyDelivery([
        "docs/connector-operations.md",
        "docs/current-state-audit.md",
        "docs/database-schema-audit.md",
        "docs/release-verification.md",
        "docs/security-and-ai-safety.md",
        "prisma/schema.prisma",
        "tests/current-state-contract.spec.ts",
        "tests/domain/eligibility-contract.spec.ts",
        "tests/schema-contract.spec.ts",
        "tests/security-release-contract.spec.ts",
      ]),
    ).toBe(true);
  });
  it("one wired product file makes the delivery real", () => {
    expect(
      isPaperOnlyDelivery(["docs/notes.md", "backend/services/matchEngine.js"]),
    ).toBe(false);
    expect(isPaperOnlyDelivery(["src/App.tsx"])).toBe(false);
  });
  it("recognizes suffix-style tests as paper, including tests beside source", () => {
    expect(
      isPaperOnlyDelivery(["src/App.test.tsx", "packages/api/auth.spec.mts"]),
    ).toBe(true);
  });
  it("recognizes Python tests beside source as paper", () => {
    expect(
      isPaperOnlyDelivery([
        "backend/test_profile.py",
        "src/profile_test.py",
        "pkg/tests/foo.py",
      ]),
    ).toBe(true);
  });
  it("an empty delivery is paper", () => {
    expect(isPaperOnlyDelivery([])).toBe(true);
  });
});

describe("releaseRun", () => {
  it("merges to main when the gate and the host repo's checks are green", async () => {
    const { impl, calls } = fakeGh([
      (a) =>
        a[1] === "create"
          ? ok("https://github.com/buckeye7066/GrantFlow/pull/99")
          : ok(""),
      (a) =>
        a[1] === "checks"
          ? ok(JSON.stringify([{ state: "SUCCESS", name: "test" }]))
          : ok(""),
      (a) => (a[1] === "merge" ? ok("merged") : ok("")),
      (a) => (a[1] === "view" ? ok("MERGED abc123def") : ok("")),
    ]);
    const res = await releaseRun({
      ...BASE,
      qaPassed: true,
      testStatus: "passing",
      ghImpl: impl,
    });
    expect(res.released).toBe(true);
    expect(res.mergedSha).toBe("abc123def");
    expect(res.prUrl).toMatch(/pull\/99/);
    expect(
      calls.some(
        (c) =>
          c[1] === "merge" &&
          c.includes("--squash") &&
          c.includes("--match-head-commit") &&
          c.includes(VERIFIED_SHA),
      ),
    ).toBe(true);
    expect(calls.flat().join(" ")).not.toMatch(/--force|--admin/);
  });

  it("creates no PR or other GitHub state when tests did not run", async () => {
    const { impl, calls } = fakeGh([() => ok("this must never be called")]);
    const res = await releaseRun({
      ...BASE,
      qaPassed: true,
      testStatus: "unknown",
      ghImpl: impl,
    });
    expect(res.released).toBe(false);
    expect(res.prUrl).toBeNull();
    expect(res.reason).toMatch(/no test command executed/i);
    expect(calls).toHaveLength(0);
  });

  it.each(["SKIPPED", "NEUTRAL", "UNKNOWN"])(
    "holds when host checks are terminal but %s rather than successful",
    async (state) => {
      const { impl, calls } = fakeGh([
        () => ok("https://github.com/buckeye7066/GrantFlow/pull/130"),
        () => ok(JSON.stringify([{ state, name: "policy" }])),
      ]);
      const res = await releaseRun({
        ...BASE,
        qaPassed: true,
        testStatus: "passing",
        ghImpl: impl,
      });
      expect(res.released).toBe(false);
      expect(res.reason).toMatch(/all-success|policy/i);
      expect(calls.some((call) => call[1] === "merge")).toBe(false);
    },
  );

  /* ---------------------------------------------------------------- *
   * "no checks reported" — absence must be CONFIRMED, never assumed.
   *
   * `gh pr checks` says "no checks reported" both for a repo with no CI
   * AND for the first seconds of a new PR whose workflow runs GitHub has
   * not registered yet. The old code broke out of the wait loop on the
   * FIRST such reading and merged — so a repo WITH CI could be merged to
   * main before its own suite had started.
   * ---------------------------------------------------------------- */

  it("does NOT merge on the first 'no checks reported' — it waits out the registration race", async () => {
    // Checks appear on the 3rd poll and are still running, then pass.
    const { impl, calls } = fakeGh([
      () => ok("https://github.com/buckeye7066/GrantFlow/pull/110"),
      () => ok("no checks reported on the 'factory-deck/testrun1' branch"),
      () => ok("no checks reported on the 'factory-deck/testrun1' branch"),
      (a) =>
        a[1] === "checks"
          ? ok(JSON.stringify([{ state: "IN_PROGRESS", name: "ci" }]))
          : ok(""),
      (a) =>
        a[1] === "checks"
          ? ok(JSON.stringify([{ state: "SUCCESS", name: "ci" }]))
          : ok(""),
      (a) => (a[1] === "merge" ? ok("merged") : ok("")),
      (a) => (a[1] === "view" ? ok("MERGED cafe1234") : ok("")),
    ]);
    const res = await releaseRun({
      ...BASE,
      qaPassed: true,
      testStatus: "passing",
      checkTimeoutMs: 60_000,
      noChecksGraceMs: 60_000, // never satisfied before the checks appear
      ghImpl: impl,
    });
    expect(res.released).toBe(true);
    // The decisive assertion: it did NOT merge while checks were absent or
    // still in progress. The merge came after SUCCESS was observed.
    expect(res.reason).toMatch(/green host-repo checks/i);
    const checkCalls = calls.filter((c) => c[1] === "checks").length;
    expect(checkCalls).toBeGreaterThanOrEqual(4);
  });

  it("holds the merge when checks appear FAILING after an initial 'no checks' window", async () => {
    // The exact race that used to auto-merge: absence first, failure later.
    const { impl, calls } = fakeGh([
      () => ok("https://github.com/buckeye7066/GrantFlow/pull/111"),
      () => ok("no checks reported on the 'factory-deck/testrun1' branch"),
      (a) =>
        a[1] === "checks"
          ? ok(JSON.stringify([{ state: "FAILURE", name: "unit" }]))
          : ok(""),
    ]);
    const res = await releaseRun({
      ...BASE,
      qaPassed: true,
      testStatus: "passing",
      checkTimeoutMs: 60_000,
      noChecksGraceMs: 60_000,
      ghImpl: impl,
    });
    expect(res.released).toBe(false);
    expect(res.reason).toMatch(/unit/);
    expect(calls.some((c) => c[1] === "merge")).toBe(false);
  });

  it("holds a repo with no CI because absence is not passing evidence", async () => {
    const { impl, calls } = fakeGh([
      () => ok("https://github.com/buckeye7066/GrantFlow/pull/112"),
      () => ok("no checks reported on the 'factory-deck/testrun1' branch"),
      () => ok("no checks reported on the 'factory-deck/testrun1' branch"),
      () => ok("no checks reported on the 'factory-deck/testrun1' branch"),
    ]);
    const res = await releaseRun({
      ...BASE,
      qaPassed: true,
      testStatus: "passing",
      checkTimeoutMs: 60_000,
      noChecksGraceMs: 0,
      noChecksConfirmations: 3,
      ghImpl: impl,
    });
    expect(res.released).toBe(false);
    expect(res.reason).toMatch(/no reported CI checks|absence/i);
    expect(calls.some((call) => call[1] === "merge")).toBe(false);
  });

  it("leaves the PR open when the repo reports no checks for the entire window", async () => {
    const { impl, calls } = fakeGh([
      () => ok("https://github.com/buckeye7066/GrantFlow/pull/113"),
      () => ok("no checks reported on the 'factory-deck/testrun1' branch"),
    ]);
    const res = await releaseRun({
      ...BASE,
      qaPassed: true,
      testStatus: "passing",
      checkTimeoutMs: 5, // deadline passes before the grace window can
      noChecksGraceMs: 10 * 60_000,
      ghImpl: impl,
    });
    expect(res.released).toBe(false);
    expect(res.reason).toMatch(/no checks/i);
    expect(calls.some((c) => c[1] === "merge")).toBe(false);
  });

  it("holds the merge when the host repo's checks fail, naming the checks", async () => {
    const { impl, calls } = fakeGh([
      () => ok("https://github.com/buckeye7066/GrantFlow/pull/101"),
      () =>
        ok(
          JSON.stringify([
            { state: "SUCCESS", name: "policy" },
            { state: "FAILURE", name: "browser-smoke" },
          ]),
        ),
    ]);
    const res = await releaseRun({
      ...BASE,
      qaPassed: true,
      testStatus: "passing",
      ghImpl: impl,
    });
    expect(res.released).toBe(false);
    expect(res.reason).toMatch(/browser-smoke/);
    expect(calls.some((c) => c[1] === "merge")).toBe(false);
  });

  it("keeps waiting through pending checks and times out to an open PR", async () => {
    const { impl } = fakeGh([
      () => ok("https://github.com/buckeye7066/GrantFlow/pull/102"),
      () => ok(JSON.stringify([{ state: "PENDING", name: "test" }])),
    ]);
    const res = await releaseRun({
      ...BASE,
      qaPassed: true,
      testStatus: "passing",
      ghImpl: impl,
      checkTimeoutMs: 1,
    });
    expect(res.released).toBe(false);
    expect(res.reason).toMatch(/did not finish/i);
    expect(res.prUrl).toMatch(/pull\/102/);
  });

  it("does not claim release when the merge command fails", async () => {
    const { impl } = fakeGh([
      () => ok("https://github.com/buckeye7066/GrantFlow/pull/103"),
      () => ok(JSON.stringify([{ state: "SUCCESS", name: "test" }])),
      () => fail("Pull request is not mergeable"),
    ]);
    const res = await releaseRun({
      ...BASE,
      qaPassed: true,
      testStatus: "passing",
      ghImpl: impl,
    });
    expect(res.released).toBe(false);
    expect(res.reason).toMatch(/merge refused/i);
  });

  it("does not claim release when post-merge state is not MERGED (verify the verification)", async () => {
    const { impl } = fakeGh([
      () => ok("https://github.com/buckeye7066/GrantFlow/pull/104"),
      () => ok(JSON.stringify([{ state: "SUCCESS", name: "test" }])),
      () => ok("merge queued"),
      () => ok("OPEN "),
    ]);
    const res = await releaseRun({
      ...BASE,
      qaPassed: true,
      testStatus: "passing",
      ghImpl: impl,
    });
    expect(res.released).toBe(false);
    expect(res.reason).toMatch(/state reads OPEN/i);
  });

  it("reuses an existing PR instead of failing on 'already exists'", async () => {
    const { impl } = fakeGh([
      () =>
        fail("a pull request for branch already exists: https://github.com/x/y/pull/7"),
      (a) =>
        a[1] === "view"
          ? ok("https://github.com/buckeye7066/GrantFlow/pull/7")
          : ok(""),
      () => ok(JSON.stringify([{ state: "SUCCESS", name: "test" }])),
      (a) => (a[1] === "merge" ? ok("merged") : ok("MERGED def456")),
    ]);
    const res = await releaseRun({
      ...BASE,
      qaPassed: true,
      testStatus: "passing",
      ghImpl: impl,
    });
    expect(res.prUrl).toMatch(/pull\/7/);
  });

  it("holds when the PR head differs from the verified delivered commit", async () => {
    const { impl, calls } = fakeGh(
      [
        () => ok("https://github.com/buckeye7066/GrantFlow/pull/120"),
        () => ok(JSON.stringify([{ state: "SUCCESS", name: "test" }])),
      ],
      "different-sha",
    );
    const res = await releaseRun({
      ...BASE,
      qaPassed: true,
      testStatus: "passing",
      ghImpl: impl,
    });
    expect(res.released).toBe(false);
    expect(res.reason).toMatch(/PR head|verified delivered commit/i);
    expect(calls.some((call) => call[1] === "merge")).toBe(false);
  });

  it("declines cleanly for non-GitHub destinations", async () => {
    const { impl, calls } = fakeGh([() => ok("")]);
    const res = await releaseRun({
      ...BASE,
      repoUrl: "file:///G:/somewhere",
      qaPassed: true,
      testStatus: "passing",
      ghImpl: impl,
    });
    expect(res.released).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
