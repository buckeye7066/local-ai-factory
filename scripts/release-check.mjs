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
const errors = [];
const notes = [];

function selectRepositorySource() {
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
    return { type: "workspace", note: "git_index_unavailable" };
  }

  const comparableRoot = process.platform === "win32" ? ROOT.toLowerCase() : ROOT;
  const comparableGitRoot =
    process.platform === "win32" ? gitRoot.toLowerCase() : gitRoot;
  if (comparableGitRoot !== comparableRoot) {
    return { type: "workspace", note: "foreign_git_index" };
  }
  return { type: "index", note: null };
}

const repositorySource = selectRepositorySource();

function readSelectedRepositoryPath(relativePath) {
  if (repositorySource.type === "index") {
    try {
      return execFileSync("git", ["show", `:${relativePath}`], {
        cwd: ROOT,
        encoding: "buffer",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return null;
    }
  }
  const path = resolve(ROOT, relativePath);
  if (!existsSync(path) || !lstatSync(path).isFile()) return null;
  return readFileSync(path);
}

const required = [
  ["purpose_contract", "docs/purpose-contract.md"],
  ["production_readiness_workflow", ".github/workflows/production-readiness.yml"],
  ["provider_timeout_regression", "src/server/__tests__/providerAbort.test.ts"],
  ["anthropic_provider", "src/server/providers/anthropicProvider.ts"],
  ["openai_provider", "src/server/providers/openaiProvider.ts"],
  ["package", "package.json"],
];

for (const [label, relativePath] of required) {
  if (readSelectedRepositoryPath(relativePath) === null)
    errors.push(`missing_required:${label}:${relativePath}`);
  else notes.push(`present:${label}`);
}

const packageData = readSelectedRepositoryPath("package.json");
if (packageData !== null) {
  try {
    const pkg = JSON.parse(packageData.toString("utf8"));
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
  if (readSelectedRepositoryPath(forbidden) !== null) {
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
    "identity_gate_plural",
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
      115,
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
  [
    "mandatory_reviewer_gate_plural",
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
      115,
    ),
  ],
  ["person_gate", phrase(104, 117, 109, 97, 110, 32, 114, 101, 118, 105, 101, 119)],
  [
    "person_gate_plural",
    phrase(104, 117, 109, 97, 110, 32, 114, 101, 118, 105, 101, 119, 115),
  ],
  [
    "manual_gate",
    phrase(109, 97, 110, 117, 97, 108, 32, 97, 112, 112, 114, 111, 118, 97, 108),
  ],
  [
    "manual_gate_plural",
    phrase(109, 97, 110, 117, 97, 108, 32, 97, 112, 112, 114, 111, 118, 97, 108, 115),
  ],
  [
    "implementation_readiness_claim_past_tense",
    phrase(115, 101, 108, 102, 32, 99, 101, 114, 116, 105, 102, 105, 101, 100),
  ],
  [
    "implementation_readiness_claim_noun",
    phrase(
      115,
      101,
      108,
      102,
      32,
      99,
      101,
      114,
      116,
      105,
      102,
      105,
      99,
      97,
      116,
      105,
      111,
      110,
    ),
  ],
  [
    "main_revision_label",
    phrase(99, 101, 114, 116, 105, 102, 105, 101, 100, 32, 109, 97, 105, 110),
  ],
];

function normalizeLanguage(value) {
  return value
    .toLowerCase()
    .replace(/\p{Cf}+/gu, "")
    .replace(/[-_\s]+/g, " ");
}

function isWordCharacter(value) {
  return value !== undefined && /[\p{L}\p{N}_]/u.test(value);
}

function codePointBefore(value, index) {
  if (index <= 0) return undefined;
  const last = value.charCodeAt(index - 1);
  if (last >= 0xdc00 && last <= 0xdfff && index >= 2) {
    const first = value.charCodeAt(index - 2);
    if (first >= 0xd800 && first <= 0xdbff) return value.slice(index - 2, index);
  }
  return value[index - 1];
}

function codePointAfter(value, index) {
  if (index >= value.length) return undefined;
  const codePoint = value.codePointAt(index);
  return codePoint === undefined ? undefined : String.fromCodePoint(codePoint);
}

function containsLanguagePhrase(value, target) {
  let offset = 0;
  while (offset <= value.length - target.length) {
    const index = value.indexOf(target, offset);
    if (index < 0) return false;
    const before = codePointBefore(value, index);
    const after = codePointAfter(value, index + target.length);
    if (!isWordCharacter(before) && !isWordCharacter(after)) return true;
    offset = index + 1;
  }
  return false;
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

const literalSourceExtensions = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".svelte",
  ".ts",
  ".tsx",
  ".vue",
]);
const markupSourceExtensions = new Set([
  ".htm",
  ".html",
  ".jsx",
  ".mdx",
  ".svelte",
  ".tsx",
  ".vue",
]);
const markdownSourceExtensions = new Set([".md", ".mdx"]);

const namedHtmlCharacterReferences = new Map([
  ["Tab", "\t"],
  ["NewLine", "\n"],
  ["nbsp", "\u00a0"],
  ["NonBreakingSpace", "\u00a0"],
  ["ensp", "\u2002"],
  ["emsp", "\u2003"],
  ["emsp13", "\u2004"],
  ["emsp14", "\u2005"],
  ["numsp", "\u2007"],
  ["puncsp", "\u2008"],
  ["thinsp", "\u2009"],
  ["ThinSpace", "\u2009"],
  ["hairsp", "\u200a"],
  ["VeryThinSpace", "\u200a"],
  ["MediumSpace", "\u205f"],
  ["ThickSpace", "\u205f\u200a"],
  ["NegativeVeryThinSpace", "\u200b"],
  ["NegativeThinSpace", "\u200b"],
  ["NegativeMediumSpace", "\u200b"],
  ["NegativeThickSpace", "\u200b"],
  ["ZeroWidthSpace", "\u200b"],
  ["NoBreak", "\u2060"],
  ["zwnj", "\u200c"],
  ["zwj", "\u200d"],
  ["lrm", "\u200e"],
  ["rlm", "\u200f"],
  ["amp", "&"],
  ["AMP", "&"],
  ["apos", "'"],
  ["gt", ">"],
  ["GT", ">"],
  ["lt", "<"],
  ["LT", "<"],
  ["quot", '"'],
  ["QUOT", '"'],
]);

const semicolonOptionalHtmlReferences = new Map(
  ["amp", "AMP", "gt", "GT", "lt", "LT", "nbsp", "quot", "QUOT"].map((name) => [
    name,
    namedHtmlCharacterReferences.get(name),
  ]),
);

function decodeHtmlCharacterReferences(value) {
  const numericDecoded = value.replace(
    /&#(?:[xX]([0-9A-Fa-f]+)|(\d+));?/g,
    (match, hexadecimal, decimal) => {
      const codePoint = Number.parseInt(
        hexadecimal ?? decimal,
        hexadecimal === undefined ? 10 : 16,
      );
      if (
        !Number.isInteger(codePoint) ||
        codePoint <= 0 ||
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)
      )
        return "\ufffd";
      return String.fromCodePoint(codePoint);
    },
  );
  const namedDecoded = numericDecoded.replace(
    /&([A-Za-z][A-Za-z0-9]+);/g,
    (match, named) => namedHtmlCharacterReferences.get(named) ?? match,
  );
  return namedDecoded.replace(
    /&(amp|AMP|gt|GT|lt|LT|nbsp|quot|QUOT)(?=[\s<&]|$)/g,
    (match, named) => semicolonOptionalHtmlReferences.get(named) ?? match,
  );
}

function sourceExtension(relativePath) {
  const match = /(?:^|\/)(?:[^/]+)(\.[^./]+)$/.exec(relativePath.toLowerCase());
  return match?.[1] ?? "";
}

function unquoteStaticLiteral(literal) {
  return literal
    .slice(1, -1)
    .replace(
      /\\u\{([0-9A-Fa-f]{1,6})\}|\\u([0-9A-Fa-f]{4})|\\x([0-9A-Fa-f]{2})|\\(?:\r\n|[\n\r])|\\([0btnvfr"'`\\])/g,
      (escape, bracedUnicode, fixedUnicode, hexadecimal, simple) => {
        if (bracedUnicode !== undefined) {
          const codePoint = Number.parseInt(bracedUnicode, 16);
          if (codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff))
            return String.fromCodePoint(codePoint);
          return escape;
        }
        if (fixedUnicode !== undefined)
          return String.fromCharCode(Number.parseInt(fixedUnicode, 16));
        if (hexadecimal !== undefined)
          return String.fromCharCode(Number.parseInt(hexadecimal, 16));
        if (simple !== undefined)
          return (
            {
              0: "\0",
              b: "\b",
              t: "\t",
              n: "\n",
              v: "\v",
              f: "\f",
              r: "\r",
              '"': '"',
              "'": "'",
              "`": "`",
              "\\": "\\",
            }[simple] ?? simple
          );
        return "";
      },
    );
}

function stripMarkupNodes(value) {
  return value
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s+[^<>]*?)?\s*\/?>/gs, " ");
}

function renderMarkdown(value) {
  return stripMarkupNodes(value)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*~`]+/g, "");
}

function renderedSourceCandidates(value, relativePath) {
  const extension = sourceExtension(relativePath);
  const candidates = [];
  if (markupSourceExtensions.has(extension))
    candidates.push(decodeHtmlCharacterReferences(stripMarkupNodes(value)));
  if (markdownSourceExtensions.has(extension))
    candidates.push(decodeHtmlCharacterReferences(renderMarkdown(value)));
  if (!literalSourceExtensions.has(extension)) return candidates;

  const literalPattern = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/gs;
  let previous = null;
  let chain = null;
  for (const match of value.matchAll(literalPattern)) {
    const renderedLiteral = unquoteStaticLiteral(match[0]);
    candidates.push(renderedLiteral);
    if (previous && /^\s*\+\s*$/.test(value.slice(previous.end, match.index))) {
      chain = (chain ?? unquoteStaticLiteral(previous.literal)) + renderedLiteral;
      candidates.push(chain);
    } else {
      chain = null;
    }
    previous = { literal: match[0], end: (match.index ?? 0) + match[0].length };
  }
  return candidates;
}

const wrappedPhraseProbe = normalizeLanguage(
  phrase(109, 97, 110, 117, 97, 108, 10, 97, 112, 112, 114, 111, 118, 97, 108),
);
if (
  !prohibitedLanguage.some(([, phrase]) =>
    containsLanguagePhrase(wrappedPhraseProbe, phrase),
  )
) {
  errors.push("release_language_policy_self_test:wrapped_phrase_not_detected");
}
const thirdPersonProbe = normalizeLanguage(
  phrase(111, 119, 110, 101, 114, 32, 115, 105, 103, 110, 115, 32, 111, 102, 102),
);
if (
  !prohibitedLanguage.some(([, value]) =>
    containsLanguagePhrase(thirdPersonProbe, value),
  )
) {
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
      containsLanguagePhrase(normalizeLanguage(decoded), encodedPhraseProbe),
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
const compactOrganizationalProbe = phrase(115, 105, 103, 110, 111, 102, 102);
for (const [label, source, relativePath, target] of [
  [
    "jsx_boundary",
    `<span>${probeFirstWord}</span><span>${probeSecondWord}</span>`,
    "probe.jsx",
    encodedPhraseProbe,
  ],
  [
    "string_concatenation",
    `"${probeFirstWord}" + " " + "${probeSecondWord}"`,
    "probe.js",
    encodedPhraseProbe,
  ],
  [
    "unicode_escape",
    `"${probeFirstWord}" + "\\u0020" + "${probeSecondWord}"`,
    "probe.js",
    encodedPhraseProbe,
  ],
  [
    "html_numeric_entity",
    `${probeFirstWord}&#32;${probeSecondWord}`,
    "probe.html",
    encodedPhraseProbe,
  ],
  [
    "html_named_entity",
    `<span>${probeFirstWord}</span>&nbsp;<span>${probeSecondWord}</span>`,
    "probe.html",
    encodedPhraseProbe,
  ],
  [
    "html_legacy_entity_without_semicolon",
    `<span>${probeFirstWord}&nbsp ${probeSecondWord}</span>`,
    "probe.html",
    encodedPhraseProbe,
  ],
  [
    "html_comment",
    `<p>${phrase(115, 105, 103, 110)}<!-- split -->${phrase(111, 102, 102)}</p>`,
    "probe.html",
    compactOrganizationalProbe,
  ],
  [
    "markdown_emphasis",
    `${probeFirstWord} **${probeSecondWord}**`,
    "probe.md",
    encodedPhraseProbe,
  ],
]) {
  if (
    !renderedSourceCandidates(source, relativePath).some((candidate) =>
      containsLanguagePhrase(normalizeLanguage(candidate), target),
    )
  ) {
    errors.push(`release_language_policy_self_test:${label}_not_detected`);
  }
}

const pluralManualProbe = normalizeLanguage(encodedPhraseProbe + phrase(115));
if (
  !prohibitedLanguage.some(([, value]) =>
    containsLanguagePhrase(pluralManualProbe, value),
  )
) {
  errors.push("release_language_policy_self_test:plural_phrase_not_detected");
}

const benignBoundaryProbe = normalizeLanguage("Assign officer duties");
if (
  prohibitedLanguage.some(([, value]) =>
    containsLanguagePhrase(benignBoundaryProbe, value),
  )
) {
  errors.push("release_language_policy_self_test:lexical_boundary_false_positive");
}

for (const [label, value] of [
  ["unicode_prefix", String.fromCodePoint(0x10400) + compactOrganizationalProbe],
  ["unicode_suffix", compactOrganizationalProbe + String.fromCodePoint(0x10400)],
]) {
  if (containsLanguagePhrase(normalizeLanguage(value), compactOrganizationalProbe)) {
    errors.push(`release_language_policy_self_test:${label}_boundary_false_positive`);
  }
}

const comparisonProbe = `${phrase(115, 105, 103, 110)} < threshold > ${phrase(
  111,
  102,
  102,
)}`;
if (
  renderedSourceCandidates(comparisonProbe, "probe.js").some((candidate) =>
    containsLanguagePhrase(
      normalizeLanguage(candidate),
      phrase(115, 105, 103, 110, 32, 111, 102, 102),
    ),
  )
) {
  errors.push("release_language_policy_self_test:comparison_misclassified_as_markup");
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
  if (repositorySource.type !== "index") {
    notes.push(`${repositorySource.note}:scanned_workspace_fallback`);
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
  if (entry.tracked) {
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
  if (existsSync(entry.path) && lstatSync(entry.path).isFile()) {
    return readFileSync(entry.path);
  }
  return null;
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
      if (
        normalizedCandidates.some((normalized) =>
          containsLanguagePhrase(normalized, phrase),
        )
      ) {
        errors.push(`prohibited_release_language:${label}:${entry.relativePath}`);
      }
    }
  }
}

scanLanguage();

console.log(JSON.stringify({ ok: errors.length === 0, errors, notes }, null, 2));
process.exit(errors.length === 0 ? 0 : 1);
