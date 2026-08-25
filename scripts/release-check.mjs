#!/usr/bin/env node
/**
 * Executable repository gate for Factory Deck.
 *
 * This check validates concrete source controls only. It deliberately does not
 * create or consume readiness manifests or review-status files. Product
 * readiness is grounded in executable evidence from the exact revision.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname, extname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  ["purpose_contract", "docs/purpose-contract.md"],
  ["production_readiness_workflow", ".github/workflows/production-readiness.yml"],
  ["provider_timeout_regression", "src/server/__tests__/providerAbort.test.ts"],
  ["anthropic_provider", "src/server/providers/anthropicProvider.ts"],
  ["openai_provider", "src/server/providers/openaiProvider.ts"],
  ["package", "package.json"],
];

const errors = [];
const notes = [];
for (const [label, relativePath] of required) {
  const path = resolve(ROOT, relativePath);
  if (!existsSync(path)) errors.push(`missing_required:${label}:${relativePath}`);
  else notes.push(`present:${label}`);
}

const packagePath = resolve(ROOT, "package.json");
if (existsSync(packagePath)) {
  try {
    const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
    for (const script of ["typecheck", "test", "release:check"]) {
      if (!pkg?.scripts?.[script]) errors.push(`missing_package_script:${script}`);
    }
    if (pkg?.scripts?.["release:manifest"]) {
      errors.push("forbidden_readiness_bookkeeping_script:release:manifest");
    }
  } catch (error) {
    errors.push(
      `invalid_package_json:${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

for (const forbidden of [
  "docs/release-manifest.json",
  "docs/release-manifest.schema.json",
  "docs/reviews/SEQUENTIAL_REVIEW.md",
]) {
  if (existsSync(resolve(ROOT, forbidden))) {
    errors.push(`forbidden_readiness_bookkeeping:${forbidden}`);
  }
}

const excludedDirectories = new Set([
  ".factory",
  ".git",
  "coverage",
  "dist",
  "node_modules",
  "workspaces",
]);
const textExtensions = new Set([
  ".cmd",
  ".css",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".ps1",
  ".py",
  ".pyw",
  ".sh",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);
const prohibitedLanguage = [
  ["organizational_gate", "sign" + " off"],
  ["organizational_gate_compact", "sign" + "off"],
  ["completed_organizational_gate", "signed" + " off"],
  ["identity_gate", "authenticated " + "reviewer"],
  ["mandatory_reviewer_gate", "required " + "reviewer"],
  ["person_gate", "human " + "review"],
  ["manual_gate", "manual " + "approval"],
  ["implementation_readiness_claim", "self " + "certif"],
  ["main_revision_label", "certified " + "main"],
];

function normalizeLanguage(value) {
  return value.toLowerCase().replace(/[-_\s]+/g, " ");
}

if (!textExtensions.has(".py") || !textExtensions.has(".pyw")) {
  errors.push("release_language_policy_self_test:python_sources_not_scanned");
}
const wrappedPhraseProbe = normalizeLanguage("manual\napproval");
if (!prohibitedLanguage.some(([, phrase]) => wrappedPhraseProbe.includes(phrase))) {
  errors.push("release_language_policy_self_test:wrapped_phrase_not_detected");
}

function fallbackRepositoryPaths(directory) {
  const paths = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!excludedDirectories.has(entry.name))
        paths.push(...fallbackRepositoryPaths(resolve(directory, entry.name)));
      continue;
    }
    if (entry.isFile()) paths.push(resolve(directory, entry.name));
  }
  return paths;
}

function repositoryPaths() {
  try {
    const output = execFileSync("git", ["ls-files", "-z"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output
      .split("\0")
      .filter(Boolean)
      .map((path) => resolve(ROOT, path));
  } catch {
    notes.push("git_index_unavailable:scanned_workspace_fallback");
    return fallbackRepositoryPaths(ROOT);
  }
}

function scanLanguage() {
  for (const path of repositoryPaths()) {
    if (!textExtensions.has(extname(path).toLowerCase())) continue;
    const normalized = normalizeLanguage(readFileSync(path, "utf8"));
    for (const [label, phrase] of prohibitedLanguage) {
      if (normalized.includes(phrase)) {
        errors.push(`prohibited_release_language:${label}:${relative(ROOT, path)}`);
      }
    }
  }
}

scanLanguage();

console.log(JSON.stringify({ ok: errors.length === 0, errors, notes }, null, 2));
process.exit(errors.length === 0 ? 0 : 1);
