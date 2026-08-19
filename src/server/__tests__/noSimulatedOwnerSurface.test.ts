import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { findRemovedRunOption, REMOVED_RUN_OPTIONS } from "../removedOptions.js";
import { deliverRun } from "../orchestrator/deliverRun.js";
import type { RunDestination } from "../../shared/schemas.js";

/**
 * Simulated output must never reach an owner surface or an owner's repo.
 *
 * Two measured defects motivate this file:
 *
 *  1. The Sidebar's "Demo Mode" button was still wired after the UI was
 *     supposed to have dropped it, so one click started a mock run.
 *  2. `deliverRun` was NOT demo-gated (release-to-main and deploy were). A
 *     demo run against an attached repo committed 8 files of canned stub
 *     source — OVERWRITING the repo's own package.json and README — onto a
 *     `factory-deck/<id>` branch, and reported status "delivered".
 *
 * These tests exercise the failure mode itself, not just the happy path: each
 * one would pass against the buggy code if it only asserted "no crash", so
 * they assert on the repo's actual contents and on the rejection payload.
 */

describe("removed run options — naming one FAILS, it is never ignored", () => {
  it("rejects options.demo with a 400 that names what was removed", () => {
    const rejection = findRemovedRunOption({ demo: true });
    expect(rejection).not.toBeNull();
    expect(rejection?.status).toBe(400);
    expect(rejection?.body.removed).toBe("options.demo");
    expect(rejection?.body.error).toMatch(/has been removed/i);
  });

  it("rejects the flag by PRESENCE, so demo:false is refused too", () => {
    // A falsy value still names an option Factory Deck does not have.
    // Accepting it silently would tell the caller the option was honoured.
    expect(findRemovedRunOption({ demo: false })?.body.removed).toBe("options.demo");
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
