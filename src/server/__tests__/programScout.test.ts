import { describe, expect, it } from "vitest";
import {
  programScoutConfiguration,
  runProgramScout,
} from "../tools/programScout.js";

const job = {
  id: "11111111-1111-4111-8111-111111111111",
  targetUrl: "https://example.com/app",
  normalizedUrl: "https://example.com/app",
  targetHost: "example.com",
  programSlug: "app",
  status: "running",
  stage: "researching",
  progress: 10,
  branchName: null,
  headSha: null,
  research: null,
  specification: null,
  verification: null,
  failureCode: null,
  failureMessage: null,
};

describe("Program Scout client", () => {
  it("fails closed when no Scout credential is configured", async () => {
    expect(programScoutConfiguration({})).toMatchObject({ configured: false });
    await expect(
      runProgramScout("https://example.com/app", { env: {} }),
    ).resolves.toMatchObject({
      configured: false,
      completed: false,
      job: null,
    });
  });

  it("does not call a queued job complete until its exact branch SHA passes verification", async () => {
    const calls: string[] = [];
    const ready = {
      ...job,
      status: "ready",
      stage: "complete",
      progress: 100,
      branchName: "scout/app-11111111",
      headSha: "head123",
      verification: {
        state: "passed",
        commitSha: "head123",
        requiredChecks: ["test", "build"],
        passedChecks: ["test", "build"],
        failedChecks: [],
        checkedAt: "2026-09-03T00:00:00Z",
      },
    };
    const result = await runProgramScout("https://example.com/app", {
      env: {
        PURPOSE_FOUNDRY_PROGRAM_SCOUT_URL: "https://scout.example",
        PURPOSE_FOUNDRY_PROGRAM_SCOUT_TOKEN: "secret",
      },
      sleepImpl: async () => {},
      fetchImpl: async (input, init) => {
        calls.push(`${init?.method ?? "GET"} ${String(input)}`);
        const body = init?.method === "POST" ? { job } : { job: ready };
        return new Response(JSON.stringify(body), {
          status: init?.method === "POST" ? 202 : 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    expect(result).toMatchObject({
      configured: true,
      completed: true,
      endpoint: "https://scout.example",
      job: {
        status: "ready",
        branchName: "scout/app-11111111",
        headSha: "head123",
      },
    });
    expect(calls).toEqual([
      "POST https://scout.example/api/scout/jobs",
      `GET https://scout.example/api/scout/jobs/${job.id}`,
    ]);
  });

  it("rejects ready status when verification points at a different commit", async () => {
    const inconsistent = {
      ...job,
      status: "ready",
      stage: "complete",
      branchName: "scout/app",
      headSha: "head123",
      verification: {
        state: "passed",
        commitSha: "different",
        requiredChecks: ["test"],
        passedChecks: ["test"],
        failedChecks: [],
        checkedAt: "2026-09-03T00:00:00Z",
      },
    };
    const result = await runProgramScout("https://example.com/app", {
      env: {
        PURPOSE_FOUNDRY_PROGRAM_SCOUT_URL: "https://scout.example",
        PURPOSE_FOUNDRY_PROGRAM_SCOUT_TOKEN: "secret",
      },
      fetchImpl: async () =>
        new Response(JSON.stringify({ job: inconsistent }), {
          status: 202,
          headers: { "content-type": "application/json" },
        }),
    });
    expect(result.completed).toBe(false);
    expect(result.reason).toMatch(/without matching passed verification/i);
  });
});
