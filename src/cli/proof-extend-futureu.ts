/**
 * proof:extend-futureu - owner-authorized real extend-run proof for FutureU.
 *
 * Target is explicit, never hardcoded to one Windows account. Pass a local
 * checkout path or git URL as argv[1], or set FACTORY_PROOF_REPO. The normal
 * automatic paid-first/free-last model ladder is used without provider pins.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig, getSecrets } from "../server/config.js";
import { runFactory } from "../server/orchestrator/runFactory.js";
import type { RepoSource } from "../shared/schemas.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = resolve(ROOT, "docs/evidence/extend-futureu-proof.json");

function utc() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function repoSource(location: string): RepoSource {
  const git = /^(?:https?:\/\/|ssh:\/\/|git:\/\/|git@)/i.test(location);
  return git
    ? { type: "git", location, inPlace: false }
    : {
        type: "path",
        location,
        inPlace: process.env.FACTORY_PROOF_IN_PLACE === "1",
      };
}

async function main() {
  const target = process.argv.slice(2).find((arg) => !arg.startsWith("--"))?.trim() ||
    process.env.FACTORY_PROOF_REPO?.trim() ||
    "";
  if (!target) {
    throw new Error(
      "FutureU proof target is required. Pass a repo path/URL or set FACTORY_PROOF_REPO.",
    );
  }

  const config = getConfig();
  const secrets = getSecrets();
  const source = repoSource(target);
  const run = await runFactory({
    idea:
      "Extend FutureU with a small production-safe student progress summary and prove the changed behavior without weakening existing features.",
    options: {
      mode: "extend",
      repoSource: source,
      goals: [
        "Add a concrete student progress summary through existing application surfaces.",
        "Preserve existing behavior and verify the changed journey with executable tests.",
      ],
      pushToOrigin: false,
      timeoutMs: Number(process.env.FACTORY_PROOF_TIMEOUT_MS || 900_000),
    },
    config: {
      ...config,
      allowUntrustedScripts: process.env.FACTORY_PROOF_ALLOW_COMMANDS === "1",
    },
    secrets,
  });

  const payload = {
    ok: run.status === "completed",
    recorded_at: utc(),
    runId: run.id,
    status: run.status,
    routingMode: run.routingMode,
    codeProvider: run.codeProvider,
    reviewProvider: run.reviewProvider,
    target: source,
    appName: run.appName,
    workspacePath: run.workspacePath,
    repairLoops: run.repairLoops,
    providerUsage: run.providerUsage,
    error: run.error,
  };

  if (payload.ok) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(payload, null, 2) + "\n", "utf8");
  }
  console.log(JSON.stringify(payload, null, 2));
  process.exit(payload.ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
