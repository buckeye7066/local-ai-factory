/**
 * proof:real-provider - exercise a complete Factory Deck journey through the
 * same automatic paid-first, free-last model ladder used by production runs.
 *
 * The proof never pins a provider and never treats missing paid credentials as
 * a blocker when the terminal free/local rung is usable. It refuses mock/stub
 * output and writes a receipt only for the actual run outcome.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig, getSecrets } from "../server/config.js";
import { runFactory } from "../server/orchestrator/runFactory.js";
import { OFFLINE_PROVIDERS } from "../server/providers/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = resolve(ROOT, "docs/evidence/real-provider-proof.json");

function utc() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function main() {
  const config = getConfig();
  const secrets = getSecrets();
  const idea =
    process.argv.slice(2).filter((arg) => !arg.startsWith("--")).join(" ").trim() ||
    "Build a tiny sticky-note counter app";

  console.log("Factory Deck - automatic live-ladder proof");
  console.log(`  idea: ${idea}`);
  console.log(`  ladder: ${(config.modelLadder ?? ["anthropic", "openai", "free"]).join(" -> ")}`);

  try {
    const run = await runFactory({
      idea,
      options: {
        timeoutMs: Number(process.env.FACTORY_PROOF_TIMEOUT_MS || 900_000),
      },
      config: {
        ...config,
        // Provider authenticity is independent of executing generated install
        // scripts. Opt in explicitly when the proof environment is disposable.
        allowUntrustedScripts: process.env.FACTORY_PROOF_ALLOW_COMMANDS === "1",
      },
      secrets,
    });

    if (run.demo) throw new Error("Refusing proof: production run was marked demo");
    if (OFFLINE_PROVIDERS.has(run.codeProvider) || OFFLINE_PROVIDERS.has(run.reviewProvider)) {
      throw new Error(
        `Refusing proof: offline provider used (code=${run.codeProvider}, review=${run.reviewProvider})`,
      );
    }

    const payload = {
      ok: run.status === "completed",
      blocked: false,
      status: run.status,
      runId: run.id,
      routingMode: run.routingMode,
      codeProvider: run.codeProvider,
      reviewProvider: run.reviewProvider,
      configuredLadder: config.modelLadder,
      appName: run.appName,
      workspacePath: run.workspacePath,
      repairLoops: run.repairLoops,
      providerUsage: run.providerUsage,
      error: run.error,
      recorded_at: utc(),
    };
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(payload, null, 2) + "\n", "utf8");
    console.log(JSON.stringify(payload, null, 2));
    process.exit(payload.ok ? 0 : 1);
  } catch (error) {
    const payload = {
      ok: false,
      blocked: true,
      recorded_at: utc(),
      error: error instanceof Error ? error.message : String(error),
    };
    // A failed invocation is diagnostic output, not current proof evidence.
    // Do not overwrite a previously successful receipt with a red failure file.
    console.error(JSON.stringify(payload, null, 2));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
