import { describe, expect, it } from "vitest";
import { releaseRun, type ReleaseInput } from "../orchestrator/releaseRun.js";
import type { ExecResult } from "../workspace/gitOps.js";
const PR = "https://github.com/example/product/pull/17";
const HEAD = "a".repeat(40);
const MERGE = "b".repeat(40);
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
const base: ReleaseInput = {
  repoUrl: "https://github.com/example/product",
  branch: "factory-deck/run",
  runId: "saved-run",
  appName: "Product",
  qaPassed: true,
  testStatus: "passing",
  verifiedCommitSha: HEAD,
  caveats: [],
  checkTimeoutMs: -1,
  sleepImpl: async () => {},
};
type Check = { name: string; state: string };
function host(checks: Check[], required: Check[] | ExecResult = []) {
  const calls: string[][] = [];
  const impl = async (args: string[]): Promise<ExecResult> => {
    calls.push(args);
    if (args[1] === "create") return ok(PR);
    if (args[1] === "checks")
      return args.includes("--required")
        ? Array.isArray(required)
          ? ok(JSON.stringify(required))
          : required
        : ok(JSON.stringify(checks));
    if (args.includes("headRefOid")) return ok(HEAD);
    if (args[1] === "merge") return ok("merged");
    if (args[1] === "view") return ok(`MERGED ${MERGE}`);
    throw new Error(`unexpected command ${args.join(" ")}`);
  };
  return { calls, impl };
}

describe("release recovery remains exact-commit and evidence-bound", () => {
  it("reconciles a saved merged PR without recreating its deleted source branch or PR", async () => {
    const calls: string[][] = [];
    const result = await releaseRun({
      ...base,
      existingPrUrl: PR,
      ghImpl: async (args) => {
        calls.push(args);
        return ok(`${PR}\tMERGED\t${HEAD}\t${MERGE}`);
      },
    });
    expect(result).toMatchObject({ released: true, state: "merged", mergedSha: MERGE });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 3)).toEqual(["pr", "view", PR]);
  });

  it.each(["wrong-head", "no-merge-sha", "closed"])(
    "does not claim release from a saved PR with %s",
    async (issue) => {
      const result = await releaseRun({
        ...base,
        existingPrUrl: PR,
        ghImpl: async () =>
          ok(
            `${PR}\t${issue === "closed" ? "CLOSED" : "MERGED"}\t${issue === "wrong-head" ? MERGE : HEAD}\t${issue === "no-merge-sha" ? "" : MERGE}`,
          ),
      });
      expect(result.released).toBe(false);
      expect(result.state).toBe("held");
    },
  );

  it("rejects a saved PR belonging to another repository before touching GitHub", async () => {
    let calls = 0;
    const result = await releaseRun({
      ...base,
      existingPrUrl: "https://github.com/other/repo/pull/1",
      ghImpl: async () => {
        calls++;
        return ok("");
      },
    });
    expect(calls).toBe(0);
    expect(result.reason).toContain("destination repository");
  });

  it("recovers an already merged PR even when creation says no commits between", async () => {
    const result = await releaseRun({
      ...base,
      ghImpl: async (args) =>
        args[1] === "create"
          ? fail("No commits between main and factory-deck/run")
          : ok(`${PR}\tMERGED\t${HEAD}\t${MERGE}`),
    });
    expect(result.released).toBe(true);
    expect(result.mergedSha).toBe(MERGE);
  });

  it.each(["SKIPPED", "NEUTRAL"])(
    "does not block an executed passing required check on an optional %s check",
    async (state) => {
      const h = host(
        [
          { name: "tests", state: "SUCCESS" },
          { name: "optional-preview", state },
        ],
        [{ name: "tests", state: "SUCCESS" }],
      );
      const result = await releaseRun({ ...base, ghImpl: h.impl });
      expect(result.released).toBe(true);
      expect(h.calls.some((a) => a.includes("--required"))).toBe(true);
      expect(h.calls.find((a) => a[1] === "merge")).toContain(HEAD);
      expect(h.calls.flat()).not.toContain("--admin");
      expect(h.calls.flat()).not.toContain("--force");
    },
  );

  it.each(["SKIPPED", "NEUTRAL", "FAILURE"])(
    "keeps a required %s check held, even when optional checks passed",
    async (state) => {
      const checks = [
        { name: "required-tests", state },
        { name: "optional", state: "SUCCESS" },
      ];
      const h = host(checks, [{ name: "required-tests", state }]);
      const result = await releaseRun({ ...base, ghImpl: h.impl });
      expect(result.released).toBe(false);
      expect(h.calls.some((a) => a[1] === "merge")).toBe(false);
    },
  );

  it("does not guess optionality when the required-check query is unavailable", async () => {
    const h = host(
      [
        { name: "tests", state: "SUCCESS" },
        { name: "unknown", state: "SKIPPED" },
      ],
      fail("API unavailable"),
    );
    const result = await releaseRun({ ...base, ghImpl: h.impl });
    expect(result.released).toBe(false);
    expect(result.retryable).toBe(true);
    expect(h.calls.some((a) => a[1] === "merge")).toBe(false);
  });

  it("does not turn a collection of skipped optional checks into execution proof", async () => {
    const h = host([{ name: "optional", state: "SKIPPED" }]);
    const result = await releaseRun({ ...base, ghImpl: h.impl });
    expect(result.released).toBe(false);
    expect(h.calls.some((a) => a[1] === "merge")).toBe(false);
  });

  it.each(["[]", "null", "{}", "not json", '[{"name":"bad"}]'])(
    "does not arm an automatic merge from invalid/empty check evidence: %s",
    async (raw) => {
      const calls: string[][] = [];
      const result = await releaseRun({
        ...base,
        ghImpl: async (args) => {
          calls.push(args);
          return args[1] === "create" ? ok(PR) : ok(raw);
        },
      });
      expect(result.state).toBe("held");
      expect(result.retryable).toBe(true);
      expect(calls.some((a) => a[1] === "merge")).toBe(false);
    },
  );

  it("does not reinterpret disappearing checks as a repository without CI", async () => {
    let checks = 0;
    const calls: string[][] = [];
    const result = await releaseRun({
      ...base,
      checkTimeoutMs: 60_000,
      noChecksGraceMs: 0,
      noChecksConfirmations: 1,
      ghImpl: async (args) => {
        calls.push(args);
        if (args[1] === "create") return ok(PR);
        return checks++ === 0
          ? ok('[{"name":"tests","state":"PENDING"}]')
          : fail("no checks reported");
      },
    });
    expect(result.reason).toContain("disappeared");
    expect(calls.some((a) => a[1] === "merge")).toBe(false);
  });
});
