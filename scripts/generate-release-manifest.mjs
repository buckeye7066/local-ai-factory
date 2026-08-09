#!/usr/bin/env node
/**
 * Generate docs/release-manifest.json for Factory Deck.
 * Implementer must not emit PRODUCTION READY.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "docs/release-manifest.json");
const PURPOSE = resolve(ROOT, "docs/purpose-contract.md");
const WORKFLOW = resolve(ROOT, ".github/workflows/production-readiness.yml");
const SCHEMA = resolve(ROOT, "docs/release-manifest.schema.json");
const REAL_PROOF = resolve(ROOT, "docs/evidence/real-provider-proof.json");
const ENV_PATH = resolve(ROOT, ".env");

/** Load .env into process.env without printing values (credential presence only). */
function loadDotEnvQuiet() {
  if (!existsSync(ENV_PATH)) return;
  for (const raw of readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnvQuiet();

function git(...args) {
  const env = {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: ROOT.replace(/\\/g, "/"),
  };
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", env });
  return { code: r.status ?? 1, out: (r.stdout || r.stderr || "").trim() };
}

function utc() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function purposeVersion() {
  if (!existsSync(PURPOSE)) return "missing";
  for (const line of readFileSync(PURPOSE, "utf8").split(/\r?\n/)) {
    if (line.toLowerCase().startsWith("**version:**")) {
      return line.split(":").slice(1).join(":").trim().replace(/\*/g, "").trim();
    }
  }
  return "unknown";
}

function argValue(flag, fallback = "") {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

const statusArg = argValue("--status", "BLOCKED");
if (statusArg === "PRODUCTION READY") {
  console.log(
    JSON.stringify(
      {
        error: "implementer_forbidden_status",
        detail:
          "Generator must not emit PRODUCTION READY; independent reviewers certify.",
      },
      null,
      2,
    ),
  );
  process.exit(1);
}

const headRes = git("rev-parse", "HEAD");
if (headRes.code !== 0) {
  console.log(JSON.stringify({ error: "git_head", detail: headRes.out }, null, 2));
  process.exit(1);
}
const head = headRes.out;
const mainRes = git("rev-parse", "origin/main");
let mainSha = mainRes.code === 0 && mainRes.out ? mainRes.out : head;
const expectMain = argValue("--expect-main-sha", "").trim();
if (expectMain) mainSha = expectMain;

const shaMatch = Boolean(
  head && mainSha && (head === mainSha || head.startsWith(mainSha.slice(0, 12))),
);

const deployed = argValue("--deployed-sha", "").trim() || null;
const launcher = argValue("--launcher-sha", "").trim() || null;
const reviewFunctional = argValue("--review-functional", "pending");
const reviewSecurity = argValue("--review-security", "pending");
const reviewRelease = argValue("--review-release", "pending");
const typecheckOk = hasFlag("--typecheck");
const unitTestsOk = hasFlag("--unit-tests");

const blockers = [];
const notes = [];

if (!existsSync(PURPOSE)) blockers.push("docs/purpose-contract.md missing");
if (!existsSync(WORKFLOW))
  blockers.push(".github/workflows/production-readiness.yml missing");
if (!existsSync(SCHEMA)) blockers.push("docs/release-manifest.schema.json missing");

if (reviewFunctional !== "pass") blockers.push(`functional review ${reviewFunctional}`);
if (reviewSecurity !== "pass") blockers.push(`security review ${reviewSecurity}`);
if (reviewRelease !== "pass") blockers.push(`release review ${reviewRelease}`);

if (!shaMatch) blockers.push(`SHA mismatch worktree=${head} expected_main=${mainSha}`);

let realProviderProof = false;
let realProofDetail = null;
if (existsSync(REAL_PROOF)) {
  try {
    realProofDetail = JSON.parse(readFileSync(REAL_PROOF, "utf8"));
    realProviderProof = realProofDetail?.ok === true && realProofDetail?.demo === false;
  } catch {
    notes.push("real_provider_proof_unreadable");
  }
}

const missingCreds = [];
if (!process.env.ANTHROPIC_API_KEY?.trim()) missingCreds.push("ANTHROPIC_API_KEY");
if (!process.env.OPENAI_API_KEY?.trim()) missingCreds.push("OPENAI_API_KEY");

// Live journey needs at least one paid provider. Prefer both for default routing.
if (!realProviderProof) {
  if (missingCreds.length === 2) {
    blockers.push(
      `missing credential(s) for live factory journey: ${missingCreds.join(", ")}`,
    );
  } else {
    blockers.push(
      "real-provider journey proof missing (docs/evidence/real-provider-proof.json); mock-only evidence does not fulfill purpose",
    );
  }
}

if (launcher && head && launcher !== head && !head.startsWith(launcher.slice(0, 12))) {
  blockers.push(`launcher_sha mismatch launcher=${launcher} worktree=${head}`);
}

let status = statusArg;
const mockOnlyCore = !realProviderProof;

if (mockOnlyCore && (status === "RELEASE CANDIDATE" || status === "PRODUCTION READY")) {
  status = "BLOCKED";
  notes.push("status_downgraded_due_to_mock_only_core");
}
if (blockers.length && status === "RELEASE CANDIDATE") {
  status = "BLOCKED";
  notes.push("status_downgraded_to_BLOCKED_due_to_unresolved_blockers");
}

const gates = {
  release_check: true,
  production_readiness_workflow: existsSync(WORKFLOW),
  purpose_contract: existsSync(PURPOSE),
  typecheck: typecheckOk,
  unit_tests: unitTestsOk,
  real_provider_proof: realProviderProof,
};

const manifest = {
  schema_version: "1.0",
  program: "Factory Deck",
  repo: "buckeye7066/local-ai-factory",
  default_branch: "main",
  main_sha: mainSha,
  worktree_sha: head,
  deployed_sha: deployed,
  launcher_sha: launcher,
  generated_at: utc(),
  status,
  purpose_contract_version: purposeVersion(),
  purpose_contract_path: "docs/purpose-contract.md",
  blockers,
  gates,
  reviews: {
    functional: reviewFunctional,
    security: reviewSecurity,
    release: reviewRelease,
  },
  proofs: {
    real_provider_journey: realProviderProof,
    real_provider_detail: realProofDetail
      ? {
          runId: realProofDetail.runId ?? null,
          codeProvider: realProofDetail.codeProvider ?? null,
          reviewProvider: realProofDetail.reviewProvider ?? null,
          status: realProofDetail.status ?? null,
          recorded_at: realProofDetail.recorded_at ?? null,
        }
      : null,
    mock_e2e_as_production_ready: false,
    missing_credentials_observed: missingCreds,
  },
  mock_only_core: mockOnlyCore,
  sha_match: shaMatch,
  notes,
};

mkdirSync(dirname(OUT), { recursive: true });
const tmp = OUT + ".tmp";
writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n", "utf8");
renameSync(tmp, OUT);
console.log(JSON.stringify(manifest, null, 2));

if (mockOnlyCore && hasFlag("--require-real-provider")) process.exit(1);
if (hasFlag("--require-clean") && blockers.length) process.exit(1);
process.exit(0);
