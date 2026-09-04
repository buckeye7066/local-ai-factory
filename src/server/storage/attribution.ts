import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { RunAttribution, RunRecord } from "../../shared/schemas.js";
import type { FactoryCheckpoint } from "../orchestrator/checkpoint.js";
import { redactSecrets } from "../security/redact.js";
import { writeFileContained } from "./runsStore.js";

/**
 * attribution.ts — durable per-job attribution so every generated change maps
 * to a job, worktree, approval, test result, commit manifest, and rollback path
 * (acceptance #244).
 */

const DATA_ROOT = resolve(process.cwd(), process.env.FACTORY_DATA_DIR || ".factory");
const ATTR_DIR = join(DATA_ROOT, "attribution");

export function attributionPathFor(runId: string): string {
  return join(ATTR_DIR, `${runId}.json`);
}

export function buildAttribution(
  run: RunRecord,
  opts: {
    allowUntrustedScripts: boolean;
    testResult: RunAttribution["testResult"];
    auditSeq: number | null;
    checkpoint?: FactoryCheckpoint | null;
  },
): RunAttribution {
  const worktree = run.workspacePath;
  const verification = opts.checkpoint?.verification;
  const generatedFiles = Object.entries(verification?.fileDigests ?? {})
    .map(([path, sha256]) => ({ path, sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const commandReceipt = verification
    ? {
        commands: verification.executed.map((entry) => ({
          command: redactSecrets(entry.command).slice(0, 1_024),
          exitCode: entry.exitCode,
          isTest: entry.isTest === true,
        })),
        incomplete: (verification.incomplete ?? []).map((entry) => ({
          command: redactSecrets(entry.command).slice(0, 1_024),
          reason: redactSecrets(entry.reason).slice(0, 2_048),
        })),
      }
    : null;
  const testReceipt = commandReceipt
    ? {
        digest: createHash("sha256")
          .update(JSON.stringify(commandReceipt))
          .digest("hex"),
        ...commandReceipt,
      }
    : null;
  const approval = opts.checkpoint?.preReleaseApproval;
  const destination = run.destination;
  return {
    jobId: run.id,
    worktreePath: worktree,
    approval: {
      allowUntrustedScripts: opts.allowUntrustedScripts,
      evidenceDigest: approval?.evidenceDigest ?? null,
      approved: approval?.approved ?? null,
    },
    testResult: opts.testResult,
    commitPath: attributionPathFor(run.id),
    rollbackPath: worktree,
    generatedFiles,
    verifiedCommitSha: destination?.commitSha ?? null,
    testReceipt,
    rollback:
      worktree || destination?.commitSha || run.release
        ? {
            workspacePath: worktree,
            commitSha: destination?.commitSha ?? null,
            branch: destination?.branch ?? null,
            pullRequestUrl: run.release?.prUrl ?? null,
            mergedSha: run.release?.mergedSha ?? null,
            trunkAdvancePath: destination?.trunkAdvancePath ?? null,
          }
        : null,
    auditSeq: opts.auditSeq,
  };
}

export async function writeAttribution(attr: RunAttribution): Promise<string> {
  await mkdir(ATTR_DIR, { recursive: true });
  const target = attributionPathFor(attr.jobId);
  await writeFileContained(target, JSON.stringify(attr, null, 2));
  return target;
}
