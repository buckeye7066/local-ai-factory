#!/usr/bin/env node
/**
 * Executable repository gate for Factory Deck.
 *
 * This check validates concrete source controls only. It deliberately does not
 * create or consume readiness manifests or review-status files. Product
 * readiness is grounded in executable evidence from the exact revision.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
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

function scanLanguage(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!excludedDirectories.has(entry.name))
        scanLanguage(resolve(directory, entry.name));
      continue;
    }
    if (!entry.isFile() || !textExtensions.has(extname(entry.name).toLowerCase()))
      continue;
    const path = resolve(directory, entry.name);
    const lines = readFileSync(path, "utf8").split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const normalized = line.toLowerCase().replace(/[-_]+/g, " ");
      for (const [label, phrase] of prohibitedLanguage) {
        if (normalized.includes(phrase)) {
          errors.push(
            `prohibited_release_language:${label}:${relative(ROOT, path)}:${index + 1}`,
          );
        }
      }
    }
  }
}

scanLanguage(ROOT);

console.log(JSON.stringify({ ok: errors.length === 0, errors, notes }, null, 2));
process.exit(errors.length === 0 ? 0 : 1);
