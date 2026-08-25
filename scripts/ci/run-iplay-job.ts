import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getConfig, getSecrets } from "../../src/server/config.js";
import {
  startRun,
  MissingProviderCredentialError,
} from "../../src/server/orchestrator/runFactory.js";
import { getRun, getRunCheckpoint } from "../../src/server/storage/runsStore.js";

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function isExpectedSafetyHold(runId: string): Promise<boolean> {
  if (process.env.FACTORY_ACCEPT_SAFETY_HOLD !== "true") return false;
  const checkpoint = await getRunCheckpoint(runId);
  const verification = checkpoint?.verification;
  const incomplete = verification?.incomplete ?? [];
  if (
    !checkpoint ||
    !verification ||
    checkpoint.blockingWriteRefusals.length > 0 ||
    checkpoint.testsExecuted ||
    checkpoint.testExit !== null ||
    !incomplete.some((item) => /ALLOW_UNTRUSTED_SCRIPTS=0/i.test(item.reason)) ||
    verification.executed.some((item) => item.exitCode !== 0)
  ) {
    return false;
  }

  // Direct acceptance evidence is necessarily absent when every generated
  // test command is held. Any other missing prerequisite remains a real error.
  const safetyConsequencesOnly = incomplete.every(
    (item) =>
      /ALLOW_UNTRUSTED_SCRIPTS=0/i.test(item.reason) ||
      /mapped test (?:file did not produce valid direct runner evidence|".*" was not reported passed)/i.test(
        item.reason,
      ),
  );
  const nonSyntheticBlockers = (checkpoint.qa?.issues ?? []).filter(
    (issue) =>
      (issue.severity === "critical" || issue.severity === "high") &&
      !issue.title.startsWith("Required verification did not execute:"),
  );
  return safetyConsequencesOnly && nonSyntheticBlockers.length === 0;
}

async function main() {
  const promptPath = resolve("jobs", "iplay", "prompt.md");
  const sourcePath = resolve("jobs", "iplay", "source");
  const prompt = readFileSync(promptPath, "utf8").trim();
  const config = getConfig();
  const secrets = getSecrets();

  if (!secrets.anthropicApiKey || !secrets.openaiApiKey) {
    throw new MissingProviderCredentialError([
      ...(!secrets.anthropicApiKey ? ["ANTHROPIC_API_KEY"] : []),
      ...(!secrets.openaiApiKey ? ["OPENAI_API_KEY"] : []),
    ]);
  }

  const started = startRun({
    idea: "Transform IPlay according to the attached production specification.",
    options: {
      mode: "extend",
      repoSource: { type: "path", location: sourcePath },
      goals: [prompt],
      codeProvider: "anthropic",
      reviewProvider: "openai",
      maxRepairLoops: 3,
      pushToOrigin: false,
      timeoutMs: 21_000_000,
    },
    config,
    secrets,
  });

  console.log(`[iplay-job] Factory Deck run ${started.id} queued.`);
  let printed = 0;
  let finalRun = started;
  for (;;) {
    const current = await getRun(started.id);
    if (!current) throw new Error("Factory Deck run record disappeared.");
    finalRun = current;
    while (printed < current.logs.length) {
      const line = current.logs[printed++];
      console.log(
        `[${new Date(line.ts).toISOString()}] [${line.stage ?? "system"}] [${line.kind}] ${line.message}`,
      );
    }
    if (
      current.status === "completed" ||
      current.status === "failed" ||
      current.status === "cancelled"
    ) {
      break;
    }
    await sleep(2_000);
  }

  mkdirSync(resolve("jobs", "iplay"), { recursive: true });
  writeFileSync(
    resolve("jobs", "iplay", "run-result.json"),
    JSON.stringify(finalRun, null, 2),
    "utf8",
  );

  console.log(
    `[iplay-job] status=${finalRun.status} workspace=${finalRun.workspacePath ?? "none"}`,
  );
  console.log(
    `[iplay-job] provider calls: anthropic=${finalRun.providerUsage.anthropic.calls}, openai=${finalRun.providerUsage.openai.calls}, free=${finalRun.providerUsage.free.calls}`,
  );
  if (
    finalRun.status === "failed" &&
    config.allowUntrustedScripts === false &&
    /^Verification gate failed:.*receipt=valid\./i.test(finalRun.error ?? "") &&
    (await isExpectedSafetyHold(finalRun.id))
  ) {
    console.log(
      "[iplay-job] expected safety hold: planning artifacts were preserved, but no generated scripts were executed and no production-ready claim was made.",
    );
    return;
  }
  if (finalRun.status !== "completed") {
    throw new Error(finalRun.error ?? `Factory Deck ended with ${finalRun.status}`);
  }
}

main().catch((error) => {
  console.error(
    `[iplay-job] failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
