import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { RunAttribution, RunRecord } from "../../shared/schemas.js";
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
  },
): RunAttribution {
  const worktree = run.workspacePath;
  return {
    jobId: run.id,
    worktreePath: worktree,
    approval: {
      allowUntrustedScripts: opts.allowUntrustedScripts,
    },
    testResult: opts.testResult,
    commitPath: attributionPathFor(run.id),
    rollbackPath: worktree,
    auditSeq: opts.auditSeq,
  };
}

export async function writeAttribution(attr: RunAttribution): Promise<string> {
  await mkdir(ATTR_DIR, { recursive: true });
  const target = attributionPathFor(attr.jobId);
  await writeFileContained(target, JSON.stringify(attr, null, 2));
  return target;
}
