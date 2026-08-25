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
const phrase = (...codePoints) => String.fromCodePoint(...codePoints);
const prohibitedLanguage = [
  ["organizational_gate", phrase(115, 105, 103, 110, 32, 111, 102, 102)],
  ["organizational_gate_compact", phrase(115, 105, 103, 110, 111, 102, 102)],
  [
    "organizational_gate_third_person",
    phrase(115, 105, 103, 110, 115, 32, 111, 102, 102),
  ],
  [
    "organizational_gate_gerund",
    phrase(115, 105, 103, 110, 105, 110, 103, 32, 111, 102, 102),
  ],
  ["organizational_gate_plural", phrase(115, 105, 103, 110, 32, 111, 102, 102, 115)],
  [
    "organizational_gate_compact_plural",
    phrase(115, 105, 103, 110, 111, 102, 102, 115),
  ],
  [
    "completed_organizational_gate",
    phrase(115, 105, 103, 110, 101, 100, 32, 111, 102, 102),
  ],
  [
    "identity_gate",
    phrase(
      97,
      117,
      116,
      104,
      101,
      110,
      116,
      105,
      99,
      97,
      116,
      101,
      100,
      32,
      114,
      101,
      118,
      105,
      101,
      119,
      101,
      114,
    ),
  ],
  [
    "mandatory_reviewer_gate",
    phrase(
      114,
      101,
      113,
      117,
      105,
      114,
      101,
      100,
      32,
      114,
      101,
      118,
      105,
      101,
      119,
      101,
      114,
    ),
  ],
  ["person_gate", phrase(104, 117, 109, 97, 110, 32, 114, 101, 118, 105, 101, 119)],
  [
    "manual_gate",
    phrase(109, 97, 110, 117, 97, 108, 32, 97, 112, 112, 114, 111, 118, 97, 108),
  ],
  [
    "implementation_readiness_claim",
    phrase(115, 101, 108, 102, 32, 99, 101, 114, 116, 105, 102),
  ],
  [
    "main_revision_label",
    phrase(99, 101, 114, 116, 105, 102, 105, 101, 100, 32, 109, 97, 105, 110),
  ],
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
  let replacements = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 32 && !"\t\r\n".includes(character)) controls += 1;
    if (codePoint === 0xfffd) replacements += 1;
  }
  return controls / value.length <= 0.05 && replacements / value.length <= 0.02;
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

const renderedSourceExtensions = new Set([
  ".htm",
  ".html",
  ".js",
  ".jsx",
  ".mdx",
  ".svelte",
  ".ts",
  ".tsx",
  ".vue",
]);

function sourceExtension(relativePath) {
  const match = /(?:^|\/)(?:[^/]+)(\.[^./]+)$/.exec(relativePath.toLowerCase());
  return match?.[1] ?? "";
}

function unquoteStaticLiteral(literal) {
  return literal
    .slice(1, -1)
    .replace(
      /\\(?:r\\n|n|r|t)/g,
      (escape) =>
        ({ "\\n": "\n", "\\r": "\r", "\\t": "\t", "\\r\\n": "\r\n" })[escape] ?? escape,
    )
    .replace(/\\(["'`\\])/g, "$1");
}

function renderedSourceCandidates(value, relativePath) {
  if (!renderedSourceExtensions.has(sourceExtension(relativePath))) return [];
  const candidates = [value.replace(/<\s*\/?\s*[A-Za-z][^>]*>/g, " ")];
  const literalPattern = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/gs;
  let previous = null;
  for (const match of value.matchAll(literalPattern)) {
    if (previous && /^\s*\+\s*$/.test(value.slice(previous.end, match.index))) {
      candidates.push(
        unquoteStaticLiteral(previous.literal) + unquoteStaticLiteral(match[0]),
      );
    }
    previous = { literal: match[0], end: (match.index ?? 0) + match[0].length };
  }
  return candidates;
}

const wrappedPhraseProbe = normalizeLanguage("manual\napproval");
if (!prohibitedLanguage.some(([, phrase]) => wrappedPhraseProbe.includes(phrase))) {
  errors.push("release_language_policy_self_test:wrapped_phrase_not_detected");
}
const thirdPersonProbe = normalizeLanguage(
  phrase(111, 119, 110, 101, 114, 32, 115, 105, 103, 110, 115, 32, 111, 102, 102),
);
if (!prohibitedLanguage.some(([, value]) => thirdPersonProbe.includes(value))) {
  errors.push("release_language_policy_self_test:third_person_phrase_not_detected");
}
const encodedPhraseProbe = phrase(
  109,
  97,
  110,
  117,
  97,
  108,
  32,
  97,
  112,
  112,
  114,
  111,
  118,
  97,
  108,
);
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
      normalizeLanguage(decoded).includes(encodedPhraseProbe),
    )
  ) {
    errors.push(`release_language_policy_self_test:${label}_not_detected`);
  }
}
const replacementHeavyBinaryProbe = Buffer.concat([
  Buffer.alloc(128, 0xff),
  Buffer.from(encodedPhraseProbe, "utf8"),
]);
if (decodeRepositoryTexts(replacementHeavyBinaryProbe).length !== 0) {
  errors.push("release_language_policy_self_test:binary_blob_misclassified");
}

const probeFirstWord = phrase(109, 97, 110, 117, 97, 108);
const probeSecondWord = phrase(97, 112, 112, 114, 111, 118, 97, 108);
for (const [label, source] of [
  ["jsx_boundary", `<span>${probeFirstWord}</span><span>${probeSecondWord}</span>`],
  ["string_concatenation", `"${probeFirstWord}" + " ${probeSecondWord}"`],
]) {
  if (
    !renderedSourceCandidates(source, "probe.jsx").some((candidate) =>
      normalizeLanguage(candidate).includes(encodedPhraseProbe),
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
    const normalizedCandidates = decodeRepositoryTexts(data).flatMap((text) =>
      [text, ...renderedSourceCandidates(text, entry.relativePath)].map((candidate) =>
        normalizeLanguage(candidate),
      ),
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
