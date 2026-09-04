import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { RunAttributionSchema, type RunRecord } from "../../shared/schemas.js";
import type { FactoryCheckpoint } from "../orchestrator/checkpoint.js";
import { buildAttribution } from "../storage/attribution.js";

describe("durable run attribution receipts", () => {
  it("keeps terminal attribution bound to the live checkpoint", async () => {
    const source = await readFile(
      new URL("../orchestrator/runFactory.ts", import.meta.url),
      "utf8",
    );
    const persistAttribution = source.slice(
      source.indexOf("const persistAttribution"),
      source.indexOf("let inPlaceRestore"),
    );

    expect(persistAttribution).toContain("checkpoint,");
    expect(persistAttribution).not.toMatch(
      /getRunCheckpoint[\s\S]*?catch\(\(\) => null\)/,
    );
  });

  it("binds generated files, verification commands, approval, commit, and rollback", () => {
    const runId = randomUUID();
    const run = {
      id: runId,
      workspacePath: "/factory/workspaces/example",
      destination: {
        kind: "existing-repo",
        target: "owner/example",
        branch: "factory-deck/example",
        status: "delivered",
        detail: "branch pushed",
        url: "https://github.com/owner/example",
        commitSha: "a".repeat(40),
        trunkAdvancePath: "pr-gate",
        deliveredAt: Date.now(),
      },
      release: {
        released: true,
        prUrl: "https://github.com/owner/example/pull/7",
        mergedSha: "b".repeat(40),
        reason: "merged",
        state: "merged",
      },
    } as RunRecord;
    const checkpoint = {
      verification: {
        executed: [
          {
            command: "pnpm test",
            exitCode: 0,
            isTest: true,
            outputTail: "all passed",
          },
        ],
        incomplete: [],
        fileDigests: {
          "src/index.ts": "c".repeat(64),
          "package.json": "d".repeat(64),
        },
      },
      preReleaseApproval: {
        schema: "factory.pre-release-readiness.v1",
        evidenceDigest: "e".repeat(64),
        approved: true,
        reviews: [],
        blockers: [],
      },
    } as unknown as FactoryCheckpoint;

    const attribution = buildAttribution(run, {
      allowUntrustedScripts: true,
      testResult: "passing",
      auditSeq: 42,
      checkpoint,
    });

    expect(RunAttributionSchema.parse(attribution)).toEqual(attribution);
    expect(attribution.generatedFiles).toEqual([
      { path: "package.json", sha256: "d".repeat(64) },
      { path: "src/index.ts", sha256: "c".repeat(64) },
    ]);
    expect(attribution.verifiedCommitSha).toBe("a".repeat(40));
    expect(attribution.approval).toEqual({
      allowUntrustedScripts: true,
      evidenceDigest: "e".repeat(64),
      approved: true,
    });
    expect(attribution.testReceipt?.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(attribution.testReceipt?.commands).toEqual([
      { command: "pnpm test", exitCode: 0, isTest: true },
    ]);
    expect(attribution.rollback).toMatchObject({
      workspacePath: "/factory/workspaces/example",
      commitSha: "a".repeat(40),
      branch: "factory-deck/example",
      pullRequestUrl: "https://github.com/owner/example/pull/7",
      mergedSha: "b".repeat(40),
      trunkAdvancePath: "pr-gate",
    });
  });

  it("keeps legacy manifests readable with explicit empty receipt defaults", () => {
    const parsed = RunAttributionSchema.parse({
      jobId: randomUUID(),
      worktreePath: null,
      approval: { allowUntrustedScripts: false },
    });

    expect(parsed.approval).toEqual({
      allowUntrustedScripts: false,
      evidenceDigest: null,
      approved: null,
    });
    expect(parsed.generatedFiles).toEqual([]);
    expect(parsed.verifiedCommitSha).toBeNull();
    expect(parsed.testReceipt).toBeNull();
    expect(parsed.rollback).toBeNull();
  });
});
