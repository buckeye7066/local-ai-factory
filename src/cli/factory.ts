import { getConfig, getSecrets } from "../server/config.js";
import {
  startRun,
  MissingProviderCredentialError,
} from "../server/orchestrator/runFactory.js";
import { loadReadinessState } from "../server/storage/readinessStore.js";
import { getRun } from "../server/storage/runsStore.js";
import type { RunOptions } from "../shared/schemas.js";
import { factoryIdeaFromInputs } from "./factoryInput.js";

/**
 * cli/factory.ts — run the assembly line from the terminal.
 *
 *   pnpm factory "build me a habit tracker"          (real providers)
 *   pnpm factory --demo "build me a habit tracker"   (zero-credit preview)
 *
 * The explicit --demo route is permanently marked offline, never delivered,
 * and never described as production-ready. Ambiguous dry-run/simulate flags
 * remain hard errors rather than silently changing a real request into a no-op.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Flags that were removed outright; naming one is a hard error, not a warning. */
const REMOVED_FLAGS = ["--dry-run", "--simulate", "--report-only"];

function parseArgs(argv: string[]): { idea: string; demo: boolean } {
  const args = argv.slice(2);
  const named = REMOVED_FLAGS.filter((f) => args.includes(f));
  if (named.length) {
    console.error(
      `${COLORS.red}✘ ${named.join(", ")} ${named.length > 1 ? "were" : "was"} removed.${COLORS.reset}`,
    );
    console.error(
      `${COLORS.dim}  Use --demo for an explicit zero-credit offline preview.\n` +
        `  Omit it for real work through the automatic model ladder.${COLORS.reset}`,
    );
    process.exit(2);
  }
  return { idea: factoryIdeaFromInputs(argv), demo: args.includes("--demo") };
}

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
  const { idea, demo } = parseArgs(process.argv);
  const config = getConfig();
  const secrets = getSecrets();

  console.log(
    `${COLORS.cyan}▌ Factory Deck — Local AI Software Factory${COLORS.reset}`,
  );
  console.log(`${COLORS.dim}  idea: ${idea}${COLORS.reset}`);
  if (demo) {
    console.log(
      `${COLORS.yellow}  mode: zero-credit offline demo (never delivered or production-ready)${COLORS.reset}\n`,
    );
  } else {
    const modelLadder = config.modelLadder ?? ["anthropic", "openai", "free"];
    console.log(
      `${COLORS.dim}  automatic model ladder: ${modelLadder.join(" → ")}${COLORS.reset}\n`,
    );
  }

  const projectId = process.env.FACTORY_PROJECT_ID?.trim();
  const options: RunOptions = {
    ...(projectId ? { projectId } : {}),
    ...(demo ? { demo: true, publish: false, pushToOrigin: false } : {}),
  };
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
      if (run.status === "completed" && run.finalReport && run.demo) {
        const r = run.finalReport;
        console.log(
          `\n${COLORS.yellow}✔ ${r.appName} — OFFLINE DEMO COMPLETE${COLORS.reset}`,
        );
        console.log(`  ${r.summary}`);
        console.log(`  ${COLORS.cyan}Workspace:${COLORS.reset} ${r.workspacePath}`);
        console.log(
          `  ${COLORS.dim}Mock output only: zero paid credits; no delivery, release, deployment, or production-readiness claim.${COLORS.reset}`,
        );
      } else if (run.status === "completed" && run.finalReport) {
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
