#!/usr/bin/env node
/**
 * Executable repository gate for Factory Deck.
 *
 * This check validates concrete source controls only. It deliberately does not
 * create or consume readiness manifests or review-status files. Product
 * readiness is grounded in executable evidence from the exact revision.
 */
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname, relative } from "node:path";
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

function decodeUtf32(data, littleEndian, offset = 0) {
  if ((data.length - offset) % 4 !== 0) return null;
  let value = "";
  for (let index = offset; index < data.length; index += 4) {
    const codePoint = littleEndian
      ? data.readUInt32LE(index)
      : data.readUInt32BE(index);
    if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff))
      return null;
    value += String.fromCodePoint(codePoint);
  }
  return value;
}

function decodeUtf16Be(data, offset = 0) {
  if ((data.length - offset) % 2 !== 0) return null;
  const swapped = Buffer.allocUnsafe(data.length - offset);
  for (let index = offset; index < data.length; index += 2) {
    const target = index - offset;
    swapped[target] = data[index + 1];
    swapped[target + 1] = data[index];
  }
  return swapped.toString("utf16le");
}

function looksLikeText(value) {
  if (!value || value.includes("\0")) return false;
  let controls = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 32 && !"\t\r\n".includes(character)) controls += 1;
  }
  return controls / value.length <= 0.05;
}

function uniqueTextCandidates(candidates) {
  return [...new Set(candidates.filter((candidate) => looksLikeText(candidate)))];
}

function decodeRepositoryTexts(data) {
  if (
    data.length >= 4 &&
    data[0] === 0xff &&
    data[1] === 0xfe &&
    data[2] === 0x00 &&
    data[3] === 0x00
  )
    return uniqueTextCandidates([decodeUtf32(data, true, 4)]);
  if (
    data.length >= 4 &&
    data[0] === 0x00 &&
    data[1] === 0x00 &&
    data[2] === 0xfe &&
    data[3] === 0xff
  )
    return uniqueTextCandidates([decodeUtf32(data, false, 4)]);
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe)
    return uniqueTextCandidates([data.subarray(2).toString("utf16le")]);
  if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff)
    return uniqueTextCandidates([decodeUtf16Be(data, 2)]);
  if (!data.includes(0)) return uniqueTextCandidates([data.toString("utf8")]);

  const candidates = [];
  if (data.length % 4 === 0) {
    candidates.push(decodeUtf32(data, true), decodeUtf32(data, false));
  }
  if (data.length % 2 === 0) {
    candidates.push(data.toString("utf16le"), decodeUtf16Be(data));
  }
  // Without a BOM, several byte orders can decode to printable Unicode. Scan
  // every plausible interpretation so a wrong-endian candidate cannot hide a
  // prohibited phrase in the correct interpretation.
  return uniqueTextCandidates(candidates);
}

const wrappedPhraseProbe = normalizeLanguage("manual\napproval");
if (!prohibitedLanguage.some(([, phrase]) => wrappedPhraseProbe.includes(phrase))) {
  errors.push("release_language_policy_self_test:wrapped_phrase_not_detected");
}
const encodedPhraseProbe = "manual " + "approval";
function encodeUtf32(value, littleEndian) {
  return Buffer.concat(
    [...value].map((character) => {
      const encoded = Buffer.alloc(4);
      if (littleEndian) encoded.writeUInt32LE(character.codePointAt(0) ?? 0);
      else encoded.writeUInt32BE(character.codePointAt(0) ?? 0);
      return encoded;
    }),
  );
}

function encodeUtf16Be(value) {
  const littleEndian = Buffer.from(value, "utf16le");
  const bigEndian = Buffer.allocUnsafe(littleEndian.length);
  for (let index = 0; index < littleEndian.length; index += 2) {
    bigEndian[index] = littleEndian[index + 1];
    bigEndian[index + 1] = littleEndian[index];
  }
  return bigEndian;
}

for (const [label, data] of [
  ["utf16le", Buffer.from(encodedPhraseProbe, "utf16le")],
  ["utf16be", encodeUtf16Be(encodedPhraseProbe)],
  ["utf32le", encodeUtf32(encodedPhraseProbe, true)],
  ["utf32be", encodeUtf32(encodedPhraseProbe, false)],
]) {
  const decodedCandidates = decodeRepositoryTexts(data);
  if (
    !decodedCandidates.some((decoded) =>
      normalizeLanguage(decoded).includes("manual " + "approval"),
    )
  ) {
    errors.push(`release_language_policy_self_test:${label}_not_detected`);
  }
}

function fallbackRepositoryPaths(directory) {
  const paths = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!excludedDirectories.has(entry.name))
        paths.push(...fallbackRepositoryPaths(resolve(directory, entry.name)));
      continue;
    }
    if (entry.isFile()) {
      const path = resolve(directory, entry.name);
      paths.push({ path, relativePath: relative(ROOT, path), tracked: false });
    }
  }
  return paths;
}

function repositoryPaths() {
  let gitRoot;
  try {
    gitRoot = resolve(
      execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    );
  } catch {
    notes.push("git_index_unavailable:scanned_workspace_fallback");
    return fallbackRepositoryPaths(ROOT);
  }

  const comparableRoot = process.platform === "win32" ? ROOT.toLowerCase() : ROOT;
  const comparableGitRoot =
    process.platform === "win32" ? gitRoot.toLowerCase() : gitRoot;
  if (comparableGitRoot !== comparableRoot) {
    notes.push("foreign_git_index:scanned_workspace_fallback");
    return fallbackRepositoryPaths(ROOT);
  }

  try {
    const output = execFileSync("git", ["ls-files", "-z"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const paths = output
      .split("\0")
      .filter(Boolean)
      .map((relativePath) => ({
        path: resolve(ROOT, relativePath),
        relativePath,
        tracked: true,
      }));
    if (paths.length === 0) {
      errors.push("git_index_empty:exact_repository_has_no_tracked_files");
      return [];
    }
    return paths;
  } catch {
    errors.push("git_index_unreadable:exact_repository_cannot_be_scanned");
    return [];
  }
}

function readRepositoryEntry(entry) {
  if (existsSync(entry.path) && lstatSync(entry.path).isFile()) {
    return readFileSync(entry.path);
  }
  if (!entry.tracked) return null;
  try {
    return execFileSync("git", ["show", `:${entry.relativePath}`], {
      cwd: ROOT,
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    errors.push(`tracked_blob_unavailable:${entry.relativePath}`);
    return null;
  }
}

function scanLanguage() {
  for (const entry of repositoryPaths()) {
    const data = readRepositoryEntry(entry);
    if (data === null) continue;
    const normalizedCandidates = decodeRepositoryTexts(data).map((text) =>
      normalizeLanguage(text),
    );
    if (normalizedCandidates.length === 0) continue;
    for (const [label, phrase] of prohibitedLanguage) {
      if (normalizedCandidates.some((normalized) => normalized.includes(phrase))) {
        errors.push(`prohibited_release_language:${label}:${entry.relativePath}`);
      }
    }
  }
}

scanLanguage();

console.log(JSON.stringify({ ok: errors.length === 0, errors, notes }, null, 2));
process.exit(errors.length === 0 ? 0 : 1);
