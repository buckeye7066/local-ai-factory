import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { FactoryCheckpoint } from "../orchestrator/checkpoint.js";
import { parseDirectTestEvidence } from "../orchestrator/directTestEvidence.js";
import { platformEvidenceBlockersFromRunError } from "../orchestrator/platformEvidenceHold.js";
import {
  getRunCheckpoint,
  getRunForExecution,
  saveRun,
  saveRunCheckpoint,
} from "../storage/runsStore.js";
import { runCommand, type CommandResult } from "./commandRunner.js";
import {
  assessPlatformCompatibility,
  platformStampForExecutedCommand,
} from "./completionEvidence.js";
import {
  generatedTestsForVerification,
  verificationPlanForWorkspace,
  type VerificationCommand,
} from "./verificationCommands.js";
import { verifyFileDigests } from "./verificationReceipt.js";

const RUN_FILE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i;

export type PlatformProofHost = "win32" | "darwin";

export type PlatformEvidenceHold = {
  runId: string;
  checkpoint: FactoryCheckpoint;
  workspacePath: string;
  blockers: string[];
};

type CheckpointExecutedCommand = NonNullable<
  FactoryCheckpoint["verification"]
>["executed"][number];

export type PlatformArtifactSnapshot = Record<string, string>;

/** Runtime-only outputs excluded from the preserved cloud artifact as well. */
const ARTIFACT_EXCLUDED_DIRS = new Set([
  "node_modules",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".hypothesis",
  ".tox",
  ".nox",
  ".nyc_output",
  "coverage",
  "playwright-report",
  "test-results",
]);
const ARTIFACT_EXCLUDED_FILES = [/^\.coverage(?:\..+)?$/, /^.+\.(?:pyc|pyo)$/];

function isExcludedArtifactEntry(path: string, name: string): boolean {
  return (
    path.split("/").some((part) => ARTIFACT_EXCLUDED_DIRS.has(part)) ||
    ARTIFACT_EXCLUDED_FILES.some((pattern) => pattern.test(name))
  );
}

export function platformArtifactFileFingerprint(
  contents: Buffer,
  mode: number,
): string {
  const digest = createHash("sha256").update(contents).digest("hex");
  return `file:${(mode & 0o777).toString(8)}:${digest}`;
}

export async function capturePlatformArtifactSnapshot(
  workspacePath: string,
): Promise<PlatformArtifactSnapshot> {
  const snapshot: PlatformArtifactSnapshot = {};
  const pending = [workspacePath];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (entry.isDirectory() && ARTIFACT_EXCLUDED_DIRS.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      const path = relative(workspacePath, absolute).replace(/\\/g, "/");
      if (isExcludedArtifactEntry(path, entry.name)) continue;
      if (entry.isDirectory()) {
        pending.push(absolute);
      } else if (entry.isSymbolicLink()) {
        snapshot[path] = createHash("sha256")
          .update(`symlink\0${await readlink(absolute)}`)
          .digest("hex");
      } else if (entry.isFile()) {
        const mode = (await lstat(absolute)).mode;
        snapshot[path] = platformArtifactFileFingerprint(
          await readFile(absolute),
          mode,
        );
      }
    }
  }
  return snapshot;
}

export function changedPlatformArtifactPaths(
  before: PlatformArtifactSnapshot,
  after: PlatformArtifactSnapshot,
): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((path) => before[path] !== after[path])
    .sort();
}

export function successfulPlatformCommandEvidence(
  command: VerificationCommand,
  result: CommandResult,
  hostPlatform: PlatformProofHost,
): CheckpointExecutedCommand {
  if (!result.executed || result.exitCode !== 0) {
    throw new Error(
      "Only a successfully executed command can become platform evidence.",
    );
  }
  const outputTail = `${result.stdout}\n${result.stderr}`.slice(-32_768);
  const parsedDirect =
    command.directTestPath && command.runner
      ? (() => {
          if (result.stdoutTruncated || result.stderrTruncated) {
            throw new Error(
              `${hostPlatform} direct ${command.runner} evidence exceeded the structured-output capture limit.`,
            );
          }
          return parseDirectTestEvidence(command.runner, result.stdout, result.stderr);
        })()
      : undefined;
  const directEvidenceValid = parsedDirect?.valid;
  if (parsedDirect && !parsedDirect.valid) {
    throw new Error(
      `${hostPlatform} direct ${command.runner} evidence is invalid: ${
        parsedDirect.reason ?? "no passing non-skipped test was identified"
      }.`,
    );
  }
  return {
    command: result.command,
    exitCode: result.exitCode,
    isTest: command.isTest,
    directTestPath: command.directTestPath,
    isBrowser: command.isBrowser ?? false,
    ...platformStampForExecutedCommand(
      {
        command: result.command,
        exitCode: result.exitCode,
        isTest: command.isTest,
        isBrowser: command.isBrowser ?? false,
        directEvidenceValid,
        outputTail,
      },
      hostPlatform,
    ),
    runner: command.runner,
    directEvidenceValid,
    passedCount: parsedDirect?.passedCount,
    skippedCount: parsedDirect?.skippedCount,
    passedTestNames: parsedDirect?.passedTestNames,
    outputTail,
  };
}

export function remainingPlatformEvidenceBlockers(
  blockers: readonly string[],
  compatibility: ReturnType<typeof assessPlatformCompatibility>,
): string[] {
  return blockers.filter((blocker) => {
    const target = /^(windows|webkit|macos|ios|android) compatibility\b/.exec(
      blocker,
    )?.[1] as keyof typeof compatibility | undefined;
    return !target || compatibility[target].verified !== true;
  });
}

export function replaceHostPlatformEvidence<T extends CheckpointExecutedCommand>(
  existing: readonly T[],
  hostPlatform: PlatformProofHost,
  current: readonly T[],
): T[] {
  if (current.some((entry) => entry.hostPlatform !== hostPlatform)) {
    throw new Error(`Refused: imported evidence was not executed on ${hostPlatform}.`);
  }
  return [
    ...existing.filter((entry) => entry.hostPlatform !== hostPlatform),
    ...current,
  ];
}

export function missingDirectPlatformEvidencePaths(
  requiredPaths: readonly string[],
  evidence: readonly Pick<
    CheckpointExecutedCommand,
    "directTestPath" | "directEvidenceValid" | "hostPlatform"
  >[],
  hostPlatform: PlatformProofHost,
): string[] {
  return [...new Set(requiredPaths)].filter(
    (path) =>
      !evidence.some(
        (entry) =>
          entry.hostPlatform === hostPlatform &&
          entry.directTestPath === path &&
          entry.directEvidenceValid === true,
      ),
  );
}

export async function discoverSingleCheckpointRunId(
  dataRoot = resolve(process.cwd(), process.env.FACTORY_DATA_DIR || ".factory"),
): Promise<string> {
  const checkpointRoot = join(dataRoot, "checkpoints");
  const names = (await readdir(checkpointRoot))
    .filter((name) => RUN_FILE.test(name))
    .sort();
  if (names.length !== 1) {
    throw new Error(
      `Expected exactly one resumable Factory checkpoint, found ${names.length}.`,
    );
  }
  return names[0]!.slice(0, -".json".length);
}

async function locateExactWorkspace(
  workspaceRoot: string,
  checkpoint: FactoryCheckpoint,
): Promise<string> {
  const expected = checkpoint.verification?.fileDigests;
  const paths = Object.keys(expected ?? {});
  if (!expected || paths.length === 0) {
    throw new Error("Held run has no exact candidate digest receipt.");
  }

  const matches: string[] = [];
  const entries = await readdir(workspaceRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const candidate = join(workspaceRoot, entry.name);
    const receipt = await verifyFileDigests(candidate, paths, expected);
    if (receipt.ok) matches.push(candidate);
  }
  if (matches.length !== 1) {
    throw new Error(
      `Expected one workspace matching the held candidate bytes, found ${matches.length}.`,
    );
  }
  return matches[0]!;
}

export async function validatePlatformEvidenceHold(
  input: {
    runId?: string;
    workspaceRoot?: string;
  } = {},
): Promise<PlatformEvidenceHold> {
  const runId = input.runId ?? (await discoverSingleCheckpointRunId());
  const [run, checkpoint] = await Promise.all([
    getRunForExecution(runId),
    getRunCheckpoint(runId),
  ]);
  if (!run || !checkpoint) {
    throw new Error("The held Factory run or its private checkpoint is missing.");
  }
  const blockers = platformEvidenceBlockersFromRunError(run.error);
  if (run.status !== "failed" || !blockers) {
    throw new Error("Refused: the Factory run is not a platform-evidence-only hold.");
  }
  if (!checkpoint.testWriterComplete || !checkpoint.verification) {
    throw new Error(
      "Refused: the held Factory candidate has not completed executable verification.",
    );
  }
  const workspaceRoot = resolve(
    input.workspaceRoot ??
      process.env.WORKSPACE_ROOT ??
      join(process.cwd(), "workspaces"),
  );
  const workspacePath = await locateExactWorkspace(workspaceRoot, checkpoint);
  return { runId, checkpoint, workspacePath, blockers };
}

export async function recordCurrentPlatformEvidence(
  input: {
    runId?: string;
    workspaceRoot?: string;
    hostPlatform?: NodeJS.Platform;
    /** Explicit approval to execute model-authored install/build/test code. */
    allowScriptExecution?: boolean;
  } = {},
): Promise<{
  runId: string;
  workspacePath: string;
  hostPlatform: PlatformProofHost;
  commands: string[];
}> {
  const hostPlatform = input.hostPlatform ?? process.platform;
  if (hostPlatform !== "win32" && hostPlatform !== "darwin") {
    throw new Error(
      `Platform proof must execute on a real Windows or macOS runner, not ${hostPlatform}.`,
    );
  }
  if (input.allowScriptExecution !== true) {
    throw new Error(
      "Platform proof refused: ALLOW_UNTRUSTED_SCRIPTS is not explicitly enabled.",
    );
  }
  const held = await validatePlatformEvidenceHold(input);
  const expected = held.checkpoint.verification!.fileDigests!;
  const paths = Object.keys(expected);
  const before = await verifyFileDigests(held.workspacePath, paths, expected);
  if (!before.ok) {
    throw new Error(
      `Candidate bytes changed before ${hostPlatform} verification: ${before.reason ?? "unknown mismatch"}.`,
    );
  }
  const artifactBefore = await capturePlatformArtifactSnapshot(held.workspacePath);

  const generatedTests = generatedTestsForVerification(held.checkpoint.files);
  const plan = verificationPlanForWorkspace(held.workspacePath, { generatedTests });
  if (plan.incomplete.length > 0 || plan.commands.length === 0) {
    throw new Error(
      `Cross-platform verification plan is incomplete: ${
        plan.incomplete.map((item) => `${item.command}: ${item.reason}`).join("; ") ||
        "no executable commands"
      }.`,
    );
  }

  const executed: CheckpointExecutedCommand[] = [];
  for (const command of plan.commands) {
    const result = await runCommand(
      { bin: command.bin, args: command.args, cwd: held.workspacePath },
      {
        workspaceRoot: resolve(
          input.workspaceRoot ??
            process.env.WORKSPACE_ROOT ??
            join(process.cwd(), "workspaces"),
        ),
        allowScriptExecution: input.allowScriptExecution,
        timeoutMs: command.isTest ? 45 * 60_000 : 15 * 60_000,
        ...(command.directTestPath ? { maxCapturedOutputBytes: 32 * 1024 * 1024 } : {}),
      },
    );
    const outputTail = `${result.stdout}\n${result.stderr}`.slice(-32_768);
    if (!result.executed || result.exitCode !== 0) {
      throw new Error(
        `${hostPlatform} verification failed for \`${result.command}\`: ${
          result.reason ?? `exit ${String(result.exitCode)}`
        }. ${outputTail.slice(-2_000)}`,
      );
    }
    executed.push(successfulPlatformCommandEvidence(command, result, hostPlatform));
  }
  if (!executed.some((entry) => entry.directEvidenceValid === true)) {
    throw new Error(
      `${hostPlatform} proof produced no structured, passing, non-skipped direct-test evidence.`,
    );
  }
  const missingDirectEvidence = missingDirectPlatformEvidencePaths(
    generatedTests.map((test) => test.path),
    executed,
    hostPlatform,
  );
  if (missingDirectEvidence.length > 0) {
    throw new Error(
      `${hostPlatform} proof did not produce current structured evidence for every generated test: ${missingDirectEvidence.join(
        ", ",
      )}.`,
    );
  }

  const after = await verifyFileDigests(held.workspacePath, paths, expected);
  if (!after.ok) {
    throw new Error(
      `Candidate bytes changed during ${hostPlatform} verification: ${after.reason ?? "unknown mismatch"}.`,
    );
  }

  const artifactAfter = await capturePlatformArtifactSnapshot(held.workspacePath);
  const artifactChanges = changedPlatformArtifactPaths(artifactBefore, artifactAfter);
  if (artifactChanges.length > 0) {
    throw new Error(
      `Candidate artifact changed during ${hostPlatform} verification outside node_modules: ${artifactChanges
        .slice(0, 20)
        .join(", ")}.`,
    );
  }

  const combinedEvidence = replaceHostPlatformEvidence(
    held.checkpoint.verification!.executed,
    hostPlatform,
    executed,
  );
  const checkpoint: FactoryCheckpoint = {
    ...held.checkpoint,
    verification: {
      ...held.checkpoint.verification!,
      executed: combinedEvidence,
    },
    updatedAt: Date.now(),
  };
  const run = await getRunForExecution(held.runId);
  if (!run) throw new Error("The held Factory run disappeared before evidence save.");
  const compatibility = assessPlatformCompatibility(
    held.workspacePath,
    combinedEvidence,
    hostPlatform,
  );
  run.resumable =
    remainingPlatformEvidenceBlockers(held.blockers, compatibility).length === 0;
  await saveRunCheckpoint(checkpoint);
  await saveRun(run);
  return {
    runId: held.runId,
    workspacePath: held.workspacePath,
    hostPlatform,
    commands: executed.map((entry) => entry.command),
  };
}
