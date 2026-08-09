/**
 * proof:real-provider — live (non-demo) factory journey proof.
 *
 * Writes docs/evidence/real-provider-proof.json on success.
 * Exits non-zero with exact missing credential names when keys are absent.
 * Never records mock/demo success as real-provider proof.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig, getSecrets, isAnthropicConfigured, isOpenAiConfigured } from "../server/config.js";
import {
  runFactory,
  MissingProviderCredentialError,
} from "../server/orchestrator/runFactory.js";
import { OFFLINE_PROVIDERS } from "../server/providers/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = resolve(ROOT, "docs/evidence/real-provider-proof.json");

function utc() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function main() {
  const config = getConfig();
  const secrets = getSecrets();
  const missing: string[] = [];
  if (!isAnthropicConfigured(secrets)) missing.push("ANTHROPIC_API_KEY");
  if (!isOpenAiConfigured(secrets)) missing.push("OPENAI_API_KEY");

  // Need at least one paid provider for a live journey.
  if (missing.length === 2) {
    const payload = {
      ok: false,
      demo: false,
      blocked: true,
      missing,
      recorded_at: utc(),
      error: `Live factory journey blocked: missing credential(s): ${missing.join(", ")}`,
    };
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(payload, null, 2) + "\n", "utf8");
    console.error(JSON.stringify(payload, null, 2));
    process.exit(1);
  }

const ideaParts: string[] = [];
let codeProvider: "anthropic" | "openai" | undefined;
let reviewProvider: "anthropic" | "openai" | undefined;
for (const a of process.argv.slice(2)) {
  if (a.startsWith("--code-provider=")) {
    const v = a.slice("--code-provider=".length);
    if (v === "anthropic" || v === "openai") codeProvider = v;
  } else if (a.startsWith("--review-provider=")) {
    const v = a.slice("--review-provider=".length);
    if (v === "anthropic" || v === "openai") reviewProvider = v;
  } else if (!a.startsWith("--")) {
    ideaParts.push(a);
  }
}
const idea = ideaParts.join(" ").trim() || "Build a tiny sticky-note counter app";

// Env overrides for CI/scripts (read after dotenv via getConfig already ran).
if (!codeProvider) {
  const v = process.env.FACTORY_PROOF_CODE_PROVIDER?.trim();
  if (v === "anthropic" || v === "openai") codeProvider = v;
}
if (!reviewProvider) {
  const v = process.env.FACTORY_PROOF_REVIEW_PROVIDER?.trim();
  if (v === "anthropic" || v === "openai") reviewProvider = v;
}

console.log("Factory Deck — real-provider proof (demo=false)");
console.log(`  idea: ${idea}`);
console.log(
  `  credentials: anthropic=${isAnthropicConfigured(secrets)} openai=${isOpenAiConfigured(secrets)}`,
);
if (codeProvider) console.log(`  codeProvider: ${codeProvider}`);
if (reviewProvider) console.log(`  reviewProvider: ${reviewProvider}`);

try {
  const run = await runFactory({
    idea,
    options: {
      demo: false,
      codeProvider,
      reviewProvider,
      // Prefer configured defaults; leave provider selection to resolveLive.
      timeoutMs: Number(process.env.FACTORY_PROOF_TIMEOUT_MS || 900_000),
    },
    config: {
      ...config,
      // Keep commands dry-run for proof safety unless explicitly opted in.
      dryRunCommands: process.env.FACTORY_PROOF_ALLOW_COMMANDS === "1" ? false : true,
    },
    secrets,
  });

    if (run.demo) {
      throw new Error("Refusing to record proof: run.demo unexpectedly true");
    }
    if (OFFLINE_PROVIDERS.has(run.codeProvider) || OFFLINE_PROVIDERS.has(run.reviewProvider)) {
      throw new Error(
        `Refusing to record proof: offline provider used (code=${run.codeProvider}, review=${run.reviewProvider})`,
      );
    }

    const payload = {
      ok: run.status === "completed",
      demo: false,
      blocked: false,
      status: run.status,
      runId: run.id,
      codeProvider: run.codeProvider,
      reviewProvider: run.reviewProvider,
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
  } catch (err) {
    if (err instanceof MissingProviderCredentialError) {
      const payload = {
        ok: false,
        demo: false,
        blocked: true,
        missing: err.missing,
        recorded_at: utc(),
        error: err.message,
      };
      mkdirSync(dirname(OUT), { recursive: true });
      writeFileSync(OUT, JSON.stringify(payload, null, 2) + "\n", "utf8");
      console.error(JSON.stringify(payload, null, 2));
      process.exit(1);
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
