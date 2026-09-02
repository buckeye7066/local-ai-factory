import { getConfig, getSecrets } from "../server/config.js";
import { resumeFactory } from "../server/orchestrator/runFactory.js";
import { loadReadinessState } from "../server/storage/readinessStore.js";
import { discoverSingleCheckpointRunId } from "../server/workspace/platformEvidenceRunner.js";

async function main(): Promise<void> {
  const runId =
    process.env.FACTORY_RUN_ID?.trim() || (await discoverSingleCheckpointRunId());
  const run = await resumeFactory(runId, getConfig(), getSecrets());
  for (const line of run.logs) console.log(`[${line.kind}] ${line.message}`);

  const readiness = await loadReadinessState(runId);
  if (
    run.status !== "completed" ||
    !run.finalReport ||
    readiness?.status !== "ready" ||
    readiness.receipt?.ready !== true
  ) {
    throw new Error(
      run.error ??
        "Factory resume ended without a ready production receipt and final report.",
    );
  }
  console.log(
    `Factory Deck production proof passed for ${run.finalReport.appName}: ${readiness.evidenceDigest}.`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
