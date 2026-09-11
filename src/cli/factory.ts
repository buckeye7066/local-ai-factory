import { getConfig, getSecrets } from "../server/config.js";
import {
  startRun,
  selectRunRouting,
  MissingProviderCredentialError,
} from "../server/orchestrator/runFactory.js";
import { createProviderRegistry } from "../server/providers/index.js";
import { loadReadinessState } from "../server/storage/readinessStore.js";
import { getRun } from "../server/storage/runsStore.js";
import type { RunOptions } from "../shared/schemas.js";
import {
  FACTORY_CLI_USAGE,
  FactoryCliArgumentError,
  parseFactoryCliInputs,
} from "./factoryInput.js";

/**
 * cli/factory.ts — run the assembly line from the terminal.
 *
 *   FACTORY_PROJECT_ID=habit-tracker pnpm factory "build me a habit tracker"
 *
 * Every invocation does real work against real providers. There is no demo,
 * dry-run, simulate, or report-only mode: those flags are hard errors, and so
 * is a missing idea or project identity — both are refused BEFORE a run record
 * exists, instead of starting a run that can only fail at intake.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const COLORS: Record<string, string> = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
};

function paint(kind: string, msg: string): string {
  const map: Record<string, string> = {
    success: COLORS.green,
    warning: COLORS.yellow,
    error: COLORS.red,
    model_call: COLORS.magenta,
    file_write: COLORS.cyan,
    command_run: COLORS.dim,
  };
  return `${map[kind] ?? ""}${msg}${COLORS.reset}`;
}

async function main() {
  let parsed: { idea: string };
  try {
    parsed = parseFactoryCliInputs(process.argv);
  } catch (error) {
    if (error instanceof FactoryCliArgumentError) {
      console.error(`${COLORS.red}✘ ${error.message}${COLORS.reset}`);
      process.exit(2);
    }
    throw error;
  }
  const { idea } = parsed;
  // A CLI run builds a new local app, which intake refuses without a stable
  // project identity. Refuse here, before any run record or model call.
  const projectId = process.env.FACTORY_PROJECT_ID?.trim();
  if (!projectId) {
    console.error(
      `${COLORS.red}✘ No project identity: set FACTORY_PROJECT_ID so this app's purpose and memory carry across runs. No run was started.\n  ${FACTORY_CLI_USAGE}${COLORS.reset}`,
    );
    process.exit(2);
  }
  const config = getConfig();
  const secrets = getSecrets();

  console.log(
    `${COLORS.cyan}▌ Factory Deck — Local AI Software Factory${COLORS.reset}`,
  );
  console.log(`${COLORS.dim}  idea: ${idea}${COLORS.reset}`);
  const options: RunOptions = { projectId };
  try {
    // Print the ladder this run will actually use — only configured rungs —
    // not the preferred order from config, which named paid rungs that had no
    // key (a free-only machine read "anthropic → openai → free").
    const routing = selectRunRouting(
      options,
      createProviderRegistry(config, secrets),
      config,
    );
    console.log(
      `${COLORS.dim}  automatic model ladder: ${(routing.ladder ?? [routing.codeProvider]).join(" → ")}${COLORS.reset}\n`,
    );
  } catch (err) {
    if (err instanceof MissingProviderCredentialError) {
      console.error(`${COLORS.red}✘ ${err.message}${COLORS.reset}`);
      process.exit(1);
    }
    throw err;
  }
  let started;
  try {
    started = startRun({ idea, options, config, secrets });
  } catch (err) {
    if (err instanceof MissingProviderCredentialError) {
      console.error(`${COLORS.red}✘ ${err.message}${COLORS.reset}`);
      process.exit(1);
    }
    throw err;
  }

  // Poll the in-memory record and stream new log lines as they appear.
  let printed = 0;
  for (;;) {
    const run = await getRun(started.id);
    if (!run) {
      console.error(
        `${COLORS.red}✘ Run record ${started.id} disappeared before a terminal result.${COLORS.reset}`,
      );
      process.exitCode = 1;
      break;
    }
    for (; printed < run.logs.length; printed++) {
      const l = run.logs[printed];
      console.log(paint(l.kind, `  • ${l.message}`));
    }
    if (
      run.status === "completed" ||
      run.status === "failed" ||
      run.status === "cancelled"
    ) {
      if (run.status === "completed" && run.finalReport) {
        const readiness = await loadReadinessState(run.id);
        if (readiness?.status !== "ready" || readiness.receipt?.ready !== true) {
          console.log(
            `\n${COLORS.red}✘ Pipeline ended, but the app is NOT production-ready.${COLORS.reset}`,
          );
          for (const blocker of readiness?.blockers ?? [
            "Mandatory readiness receipt is missing.",
          ]) {
            console.log(`    - ${blocker}`);
          }
          console.log(
            `${COLORS.dim}  Owner-managed legal/external matters were not evaluated.${COLORS.reset}`,
          );
          process.exitCode = 1;
          break;
        }

        const r = run.finalReport;
        console.log(
          `\n${COLORS.green}✔ ${r.appName} — PRODUCTION READY${COLORS.reset}`,
        );
        console.log(`  ${r.summary}`);
        console.log(`\n  ${COLORS.cyan}How to run:${COLORS.reset} ${r.howToRun}`);
        console.log(
          `  ${COLORS.cyan}Tests:${COLORS.reset} ${r.testStatus}  ${COLORS.cyan}Repair loops:${COLORS.reset} ${r.repairLoops}`,
        );
        console.log(`  ${COLORS.cyan}Workspace:${COLORS.reset} ${r.workspacePath}`);
        console.log(
          `  ${COLORS.cyan}Readiness evidence:${COLORS.reset} ${readiness.evidenceDigest}`,
        );
        if (r.caveats.length) {
          console.log(`\n  ${COLORS.yellow}Caveats:${COLORS.reset}`);
          r.caveats.forEach((c) => console.log(`    - ${c}`));
        }
      } else if (run.status === "completed") {
        console.log(
          `\n${COLORS.red}✘ Run completed without a final report and cannot be accepted.${COLORS.reset}`,
        );
        process.exitCode = 1;
      } else if (run.status === "failed") {
        console.log(`\n${COLORS.red}✘ Run failed: ${run.error}${COLORS.reset}`);
        process.exitCode = 1;
      } else {
        console.log(`\n${COLORS.red}✘ Run was cancelled.${COLORS.reset}`);
        process.exitCode = 1;
      }
      break;
    }
    await sleep(120);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
