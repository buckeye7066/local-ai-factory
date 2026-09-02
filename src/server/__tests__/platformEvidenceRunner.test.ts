import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  capturePlatformArtifactSnapshot,
  changedPlatformArtifactPaths,
  remainingPlatformEvidenceBlockers,
  successfulPlatformCommandEvidence,
} from "../workspace/platformEvidenceRunner.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("platformEvidenceRunner", () => {
  it("detects every artifact-visible mutation while excluding node_modules", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-platform-proof-"));
    roots.push(root);
    await mkdir(join(root, "node_modules", "dependency"), { recursive: true });
    await writeFile(join(root, "package.json"), '{"name":"candidate"}\n');
    await writeFile(join(root, "node_modules", "dependency", "index.js"), "old\n");
    const before = await capturePlatformArtifactSnapshot(root);

    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "dist", "cli.js"), "generated\n");
    await writeFile(join(root, "tasks.json"), "[]\n");
    await writeFile(join(root, "node_modules", "dependency", "index.js"), "new\n");
    const after = await capturePlatformArtifactSnapshot(root);

    expect(changedPlatformArtifactPaths(before, after)).toEqual([
      "dist/cli.js",
      "tasks.json",
    ]);
  });

  it("requires structured passing non-skipped evidence for direct tests", () => {
    const command = {
      bin: "npx",
      args: [
        "--no-install",
        "vitest",
        "run",
        "tests/workflow.test.ts",
        "--reporter=json",
        "--root=.",
      ],
      isTest: true,
      directTestPath: "tests/workflow.test.ts",
      runner: "vitest" as const,
    };
    const result = {
      command:
        "npx --no-install vitest run tests/workflow.test.ts --reporter=json --root=.",
      allowed: true,
      executed: true,
      exitCode: 0,
      stdout: JSON.stringify({
        numPassedTests: 1,
        numPendingTests: 0,
        testResults: [
          { assertionResults: [{ status: "passed", title: "completes workflow" }] },
        ],
      }),
      stderr: "",
    };
    expect(successfulPlatformCommandEvidence(command, result, "win32")).toMatchObject({
      directEvidenceValid: true,
      passedCount: 1,
      skippedCount: 0,
      passedTestNames: ["completes workflow"],
      hostPlatform: "win32",
    });

    expect(() =>
      successfulPlatformCommandEvidence(
        command,
        {
          ...result,
          stdout: JSON.stringify({
            numPassedTests: 0,
            numPendingTests: 1,
            testResults: [
              {
                assertionResults: [{ status: "pending", title: "completes workflow" }],
              },
            ],
          }),
        },
        "win32",
      ),
    ).toThrow(/direct vitest evidence is invalid/i);
  });

  it("enables ordinary resume only after every held platform target is verified", () => {
    const target = (verified: boolean) => ({
      applicable: true,
      verified,
      evidence: verified ? ["test"] : [],
    });
    const compatibility = {
      windows: target(true),
      webkit: target(true),
      macos: target(false),
      ios: target(true),
      android: target(true),
    };
    expect(
      remainingPlatformEvidenceBlockers(
        [
          "windows compatibility is applicable but lacks executed evidence.",
          "macos compatibility is applicable but lacks executed evidence.",
        ],
        compatibility,
      ),
    ).toEqual(["macos compatibility is applicable but lacks executed evidence."]);
  });
});
