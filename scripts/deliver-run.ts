/**
 * scripts/deliver-run.ts — deliver ONE already-completed run's work to the repo
 * the owner attached, using the EXACT production code path
 * (orchestrator/deliverRun.ts + workspace/gitOps.ts).
 *
 * Why this exists: delivery is normally performed by the orchestrator at the end
 * of a run. A run that COMPLETED before delivery existed — or that was resumed
 * past intake by a server build that predates it — has no destination recorded
 * and therefore never delivered, leaving finished work in a scratch workspace.
 * Re-running such a run would cost hours of model time to reproduce output that
 * already exists on disk, so this delivers what is already there instead.
 *
 * It reads the run's own record and checkpoint for the target repo and the file
 * list; it never invents either. Same safety properties as the in-run path:
 * only the run's own factory-deck/* branch is pushed, never --force, never
 * main/master, and only the paths the run actually wrote are committed.
 *
 *   pnpm tsx scripts/deliver-run.ts <runId>
 */
import { getRunForExecution, getRunCheckpoint, saveRun } from "../src/server/storage/runsStore.js";
import { deliverRun, planDestination } from "../src/server/orchestrator/deliverRun.js";
import { originUrl, currentBranch, git, isGitWorkingTree } from "../src/server/workspace/gitOps.js";

const runId = process.argv[2];
if (!runId) {
  console.error("usage: tsx scripts/deliver-run.ts <runId>");
  process.exit(2);
}

const run = await getRunForExecution(runId);
if (!run) {
  console.error(`No such run: ${runId}`);
  process.exit(1);
}
if (run.status !== "completed") {
  console.error(
    `Refusing: run is "${run.status}", not "completed". Only a finished run's work is delivered.`,
  );
  process.exit(1);
}
if (!run.workspacePath || !isGitWorkingTree(run.workspacePath)) {
  console.error(`Refusing: workspace is missing or is not a git repo: ${run.workspacePath}`);
  process.exit(1);
}

const checkpoint = await getRunCheckpoint(runId);
const options = checkpoint?.options ?? {};

/**
 * Which repo did this run actually ingest?
 *
 * The checkpoint is the first choice, but it is DELETED when a run completes
 * successfully (runFactory calls deleteRunCheckpoint at the end), so for
 * exactly the runs this script exists to serve it is usually already gone.
 * The run's own log is the durable record of what it cloned, and it is
 * authoritative: it was written by the ingest step itself, naming the location
 * it really used. Fall back to that rather than reporting "no repo attached"
 * and stranding the work — which is the failure this script exists to prevent.
 */
function attachedRepoFromLogs(): string | null {
  for (const line of run!.logs) {
    const m =
      /^Ingesting existing repo \((?:git|path)\):\s*(.+?)\s*$/.exec(line.message) ??
      /^Cloning\s+(.+?)\s+->\s/.exec(line.message);
    if (m) return m[1];
  }
  return null;
}

const attached = options.repoSource?.location ?? attachedRepoFromLogs();
if (!options.repoSource?.location && attached) {
  console.log(`Recovered attached repo from the run log: ${attached}`);
}

let remote = await originUrl(run.workspacePath);
if (!remote && attached) {
  const added = await git(["remote", "add", "origin", attached], run.workspacePath, 15_000);
  if (added.code !== 0) {
    console.error(`Could not restore origin -> ${attached}: ${added.stderr}`);
    process.exit(1);
  }
  remote = attached;
  console.log(`Restored origin -> ${attached}`);
}

const branch = await currentBranch(run.workspacePath);
// Re-plan whenever we now know a real target the stored destination does not.
// A previously recorded "workspace-only" is a CONCLUSION reached without the
// repo, not a decision to honour — reusing it would permanently strand the work
// on the strength of an earlier failed lookup.
const stored = run.destination;
const destination =
  stored && !(stored.kind === "workspace-only" && remote)
    ? stored
    : planDestination({ mode: "extend", options, originUrl: remote, branch });

console.log(`Run       : ${run.id} (${run.appName ?? "unnamed"})`);
console.log(`Workspace : ${run.workspacePath}`);
console.log(`Target    : ${destination.target} (${destination.kind}) branch=${branch}`);
console.log(`Files     : ${run.files.length}`);

const result = await deliverRun({
  destination,
  workspacePath: run.workspacePath,
  filePaths: run.files.map((f) => f.path),
  runId: run.id,
  appName: run.appName,
  options,
});

run.destination = result;
run.updatedAt = Date.now();
await saveRun(run);

console.log(`\nRESULT: ${result.status}`);
console.log(`  ${result.detail ?? ""}`);
if (result.url) console.log(`  ${result.url}`);
process.exit(result.status === "delivered" ? 0 : 1);
