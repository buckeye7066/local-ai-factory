import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { findRemovedRunOption, REMOVED_RUN_OPTIONS } from "../removedOptions.js";
import { deliverRun } from "../orchestrator/deliverRun.js";
import {
  captureFileDigests,
  verifyCommitFileDigests,
} from "../workspace/verificationReceipt.js";
import type { RunDestination } from "../../shared/schemas.js";

/**
 * Explicit demo output may reach the owner as a zero-credit preview, but it
 * must never reach an owner's repo or be confused with a live run.
 *
 * Two measured defects motivate this file:
 *
 * `deliverRun` was NOT demo-gated (release-to-main and deploy were). A
 *     demo run against an attached repo committed 8 files of canned stub
 *     source — OVERWRITING the repo's own package.json and README — onto a
 *     `factory-deck/<id>` branch, and reported status "delivered".
 *
 * These tests exercise the failure mode itself, not just the happy path: each
 * one would pass against the buggy code if it only asserted "no crash", so
 * they assert on the repo's actual contents and on the rejection payload.
 */

describe("owner run options — demo is explicit; ambiguous no-op flags fail", () => {
  it("forces demo extensions into an isolated repository copy", () => {
    const routeSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const orchestratorSource = readFileSync(
      new URL("../orchestrator/runFactory.ts", import.meta.url),
      "utf8",
    );

    expect(routeSource).toMatch(
      /repoSource:\s*parsed\.data\.repoSource[\s\S]*?inPlace:\s*false/,
    );
    expect(orchestratorSource).toContain(
      "repoSource = { ...repoSource, inPlace: false };",
    );
  });

  it("accepts an explicit demo option for the zero-credit owner preview", () => {
    expect(findRemovedRunOption({ demo: true })).toBeNull();
    expect(findRemovedRunOption({ demo: false })).toBeNull();
  });

  it("rejects every removed sibling flag, not just demo", () => {
    for (const removed of REMOVED_RUN_OPTIONS) {
      const rejection = findRemovedRunOption({ [removed.key]: true });
      expect(rejection, `${removed.key} must be rejected`).not.toBeNull();
      expect(rejection?.body.removed).toBe(`options.${removed.key}`);
    }
  });

  it("lets a clean options object through untouched", () => {
    expect(findRemovedRunOption({ mode: "extend", publish: false })).toBeNull();
    expect(findRemovedRunOption({})).toBeNull();
    expect(findRemovedRunOption(undefined)).toBeNull();
  });

  it("does not mistake an array or a string for an options object", () => {
    expect(findRemovedRunOption(["demo"])).toBeNull();
    expect(findRemovedRunOption("demo")).toBeNull();
  });
});

describe("deliverRun — a simulated run never writes into a real repo", () => {
  let repo: string;

  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "fd-demo-delivery-"));
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "package.json"), '{\n  "name": "owner-real-app"\n}\n');
    writeFileSync(join(repo, "src", "index.js"), "export const real = 1;\n");
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "test"]);
    git(["add", "-A"]);
    git(["commit", "-qm", "owner's real work"]);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  const destination = (): RunDestination => ({
    kind: "existing-repo",
    target: repo,
    branch: "factory-deck/deadbeef",
    status: "planned",
    detail: null,
    url: null,
    deliveredAt: null,
  });

  it("REFUSES to deliver a demo run, and says so instead of claiming success", async () => {
    const result = await deliverRun({
      destination: destination(),
      workspacePath: repo,
      filePaths: ["package.json"],
      runId: randomUUID(),
      appName: "Mock App",
      options: { demo: true },
      verification: {
        qaPassed: false,
        testStatus: "unknown",
        writeRefusals: 0,
        incompleteCommands: 1,
        fileDigests: {},
      },
    });

    // Not "delivered" — the exact lie the old code told.
    expect(result.status).toBe("skipped");
    expect(result.status).not.toBe("delivered");
    expect(result.detail).toMatch(/simulated/i);
    expect(result.detail).not.toMatch(/pushed/i);
  });

  it("leaves the owner's real files and branches untouched after a demo run", async () => {
    const before = readFileSync(join(repo, "package.json"), "utf8");

    await deliverRun({
      destination: destination(),
      workspacePath: repo,
      filePaths: ["package.json"],
      runId: randomUUID(),
      appName: "Mock App",
      options: { demo: true },
      verification: {
        qaPassed: false,
        testStatus: "unknown",
        writeRefusals: 0,
        incompleteCommands: 1,
        fileDigests: {},
      },
    });

    // The measured defect overwrote package.json with the canned stub app
    // ("deckapp") and created a factory-deck/* branch. Neither may happen.
    expect(readFileSync(join(repo, "package.json"), "utf8")).toBe(before);
    expect(before).toContain("owner-real-app");
    expect(git(["branch", "--list"])).not.toMatch(/factory-deck/);
    expect(git(["log", "--oneline"]).trim().split("\n")).toHaveLength(1);
  });
});

describe("deliverRun — workspace-only output is a verified local artifact", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "fd-local-artifact-"));
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(
      join(workspace, "package.json"),
      '{"scripts":{"test":"node test.js"}}\n',
    );
    writeFileSync(join(workspace, "src", "index.js"), "export const ready = true;\n");
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("commits the exact receipt-bound bytes without requiring a remote", async () => {
    const runId = randomUUID();
    const paths = ["package.json", "src/index.js"];
    const fileDigests = await captureFileDigests(workspace, paths);
    const result = await deliverRun({
      destination: {
        kind: "workspace-only",
        target: "(no repo attached)",
        branch: null,
        status: "planned",
        detail: null,
        url: null,
        deliveredAt: null,
      },
      workspacePath: workspace,
      filePaths: paths,
      runId,
      appName: "Verified local app",
      options: {},
      verification: {
        qaPassed: true,
        testStatus: "passing",
        writeRefusals: 0,
        incompleteCommands: 0,
        fileDigests,
      },
    });

    expect(result.status).toBe("delivered");
    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.detail).toMatch(/receipt-bound local git artifact/i);
    expect(existsSync(join(workspace, ".git"))).toBe(true);
    expect(
      verifyCommitFileDigests(workspace, result.commitSha!, paths, fileDigests).ok,
    ).toBe(true);
    expect(
      execFileSync("git", ["show", "HEAD:src/index.js"], {
        cwd: workspace,
        encoding: "utf8",
      }),
    ).toBe("export const ready = true;\n");
    expect(
      execFileSync("git", ["log", "-1", "--format=%B%n%an <%ae>"], {
        cwd: workspace,
        encoding: "utf8",
      }),
    ).toContain(`Factory-Deck-Run: ${runId}`);
    expect(
      execFileSync("git", ["log", "-1", "--format=%an <%ae>"], {
        cwd: workspace,
        encoding: "utf8",
      }).trim(),
    ).toBe("Factory Deck <factory-deck@local.invalid>");
  });
});
