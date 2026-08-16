import { describe, expect, it } from "vitest";
import {
  isPaperOnlyDelivery,
  releaseEligible,
  releaseRun,
  repoSlug,
} from "../orchestrator/releaseRun.js";
import type { ExecResult } from "../workspace/gitOps.js";

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "", spawnError: null });
const fail = (stderr: string): ExecResult => ({ code: 1, stdout: "", stderr, spawnError: null });

function fakeGh(script: Array<(args: string[]) => ExecResult>) {
  const calls: string[][] = [];
  let i = 0;
  const impl = async (args: string[]): Promise<ExecResult> => {
    calls.push(args);
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
    expect(releaseEligible({ qaPassed: false, testStatus: "passing" }).eligible).toBe(false);
  });
  it("refuses when tests failed or never executed", () => {
    expect(releaseEligible({ qaPassed: true, testStatus: "failing" }).eligible).toBe(false);
    const unknown = releaseEligible({ qaPassed: true, testStatus: "unknown" });
    expect(unknown.eligible).toBe(false);
    expect(unknown.reason).toMatch(/no test command executed/i);
  });
  it("passes only with QA green AND tests executed green", () => {
    expect(releaseEligible({ qaPassed: true, testStatus: "passing" }).eligible).toBe(true);
  });

  it("refuses a paper-only delivery even with QA and tests green (run a1d8866f class)", () => {
    const gate = releaseEligible({ qaPassed: true, testStatus: "passing", paperOnly: true });
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
  it("an empty delivery is paper", () => {
    expect(isPaperOnlyDelivery([])).toBe(true);
  });
});

describe("releaseRun", () => {
  it("merges to main when the gate and the host repo's checks are green", async () => {
    const { impl, calls } = fakeGh([
      (a) => (a[1] === "create" ? ok("https://github.com/buckeye7066/GrantFlow/pull/99") : ok("")),
      (a) => (a[1] === "checks" ? ok(JSON.stringify([{ state: "SUCCESS", name: "test" }])) : ok("")),
      (a) => (a[1] === "merge" ? ok("merged") : ok("")),
      (a) => (a[1] === "view" ? ok("MERGED abc123def") : ok("")),
    ]);
    const res = await releaseRun({ ...BASE, qaPassed: true, testStatus: "passing", ghImpl: impl });
    expect(res.released).toBe(true);
    expect(res.mergedSha).toBe("abc123def");
    expect(res.prUrl).toMatch(/pull\/99/);
    expect(calls.some((c) => c[1] === "merge" && c.includes("--squash"))).toBe(true);
    expect(calls.flat().join(" ")).not.toMatch(/--force|--admin/);
  });

  it("opens the PR but NEVER merges when tests did not run", async () => {
    const { impl, calls } = fakeGh([
      () => ok("https://github.com/buckeye7066/GrantFlow/pull/100"),
    ]);
    const res = await releaseRun({ ...BASE, qaPassed: true, testStatus: "unknown", ghImpl: impl });
    expect(res.released).toBe(false);
    expect(res.prUrl).toMatch(/pull\/100/);
    expect(res.reason).toMatch(/no test command executed/i);
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
    const res = await releaseRun({ ...BASE, qaPassed: true, testStatus: "passing", ghImpl: impl });
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
    const res = await releaseRun({ ...BASE, qaPassed: true, testStatus: "passing", ghImpl: impl });
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
    const res = await releaseRun({ ...BASE, qaPassed: true, testStatus: "passing", ghImpl: impl });
    expect(res.released).toBe(false);
    expect(res.reason).toMatch(/state reads OPEN/i);
  });

  it("reuses an existing PR instead of failing on 'already exists'", async () => {
    const { impl } = fakeGh([
      () => fail("a pull request for branch already exists: https://github.com/x/y/pull/7"),
      (a) => (a[1] === "view" ? ok("https://github.com/buckeye7066/GrantFlow/pull/7") : ok("")),
      () => ok(JSON.stringify([{ state: "SUCCESS", name: "test" }])),
      (a) => (a[1] === "merge" ? ok("merged") : ok("MERGED def456")),
    ]);
    const res = await releaseRun({ ...BASE, qaPassed: true, testStatus: "passing", ghImpl: impl });
    expect(res.prUrl).toMatch(/pull\/7/);
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
