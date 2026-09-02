import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendCheckpointCommandOutput,
  boundCheckpointCommandOutput,
  MAX_CHECKPOINT_COMMAND_OUTPUT_CHARS,
} from "../orchestrator/checkpoint.js";
import {
  addedPlatformArtifactPaths,
  capturePlatformArtifactSnapshot,
  checkpointOutputTail,
  changedPlatformArtifactPaths,
  changedPreExistingPlatformArtifactPaths,
  createDisposableVerificationWorkspace,
  MAX_CHECKPOINT_OUTPUT_TAIL_CHARS,
  missingDirectPlatformEvidencePaths,
  platformArtifactFileFingerprint,
  removeAddedPlatformArtifacts,
  removeDisposableVerificationWorkspace,
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
  it("detects artifact bytes and modes while excluding runtime byproducts", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-platform-proof-"));
    roots.push(root);
    await mkdir(join(root, "node_modules", "dependency"), { recursive: true });
    await writeFile(join(root, "package.json"), '{"name":"candidate"}\n');
    await writeFile(join(root, "launcher"), "#!/bin/sh\n");
    await chmod(join(root, "launcher"), 0o644);
    await writeFile(join(root, "node_modules", "dependency", "index.js"), "old\n");
    const before = await capturePlatformArtifactSnapshot(root);

    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "dist", "cli.js"), "generated\n");
    await writeFile(join(root, "tasks.json"), "[]\n");
    await mkdir(join(root, "src", "__pycache__"), { recursive: true });
    await writeFile(join(root, "src", "__pycache__", "main.cpython.pyc"), "cache");
    await mkdir(join(root, ".pytest_cache"), { recursive: true });
    await writeFile(join(root, ".coverage"), "runtime coverage");
    await chmod(join(root, "launcher"), 0o755);
    await writeFile(join(root, "node_modules", "dependency", "index.js"), "new\n");
    const after = await capturePlatformArtifactSnapshot(root);

    expect(changedPlatformArtifactPaths(before, after)).toEqual([
      "dist/cli.js",
      ...(process.platform === "win32" ? [] : ["launcher"]),
      "tasks.json",
    ]);
    expect(platformArtifactFileFingerprint(Buffer.from("same"), 0o644)).not.toBe(
      platformArtifactFileFingerprint(Buffer.from("same"), 0o755),
    );
    expect(platformArtifactFileFingerprint(Buffer.from("same"), 0o644)).toBe(
      platformArtifactFileFingerprint(Buffer.from("same"), 0o600),
    );
  });

  it("seals empty directories while matching tar's zero-prefix Python excludes", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-platform-directories-"));
    roots.push(root);
    await mkdir(join(root, "empty-deliverable"));
    await mkdir(join(root, ".hypothesis"));
    await writeFile(join(root, ".pyc"), "cache");
    await writeFile(join(root, ".pyo"), "cache");
    await writeFile(join(root, ".coverage."), "cache");
    const before = await capturePlatformArtifactSnapshot(root);

    expect(before["empty-deliverable"]).toBe("directory");
    expect(before[".hypothesis"]).toBeUndefined();
    expect(before[".pyc"]).toBeUndefined();
    expect(before[".pyo"]).toBeUndefined();
    expect(before[".coverage."]).toBeUndefined();

    await rm(join(root, "empty-deliverable"), { recursive: true });
    await mkdir(join(root, "command-created-empty"));
    const after = await capturePlatformArtifactSnapshot(root);
    expect(changedPlatformArtifactPaths(before, after)).toEqual([
      "command-created-empty",
      "empty-deliverable",
    ]);

    await removeAddedPlatformArtifacts(root, before, after);
    expect(
      changedPlatformArtifactPaths(before, await capturePlatformArtifactSnapshot(root)),
    ).toEqual(["empty-deliverable"]);
  });

  it("binds every generic report-named path into the exact artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-platform-coverage-"));
    roots.push(root);
    await mkdir(join(root, "src", "coverage"), { recursive: true });
    await writeFile(join(root, "src", "coverage", "policy.ts"), "export {}\n");
    await mkdir(join(root, "build", "coverage"), { recursive: true });
    await writeFile(join(root, "build", "coverage", "coverage-final.json"), "{}\n");
    await writeFile(join(root, "build", "coverage", "lcov.info"), "old\n");
    await writeFile(
      join(root, "build", "coverage", "dashboard.ts"),
      "export const dashboard=true\n",
    );

    const before = await capturePlatformArtifactSnapshot(root);
    expect(before).toHaveProperty("src/coverage/policy.ts");
    expect(before).toHaveProperty("build/coverage/dashboard.ts");
    expect(before).toHaveProperty("build/coverage/coverage-final.json");
    expect(before).toHaveProperty("build/coverage/lcov.info");

    await writeFile(join(root, "src", "coverage", "policy.ts"), "export const x=1\n");
    await writeFile(join(root, "build", "coverage", "lcov.info"), "new\n");
    await writeFile(
      join(root, "build", "coverage", "dashboard.ts"),
      "export const dashboard=false\n",
    );
    const after = await capturePlatformArtifactSnapshot(root);

    expect(changedPlatformArtifactPaths(before, after)).toEqual([
      "build/coverage/dashboard.ts",
      "build/coverage/lcov.info",
      "src/coverage/policy.ts",
    ]);
  });

  it("removes only outputs created by verification and preserves mutation evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-platform-cleanup-"));
    roots.push(root);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "app.ts"), "export const value=1\n");
    const before = await capturePlatformArtifactSnapshot(root);

    await writeFile(join(root, "src", "app.ts"), "export const value=2\n");
    await mkdir(join(root, "coverage"), { recursive: true });
    await writeFile(join(root, "coverage", "coverage-final.json"), "{}\n");
    const afterCommands = await capturePlatformArtifactSnapshot(root);

    expect(addedPlatformArtifactPaths(before, afterCommands)).toEqual([
      "coverage/coverage-final.json",
      "coverage",
    ]);
    await removeAddedPlatformArtifacts(root, before, afterCommands);
    const cleaned = await capturePlatformArtifactSnapshot(root);
    expect(changedPlatformArtifactPaths(before, cleaned)).toEqual(["src/app.ts"]);
  });

  it("runs cleanup in a disposable copy instead of deleting concurrent owner files", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-platform-owner-"));
    roots.push(root);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "app.ts"), "export const value=1\n");
    await mkdir(join(root, "node_modules", "dependency"), { recursive: true });
    await writeFile(join(root, "node_modules", "dependency", "index.js"), "cache\n");
    const sealed = await capturePlatformArtifactSnapshot(root);

    const disposable = await createDisposableVerificationWorkspace(root);
    roots.push(disposable.root);
    expect(await capturePlatformArtifactSnapshot(disposable.workspacePath)).toEqual(
      sealed,
    );
    await writeFile(join(root, "owner-note.txt"), "created during verification\n");
    await writeFile(join(disposable.workspacePath, "runtime-output.json"), "{}\n");
    await writeFile(
      join(disposable.workspacePath, "src", "app.ts"),
      "export const value=2\n",
    );
    const executed = await capturePlatformArtifactSnapshot(disposable.workspacePath);
    await removeAddedPlatformArtifacts(disposable.workspacePath, sealed, executed);
    const cleaned = await capturePlatformArtifactSnapshot(disposable.workspacePath);

    expect(changedPlatformArtifactPaths(sealed, cleaned)).toEqual(["src/app.ts"]);
    const ownerAfter = await capturePlatformArtifactSnapshot(root);
    expect(changedPreExistingPlatformArtifactPaths(sealed, ownerAfter)).toEqual([]);
    expect(await readFile(join(root, "owner-note.txt"), "utf8")).toBe(
      "created during verification\n",
    );
    await removeDisposableVerificationWorkspace(disposable);
  });

  it("grants the macOS proof group access without changing executable intent", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "factory-platform-group-source-"));
    roots.push(root);
    await writeFile(join(root, "regular"), "regular\n", { mode: 0o600 });
    await writeFile(join(root, "executable"), "#!/bin/sh\n", { mode: 0o700 });

    const disposable = await createDisposableVerificationWorkspace(root, tmpdir(), {
      groupWritable: true,
    });
    roots.push(disposable.root);

    expect((await stat(disposable.root)).mode & 0o070).toBe(0o070);
    expect((await stat(join(disposable.workspacePath, "regular"))).mode & 0o070).toBe(
      0o060,
    );
    expect(
      (await stat(join(disposable.workspacePath, "executable"))).mode & 0o070,
    ).toBe(0o070);
    expect(await capturePlatformArtifactSnapshot(disposable.workspacePath)).toEqual(
      await capturePlatformArtifactSnapshot(root),
    );
  });

  it("keeps POSIX mode intent in the seal while comparing portable Windows bytes", () => {
    const digest = "a".repeat(64);
    const changedDigest = "b".repeat(64);
    const sealed = { launcher: `file:executable:${digest}` };
    const windowsRestore = { launcher: `file:regular:${digest}` };

    expect(changedPlatformArtifactPaths(sealed, windowsRestore)).toEqual(["launcher"]);
    expect(
      changedPlatformArtifactPaths(sealed, windowsRestore, {
        compareExecutableIntent: false,
      }),
    ).toEqual([]);
    expect(
      changedPlatformArtifactPaths(
        sealed,
        { launcher: `file:regular:${changedDigest}` },
        { compareExecutableIntent: false },
      ),
    ).toEqual(["launcher"]);
  });

  it("bounds durable command output independently of reporter capture size", () => {
    const tail = checkpointOutputTail("prefix" + "x".repeat(40_000), "stderr-end");
    expect(tail).toHaveLength(MAX_CHECKPOINT_OUTPUT_TAIL_CHARS);
    expect(tail).toMatch(/stderr-end$/);
  });

  it("keeps full reporter buffers out of checkpoints and model context", () => {
    let output = "";
    for (let index = 0; index < 40; index += 1) {
      output = appendCheckpointCommandOutput(
        output,
        `npx vitest run generated-${index}.test.ts`,
        `report-${index}:` + "x".repeat(40_000),
        `stderr-${index}`,
      );
    }

    expect(output.length).toBeLessThanOrEqual(MAX_CHECKPOINT_COMMAND_OUTPUT_CHARS);
    expect(output).toContain("generated-39.test.ts");
    expect(output).toContain("stderr-39");
    expect(output).not.toContain("generated-0.test.ts");
    expect(boundCheckpointCommandOutput("z".repeat(100_000))).toHaveLength(
      MAX_CHECKPOINT_COMMAND_OUTPUT_CHARS,
    );
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
        reporterMetadata: "x".repeat(20_000),
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

    expect(() =>
      successfulPlatformCommandEvidence(
        command,
        { ...result, stdoutTruncated: true },
        "win32",
      ),
    ).toThrow(/structured-output capture limit/i);
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

  it("requires same-platform direct evidence for every current generated test", () => {
    const evidence = [
      {
        directTestPath: "tests/covered.test.ts",
        directEvidenceValid: true,
        hostPlatform: "win32" as const,
      },
      {
        directTestPath: "tests/other-host.test.ts",
        directEvidenceValid: true,
        hostPlatform: "darwin" as const,
      },
      {
        directTestPath: "tests/skipped.test.ts",
        directEvidenceValid: false,
        hostPlatform: "win32" as const,
      },
    ];

    expect(
      missingDirectPlatformEvidencePaths(
        [
          "tests/covered.test.ts",
          "tests/other-host.test.ts",
          "tests/skipped.test.ts",
          "tests/missing.test.ts",
          "tests/covered.test.ts",
        ],
        evidence,
        "win32",
      ),
    ).toEqual([
      "tests/other-host.test.ts",
      "tests/skipped.test.ts",
      "tests/missing.test.ts",
    ]);
  });
});
