import { readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { FactoryCheckpoint } from "../orchestrator/checkpoint.js";
import { platformEvidenceBlockersFromRunError } from "../orchestrator/platformEvidenceHold.js";
import {
  getRunCheckpoint,
  getRunForExecution,
  saveRunCheckpoint,
} from "../storage/runsStore.js";
import { runCommand } from "./commandRunner.js";
import { platformStampForExecutedCommand } from "./completionEvidence.js";
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

export const PLATFORM_VITEST_CONFIG =
  ".factory-deck-platform-vitest.config.mjs";
const PLATFORM_VITEST_CONFIG_SOURCE =
  "// Engine-owned isolation: do not inherit Factory Deck's ancestor config.\nexport default {};\n";
const LOCAL_VITEST_CONFIG =
  /^(?:vitest|vite)\.config\.(?:js|cjs|mjs|ts|cts|mts)$/i;

async function hasLocalVitestConfig(workspacePath: string): Promise<boolean> {
  const entries = await readdir(workspacePath, { withFileTypes: true });
  return entries.some(
    (entry) => entry.isFile() && LOCAL_VITEST_CONFIG.test(entry.name),
  );
}

export function commandForPlatformProof(
  command: VerificationCommand,
  isolatedVitest: boolean,
): VerificationCommand {
  if (!isolatedVitest || command.runner !== "vitest") return command;
  return {
    ...command,
    args: [...command.args, `--config=${PLATFORM_VITEST_CONFIG}`],
  };
}

export function replaceHostPlatformEvidence<
  T extends CheckpointExecutedCommand,
>(
  existing: readonly T[],
  hostPlatform: PlatformProofHost,
  current: readonly T[],
): T[] {
  if (current.some((entry) => entry.hostPlatform !== hostPlatform)) {
    throw new Error(
      `Refused: imported evidence was not executed on ${hostPlatform}.`,
    );
  }
  return [
    ...existing.filter((entry) => entry.hostPlatform !== hostPlatform),
    ...current,
  ];
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
    throw new Error(
      "The held Factory run or its private checkpoint is missing.",
    );
  }
  const blockers = platformEvidenceBlockersFromRunError(run.error);
  if (run.status !== "failed" || run.resumable !== true || !blockers) {
    throw new Error(
      "Refused: the Factory run is not a resumable platform-evidence-only hold.",
    );
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
  const held = await validatePlatformEvidenceHold(input);
  const expected = held.checkpoint.verification!.fileDigests!;
  const paths = Object.keys(expected);
  const before = await verifyFileDigests(held.workspacePath, paths, expected);
  if (!before.ok) {
    throw new Error(
      `Candidate bytes changed before ${hostPlatform} verification: ${before.reason ?? "unknown mismatch"}.`,
    );
  }

  const plan = verificationPlanForWorkspace(held.workspacePath, {
    generatedTests: generatedTestsForVerification(held.checkpoint.files),
  });
  if (plan.incomplete.length > 0 || plan.commands.length === 0) {
    throw new Error(
      `Cross-platform verification plan is incomplete: ${
        plan.incomplete
          .map((item) => `${item.command}: ${item.reason}`)
          .join("; ") || "no executable commands"
      }.`,
    );
  }

  const isolatedVitest =
    plan.commands.some((command) => command.runner === "vitest") &&
    !(await hasLocalVitestConfig(held.workspacePath));
  const platformVitestConfig = join(held.workspacePath, PLATFORM_VITEST_CONFIG);
  if (isolatedVitest) {
    await writeFile(platformVitestConfig, PLATFORM_VITEST_CONFIG_SOURCE, {
      encoding: "utf8",
      flag: "wx",
    });
  }

  const executed: CheckpointExecutedCommand[] = [];
  try {
    for (const plannedCommand of plan.commands) {
      const command = commandForPlatformProof(plannedCommand, isolatedVitest);
      const result = await runCommand(
        { bin: command.bin, args: command.args, cwd: held.workspacePath },
        {
          workspaceRoot: resolve(
            input.workspaceRoot ??
              process.env.WORKSPACE_ROOT ??
              join(process.cwd(), "workspaces"),
          ),
          allowScriptExecution: true,
          timeoutMs: command.isTest ? 45 * 60_000 : 15 * 60_000,
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
      executed.push({
        command: result.command,
        exitCode: result.exitCode,
        isTest: command.isTest,
        isBrowser: command.isBrowser ?? false,
        ...platformStampForExecutedCommand(
          {
            command: result.command,
            exitCode: result.exitCode,
            isTest: command.isTest,
            isBrowser: command.isBrowser ?? false,
            outputTail,
          },
          hostPlatform,
        ),
        outputTail,
      });
    }
  } finally {
    if (isolatedVitest) {
      await rm(platformVitestConfig, { force: true });
    }
  }
  if (!executed.some((entry) => entry.isTest === true)) {
    throw new Error(`${hostPlatform} proof executed no test command.`);
  }

  const after = await verifyFileDigests(held.workspacePath, paths, expected);
  if (!after.ok) {
    throw new Error(
      `Candidate bytes changed during ${hostPlatform} verification: ${after.reason ?? "unknown mismatch"}.`,
    );
  }

  const checkpoint: FactoryCheckpoint = {
    ...held.checkpoint,
    verification: {
      ...held.checkpoint.verification!,
      executed: replaceHostPlatformEvidence(
        held.checkpoint.verification!.executed,
        hostPlatform,
        executed,
      ),
    },
    updatedAt: Date.now(),
  };
  await saveRunCheckpoint(checkpoint);
  return {
    runId: held.runId,
    workspacePath: held.workspacePath,
    hostPlatform,
    commands: executed.map((entry) => entry.command),
  };
}
