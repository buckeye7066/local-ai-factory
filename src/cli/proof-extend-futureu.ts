/**
 * proof:extend-futureu — LIVE end-to-end proof of extend mode against a real
 * existing app: FutureU's real repo at C:\Users\firer\FutureU, in place, on a
 * dedicated branch, through the REAL free-route provider (no mock/demo).
 *
 * Owner-authorized directly (this is not the default-safe path): real repo,
 * real commits land on a factory-deck/<runId> branch, not pushed/merged.
 * FutureU's working tree had pre-existing uncommitted changes from other work
 * NOT made by this run — those are left untouched; this script only stages
 * the specific new files the run itself wrote.
 *
 * Writes docs/evidence/extend-futureu-proof.json.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runFactory } from "../server/orchestrator/runFactory.js";
import { getConfig, getSecrets } from "../server/config.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = resolve(ROOT, "docs/evidence/extend-futureu-proof.json");

const GOAL = [
  "Add a new 'Weekly Progress Digest' feature for parents on the Family Dashboard: for each of a parent's children, ",
  "summarize lessons completed and average grade over the last 7 days, in a simple print-friendly layout, reachable via a link from the Family Dashboard. ",
  "Implement a real backend endpoint that computes this from the existing lesson/grade data (follow the existing server's route + db patterns). ",
  "Do NOT modify these existing files — they have unrelated in-progress edits from other work: Dockerfile, client/index.html, client/src/pages/Admin.jsx, ",
  "client/src/pages/Catalog.jsx, scripts/validate-content.js, server/compliance.js, server/db.js. Add new files instead. ",
  "Only touch client/src/App.jsx and client/src/pages/ParentDashboard.jsx if strictly necessary to register the new route/link, and keep those edits minimal.",
].join("");

async function main() {
  const config = getConfig();
  const secrets = getSecrets();

  console.log(
    "Factory Deck — LIVE extend-mode proof against FutureU (real repo, real free-route model)",
  );
  console.log(
    `  target         : C:\\Users\\firer\\FutureU (inPlace=true, dedicated branch)`,
  );
  console.log(`  free base url  : ${config.free.baseUrl}`);
  console.log(`  free model     : ${config.free.model}`);

  const startedAt = Date.now();
  const run = await runFactory({
    idea: GOAL,
    options: {
      demo: false,
      mode: "extend",
      repoSource: {
        type: "path",
        location: "C:\\Users\\firer\\FutureU",
        inPlace: true,
      },
      goals: [GOAL],
    },
    config,
    secrets,
  });
  const elapsedMs = Date.now() - startedAt;

  const payload = {
    ok: run.status === "completed",
    recorded_at: new Date().toISOString(),
    runId: run.id,
    status: run.status,
    error: run.error,
    appName: run.appName,
    workspacePath: run.workspacePath,
    elapsedMs,
    repairLoops: run.repairLoops,
    filesWritten: run.files.map((f) => ({
      path: f.path,
      status: f.status,
      size: f.size,
    })),
    providerUsage: run.providerUsage,
    finalReport: run.finalReport,
    stages: run.stages.map((s) => ({
      id: s.id,
      status: s.status,
      durationMs: s.durationMs,
    })),
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log(JSON.stringify(payload, null, 2));
  process.exit(payload.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
