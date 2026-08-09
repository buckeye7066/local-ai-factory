#!/usr/bin/env node
/**
 * Permanent release:check gate for Factory Deck (local-ai-factory).
 *
 * Fails (exit 1) when:
 *  - purpose contract / production-readiness workflow / schema missing
 *  - release manifest claims RC/PR with unresolved blockers
 *  - mock_only_core is true
 *  - SHA mismatch for ready statuses
 *  - PRODUCTION READY without all reviews pass (and implementer CI must refuse PR claim)
 *
 * Never invents success. Honest BLOCKED (missing credentials) is allowed.
 */
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = resolve(ROOT, "docs/release-manifest.json");
const SCHEMA_PATH = resolve(ROOT, "docs/release-manifest.schema.json");
const PURPOSE_PATH = resolve(ROOT, "docs/purpose-contract.md");
const WORKFLOW_PATH = resolve(ROOT, ".github/workflows/production-readiness.yml");
const ALLOWED = new Set([
  "IN PROGRESS",
  "BLOCKED",
  "RELEASE CANDIDATE",
  "PRODUCTION READY",
]);

function git(...args) {
  const env = {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: ROOT.replace(/\\/g, "/"),
  };
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", env });
  const out = (r.stdout || r.stderr || "").trim();
  return { code: r.status ?? 1, out };
}

function utc() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

const errors = [];
const notes = [];

for (const [label, path] of [
  ["purpose_contract", PURPOSE_PATH],
  ["release_manifest_schema", SCHEMA_PATH],
  ["production_readiness_workflow", WORKFLOW_PATH],
]) {
  if (!existsSync(path)) errors.push(`missing_required:${label}:${path}`);
  else notes.push(`present:${label}`);
}

const headRes = git("rev-parse", "HEAD");
const head = headRes.code === 0 ? headRes.out : "";
if (!head) errors.push(`git_head_unreadable:${headRes.out}`);

let manifest = null;
if (!existsSync(MANIFEST_PATH)) {
  notes.push("release_manifest_absent");
  if (process.env.FACTORY_REQUIRE_MANIFEST === "1") {
    errors.push("missing_release_manifest");
  }
} else {
  manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  const status = manifest.status;
  if (!ALLOWED.has(status)) errors.push(`invalid_status:${JSON.stringify(status)}`);
  const blockers = Array.isArray(manifest.blockers) ? manifest.blockers : [];
  const mockOnly = Boolean(manifest.mock_only_core);
  let shaMatch = Boolean(manifest.sha_match);
  const mainSha = String(manifest.main_sha || "");

  if (mockOnly && (status === "RELEASE CANDIDATE" || status === "PRODUCTION READY")) {
    errors.push("mock_only_core_true");
  }
  // Always forbid recording mock e2e as production-ready proof, any status.
  if ((manifest.proofs || {}).mock_e2e_as_production_ready === true) {
    errors.push("forbidden_proof:mock_e2e_as_production_ready");
  }

  if (mainSha && head && head !== mainSha && !head.startsWith(mainSha.slice(0, 12))) {
    errors.push(`sha_mismatch:head=${head}:manifest=${mainSha}`);
    shaMatch = false;
  }

  if (!shaMatch && (status === "RELEASE CANDIDATE" || status === "PRODUCTION READY")) {
    errors.push("sha_match_false_for_ready_status");
  }
  if (blockers.length && (status === "RELEASE CANDIDATE" || status === "PRODUCTION READY")) {
    errors.push("unresolved_blockers_with_ready_status:" + blockers.slice(0, 8).join("|"));
  }
  if (status === "PRODUCTION READY") {
    const reviews = manifest.reviews || {};
    for (const lane of ["functional", "security", "release"]) {
      if (reviews[lane] !== "pass") {
        errors.push(`review_not_pass:${lane}=${JSON.stringify(reviews[lane])}`);
      }
    }
    if (blockers.length) errors.push("production_ready_forbidden_with_blockers");
  }

  const gates = manifest.gates || {};
  for (const g of [
    "release_check",
    "production_readiness_workflow",
    "purpose_contract",
  ]) {
    if (gates[g] !== true && (status === "RELEASE CANDIDATE" || status === "PRODUCTION READY")) {
      errors.push(`gate_false:${g}`);
    }
  }

  // Core purpose cannot be satisfied by mock-only evidence for ready statuses.
  const proofs = manifest.proofs || {};
  if (
    (status === "RELEASE CANDIDATE" || status === "PRODUCTION READY") &&
    proofs.real_provider_journey !== true
  ) {
    errors.push("real_provider_journey_required_for_ready_status");
  }
}

const payload = {
  ok: errors.length === 0,
  generated_at: utc(),
  head,
  errors,
  notes,
  manifest_present: manifest !== null,
};
console.log(JSON.stringify(payload, null, 2));
process.exit(errors.length === 0 ? 0 : 1);
