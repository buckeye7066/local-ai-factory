import {
  recordCurrentPlatformEvidence,
  sealPlatformEvidenceHold,
} from "../server/workspace/platformEvidenceRunner.js";
import { getConfig } from "../server/config.js";

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "record";
  const runId = process.env.FACTORY_RUN_ID?.trim() || undefined;
  const workspaceRoot = process.env.WORKSPACE_ROOT?.trim() || undefined;

  if (mode === "validate") {
    const held = await sealPlatformEvidenceHold({ runId, workspaceRoot });
    console.log(
      `Validated platform-evidence hold ${held.runId}: ${held.blockers.join("; ")}`,
    );
    return;
  }
  if (mode !== "record") {
    throw new Error("Usage: factory-platform-proof.ts [validate|record]");
  }

  const proof = await recordCurrentPlatformEvidence({
    runId,
    workspaceRoot,
    allowScriptExecution: getConfig().allowUntrustedScripts,
  });
  console.log(
    `Recorded ${proof.hostPlatform} execution for exact Factory run ${proof.runId}.`,
  );
  for (const command of proof.commands) console.log(`  passed: ${command}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
