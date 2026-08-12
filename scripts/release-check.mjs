#!/usr/bin/env node
/**
 * Executable repository gate for Factory Deck.
 *
 * This check validates concrete source controls only. It deliberately does not
 * create or consume readiness manifests, attestations, or review-status files.
 * Product readiness is not self-certified by an implementation script.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
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
    errors.push(`invalid_package_json:${error instanceof Error ? error.message : String(error)}`);
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

console.log(JSON.stringify({ ok: errors.length === 0, errors, notes }, null, 2));
process.exit(errors.length === 0 ? 0 : 1);
