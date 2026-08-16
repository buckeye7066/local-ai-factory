import { getConfig, getSecrets } from "../server/config.js";
import {
  startRun,
  MissingProviderCredentialError,
} from "../server/orchestrator/runFactory.js";
import { getRun } from "../server/storage/runsStore.js";
import type { RunOptions } from "../shared/schemas.js";

/**
 * cli/factory.ts — run the assembly line from the terminal.
 *
 *   pnpm factory "build me a habit tracker"   (real work against real providers)
 *
 * There is no demo / mock / simulate mode: every invocation does real work
 * (owner order — no dry-run or report-only modes in owner tooling). `--demo`
 * was removed and now EXITS NON-ZERO rather than silently proceeding.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Flags that were removed outright; naming one is a hard error, not a warning. */
const REMOVED_FLAGS = ["--demo", "--dry-run", "--simulate", "--report-only"];

function parseArgs(argv: string[]): { idea: string } {
  const args = argv.slice(2);
  const named = REMOVED_FLAGS.filter((f) => args.includes(f));
  if (named.length) {
    console.error(
      `${COLORS.red}✘ ${named.join(", ")} ${named.length > 1 ? "were" : "was"} removed.${COLORS.reset}`,
    );
    console.error(
      `${COLORS.dim}  Factory Deck has no demo, mock, simulate, or dry-run mode —\n` +
        `  every run does real work against real providers. Start the FREE route\n` +
        `  ("Claude Code - FREE (Ollama)") or set ANTHROPIC_API_KEY / OPENAI_API_KEY.${COLORS.reset}`,
    );
    process.exit(2);
  }
  const idea = args
    .filter((a) => !a.startsWith("--"))
    .join(" ")
    .trim();
  return { idea };
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
  const { idea: parsedIdea } = parseArgs(process.argv);
  const idea = parsedIdea || "Build a Bible reading habit tracker";
  const config = getConfig();
  const secrets = getSecrets();

  console.log(
    `${COLORS.cyan}▌ Factory Deck — Local AI Software Factory${COLORS.reset}`,
  );
  console.log(`${COLORS.dim}  idea: ${idea}${COLORS.reset}\n`);

  const options: RunOptions = {};
  let started;
  try {
    started = startRun({ idea, options, config, secrets });
  } catch (err) {
    if (err instanceof MissingProviderCredentialError) {
      console.error(`${COLORS.red}✘ ${err.message}${COLORS.reset}`);
      console.error(
        `${COLORS.dim}  Start the FREE route ("Claude Code - FREE (Ollama)") or set a paid\n` +
          `  ANTHROPIC_API_KEY / OPENAI_API_KEY. There is no offline fallback.${COLORS.reset}`,
      );
      process.exit(1);
    }
    throw err;
  }

  // Poll the in-memory record and stream new log lines as they appear.
  let printed = 0;
  for (;;) {
    const run = await getRun(started.id);
    if (!run) break;
    for (; printed < run.logs.length; printed++) {
      const l = run.logs[printed];
      console.log(paint(l.kind, `  • ${l.message}`));
    }
    if (run.status === "completed" || run.status === "failed") {
      if (run.status === "completed" && run.finalReport) {
        const r = run.finalReport;
        console.log(`\n${COLORS.green}✔ ${r.appName}${COLORS.reset}`);
        console.log(`  ${r.summary}`);
        console.log(`\n  ${COLORS.cyan}How to run:${COLORS.reset} ${r.howToRun}`);
        console.log(
          `  ${COLORS.cyan}Tests:${COLORS.reset} ${r.testStatus}  ${COLORS.cyan}Repair loops:${COLORS.reset} ${r.repairLoops}`,
        );
        console.log(`  ${COLORS.cyan}Workspace:${COLORS.reset} ${r.workspacePath}`);
        if (r.caveats.length) {
          console.log(`\n  ${COLORS.yellow}Caveats:${COLORS.reset}`);
          r.caveats.forEach((c) => console.log(`    - ${c}`));
        }
      } else if (run.status === "failed") {
        console.log(`\n${COLORS.red}✘ Run failed: ${run.error}${COLORS.reset}`);
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
