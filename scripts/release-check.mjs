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
  let hasGitMetadata = false;
  try {
    lstatSync(resolve(ROOT, ".git"));
    hasGitMetadata = true;
  } catch {
    // An exported tree has no repository metadata and may use workspace mode.
  }
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
    return hasGitMetadata
      ? { type: "error", note: "git_index_unavailable" }
      : { type: "workspace", note: "git_index_unavailable" };
  }

  const comparableRoot = process.platform === "win32" ? ROOT.toLowerCase() : ROOT;
  const comparableGitRoot =
    process.platform === "win32" ? gitRoot.toLowerCase() : gitRoot;
  if (comparableGitRoot !== comparableRoot) {
    return hasGitMetadata
      ? { type: "error", note: "foreign_git_index" }
      : { type: "workspace", note: "foreign_git_index" };
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
  ["html_named_references", "scripts/html-named-character-references.json"],
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

const excludedDirectories = new Set([".git"]);
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
  return [...value.normalize("NFKC")]
    .filter((character) => !isDefaultIgnorable(character))
    .join("")
    .toLowerCase()
    .replace(/[-_\s]+/g, " ");
}

const defaultIgnorableRanges = [
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff0, 0xfff8],
  [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a],
  [0xe0000, 0xe0fff],
];

function isDefaultIgnorable(character) {
  const codePoint = character.codePointAt(0) ?? 0;
  return (
    /\p{Cf}/u.test(character) ||
    defaultIgnorableRanges.some(
      ([first, last]) => first <= codePoint && codePoint <= last,
    )
  );
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
  let value = "";
  const completeLength = data.length - ((data.length - offset) % 4);
  for (let index = offset; index < completeLength; index += 4) {
    const codePoint = littleEndian
      ? data.readUInt32LE(index)
      : data.readUInt32BE(index);
    if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff))
      value += "\ufffd";
    else value += String.fromCodePoint(codePoint);
  }
  if (completeLength !== data.length) value += "\ufffd";
  return value;
}

function decodeUtf16Be(data, offset = 0) {
  const completeLength = data.length - ((data.length - offset) % 2);
  const swapped = Buffer.allocUnsafe(completeLength - offset);
  for (let index = offset; index < completeLength; index += 2) {
    const target = index - offset;
    swapped[target] = data[index + 1];
    swapped[target + 1] = data[index];
  }
  return swapped.toString("utf16le") + (completeLength === data.length ? "" : "\ufffd");
}

function looksLikeText(value) {
  if (!value) return false;
  let controls = 0;
  let replacements = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 32 && !"\t\r\n".includes(character)) controls += 1;
    if (codePoint === 0xfffd) replacements += 1;
  }
  const controlLimit = Math.max(1, Math.floor(value.length / 20));
  const replacementLimit = Math.max(1, Math.floor(value.length / 50));
  return controls <= controlLimit && replacements <= replacementLimit;
}

function uniqueTextCandidates(candidates, retainedCandidates = []) {
  return [
    ...new Set([
      ...retainedCandidates.filter((candidate) => candidate !== null),
      ...candidates.filter((candidate) => looksLikeText(candidate)),
    ]),
  ];
}

const binarySourceExtensions = new Set([
  ".7z",
  ".a",
  ".avi",
  ".bmp",
  ".bz2",
  ".class",
  ".dll",
  ".dylib",
  ".eot",
  ".exe",
  ".flac",
  ".gif",
  ".gz",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".m4a",
  ".mov",
  ".mp3",
  ".mp4",
  ".o",
  ".ogg",
  ".otf",
  ".pdf",
  ".png",
  ".so",
  ".tar",
  ".tgz",
  ".ttf",
  ".wav",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".xz",
  ".zip",
]);

function shouldRetainUtf8(relativePath) {
  return (
    Boolean(relativePath) && !binarySourceExtensions.has(sourceExtension(relativePath))
  );
}

function decodeRepositoryTexts(data, relativePath = "") {
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
  const utf8 = data.toString("utf8");
  const candidates = [utf8];
  const retainedUtf8 = shouldRetainUtf8(relativePath) ? [utf8] : [];
  if (!data.includes(0)) return uniqueTextCandidates(candidates, retainedUtf8);

  if (data.length % 4 === 0) {
    candidates.push(decodeUtf32(data, true), decodeUtf32(data, false));
  }
  if (data.length % 2 === 0) {
    candidates.push(data.toString("utf16le"), decodeUtf16Be(data));
  }
  // Without a BOM, several byte orders can decode to printable Unicode. Scan
  // every plausible interpretation so a wrong-endian candidate cannot hide a
  // prohibited phrase in the correct interpretation.
  return uniqueTextCandidates(candidates, retainedUtf8);
}

const literalSourceExtensions = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".json",
  ".mjs",
  ".mts",
  ".py",
  ".pyw",
  ".svelte",
  ".ts",
  ".tsx",
  ".vue",
]);
const cssSourceExtensions = new Set([".css", ".less", ".sass", ".scss"]);
const markupSourceExtensions = new Set([
  ".htm",
  ".html",
  ".jsx",
  ".mdx",
  ".svg",
  ".svelte",
  ".tsx",
  ".vue",
  ".xht",
  ".xhtml",
]);
const jsxSourceExtensions = new Set([".jsx", ".mdx", ".tsx"]);
const markdownSourceExtensions = new Set([".md", ".mdx"]);
const typescriptSourceExtensions = new Set([".cts", ".mts", ".ts", ".tsx"]);

let namedHtmlCharacterReferences = new Map();
let legacyHtmlCharacterReferenceNames = [];
const namedHtmlReferenceData = readSelectedRepositoryPath(
  "scripts/html-named-character-references.json",
);
if (namedHtmlReferenceData !== null) {
  try {
    const parsedReferences = JSON.parse(namedHtmlReferenceData.toString("utf8"));
    const namedReferences = parsedReferences.entities ?? parsedReferences;
    namedHtmlCharacterReferences = new Map(Object.entries(namedReferences));
    legacyHtmlCharacterReferenceNames = Array.isArray(parsedReferences.legacy)
      ? parsedReferences.legacy.filter((name) => namedHtmlCharacterReferences.has(name))
      : ["amp", "AMP", "gt", "GT", "lt", "LT", "nbsp", "quot", "QUOT"];
  } catch (error) {
    errors.push(
      `invalid_html_named_references:${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const legacyHtmlCharacterReferencePattern = new RegExp(
  `&(${legacyHtmlCharacterReferenceNames
    .toSorted((left, right) => right.length - left.length || left.localeCompare(right))
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})`,
  "g",
);

function decodeHtmlCharacterReferences(value, inAttribute = false) {
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
    legacyHtmlCharacterReferencePattern,
    (match, named, offset, input) => {
      const nextCharacter = input[offset + match.length] ?? "";
      if (inAttribute && /[A-Za-z0-9=]/.test(nextCharacter)) return match;
      return namedHtmlCharacterReferences.get(named) ?? match;
    },
  );
}

function sourceExtension(relativePath) {
  const match = /(?:^|\/)(?:[^/]+)(\.[^./]+)$/.exec(relativePath.toLowerCase());
  return match?.[1] ?? "";
}

function unquoteStaticLiteral(literal) {
  const allowsLegacyOctal = !literal.startsWith("`");
  return literal
    .slice(1, -1)
    .replace(
      /\\u\{(0*[0-9A-Fa-f]{1,6})\}|\\u([0-9A-Fa-f]{4})|\\x([0-9A-Fa-f]{2})|\\([0-3][0-7]{0,2}|[4-7][0-7]?)|\\(?:\r\n|[\n\r\u2028\u2029])|\\(0|[^\d\r\n\u2028\u2029])/g,
      (escape, bracedUnicode, fixedUnicode, hexadecimal, octal, simple) => {
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
        if (octal !== undefined)
          return allowsLegacyOctal
            ? String.fromCodePoint(Number.parseInt(octal, 8))
            : escape;
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

function renderStaticLiteral(literal) {
  if (!literal.startsWith("`")) return unquoteStaticLiteral(literal);
  return renderStaticTemplateLiteral(literal);
}

function scanJavascriptLiteral(value, start) {
  const delimiter = value[start];
  if (!['"', "'", "`"].includes(delimiter)) return null;
  let index = 0;
  let braceDepth = 0;
  index = start + 1;
  while (index < value.length) {
    if (value[index] === "\\") {
      index += value[index + 1] === "\r" && value[index + 2] === "\n" ? 3 : 2;
      continue;
    }
    if (value[index] === delimiter && (delimiter !== "`" || braceDepth === 0))
      return { literal: value.slice(start, index + 1), end: index + 1 };
    if (delimiter === "`" && value.startsWith("${", index)) {
      braceDepth += 1;
      index += 2;
      continue;
    }
    if (delimiter === "`" && braceDepth > 0) {
      if (value.startsWith("/*", index)) {
        const end = value.indexOf("*/", index + 2);
        if (end < 0) return null;
        index = end + 2;
        continue;
      }
      if (value.startsWith("//", index)) {
        const terminator = /[\r\n\u2028\u2029]/u.exec(value.slice(index + 2));
        index = terminator
          ? index + 2 + (terminator.index ?? 0) + terminator[0].length
          : value.length;
        continue;
      }
      if (['"', "'", "`"].includes(value[index])) {
        const nested = scanJavascriptLiteral(value, index);
        if (!nested) return null;
        index = nested.end;
        continue;
      }
      if (value[index] === "{") braceDepth += 1;
      else if (value[index] === "}") braceDepth -= 1;
    }
    index += 1;
  }
  return null;
}

function findTemplateExpressionEnd(value, start) {
  let braces = 1;
  let index = start;
  while (index < value.length) {
    if (value.startsWith("/*", index)) {
      const end = value.indexOf("*/", index + 2);
      if (end < 0) return -1;
      index = end + 2;
      continue;
    }
    if (value.startsWith("//", index)) {
      const terminator = /[\r\n\u2028\u2029]/u.exec(value.slice(index + 2));
      index = terminator
        ? index + 2 + (terminator.index ?? 0) + terminator[0].length
        : value.length;
      continue;
    }
    if (['"', "'", "`"].includes(value[index])) {
      const literal = scanJavascriptLiteral(value, index);
      if (!literal) return -1;
      index = literal.end;
      continue;
    }
    if (value[index] === "{") braces += 1;
    else if (value[index] === "}" && --braces === 0) return index;
    index += 1;
  }
  return -1;
}

function renderConstantJavascriptExpression(expression) {
  const rendered = [];
  let parentheses = 0;
  let expectOperand = true;
  let index = 0;
  while (index < expression.length) {
    const character = expression[index];
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (expression.startsWith("/*", index)) {
      const end = expression.indexOf("*/", index + 2);
      if (end < 0) return null;
      index = end + 2;
      continue;
    }
    if (expression.startsWith("//", index)) {
      const remainder = expression.slice(index + 2);
      const terminator = /[\r\n\u2028\u2029]/u.exec(remainder);
      if (terminator === null) return null;
      index += 2 + (terminator.index ?? 0) + terminator[0].length;
      continue;
    }
    if (character === "(") {
      parentheses += 1;
      index += 1;
      continue;
    }
    if (character === ")") {
      if (parentheses === 0 || expectOperand) return null;
      parentheses -= 1;
      index += 1;
      continue;
    }
    if (character === "+") {
      if (expectOperand) return null;
      expectOperand = true;
      index += 1;
      continue;
    }
    if (!expectOperand || !['"', "'", "`"].includes(character)) return null;
    const literal = scanJavascriptLiteral(expression, index);
    if (!literal) return null;
    const value = renderStaticLiteral(literal.literal);
    if (value === null) return null;
    rendered.push(value);
    expectOperand = false;
    index = literal.end;
  }
  return !expectOperand && parentheses === 0 ? rendered.join("") : null;
}

function renderStaticTemplateLiteral(literal) {
  let renderedBody = "";
  let index = 1;
  while (index < literal.length - 1) {
    if (literal[index] === "\\") {
      const width = literal[index + 1] === "\r" && literal[index + 2] === "\n" ? 3 : 2;
      renderedBody += literal.slice(index, index + width);
      index += width;
      continue;
    }
    if (literal.startsWith("${", index)) {
      const end = findTemplateExpressionEnd(literal, index + 2);
      if (end < 0) return null;
      const expression = renderConstantJavascriptExpression(
        literal.slice(index + 2, end),
      );
      if (expression === null) return null;
      renderedBody += expression
        .replaceAll("\\", "\\\\")
        .replaceAll("`", "\\`")
        .replaceAll("${", "\\${");
      index = end + 1;
      continue;
    }
    renderedBody += literal[index];
    index += 1;
  }
  return unquoteStaticLiteral(`\`${renderedBody}\``);
}

function decodeCssString(literal) {
  return literal
    .slice(1, -1)
    .replace(
      /\\([0-9A-Fa-f]{1,6})(?:\r\n|[\t\n\f\r ])?|\\(?:\r\n|[\n\f\r])|\\([\s\S])/g,
      (escape, hexadecimal, escapedCharacter) => {
        if (hexadecimal !== undefined) {
          const codePoint = Number.parseInt(hexadecimal, 16);
          if (
            codePoint > 0 &&
            codePoint <= 0x10ffff &&
            !(codePoint >= 0xd800 && codePoint <= 0xdfff)
          )
            return String.fromCodePoint(codePoint);
          return "\ufffd";
        }
        return escapedCharacter ?? "";
      },
    );
}

function renderStaticSassString(literal) {
  return decodeCssString(literal).replace(
    /#\{\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*\}/gs,
    (interpolation, staticLiteral) => decodeCssString(staticLiteral),
  );
}

function renderCssContent(value, extension = "") {
  const candidates = [];
  const withoutComments = stripCssComments(value);
  const stringPattern = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/gs;
  for (const declaration of cssContentDeclarationValues(withoutComments)) {
    for (const branch of splitCssAlternativeContent(declaration)) {
      const urlRanges = cssUrlArgumentRanges(branch);
      let chain = "";
      let previousEnd = null;
      for (const literal of branch.matchAll(stringPattern)) {
        if (
          urlRanges.some(
            ([start, end]) =>
              start <= (literal.index ?? -1) && (literal.index ?? -1) < end,
          )
        )
          continue;
        const rendered =
          extension === ".sass" || extension === ".scss"
            ? renderStaticSassString(literal[0])
            : decodeCssString(literal[0]);
        candidates.push(rendered);
        const start = literal.index ?? 0;
        chain =
          previousEnd !== null && /^\s*$/u.test(branch.slice(previousEnd, start))
            ? chain + rendered
            : rendered;
        if (chain !== rendered) candidates.push(chain);
        previousEnd = start + literal[0].length;
      }
    }
  }
  return candidates;
}

function cssUrlArgumentRanges(value) {
  const ranges = [];
  let index = 0;
  while (index < value.length) {
    if (value[index] === '"' || value[index] === "'") {
      const quote = value[index];
      index += 1;
      while (index < value.length) {
        if (value[index] === "\\") index += 2;
        else if (value[index++] === quote) break;
        else index += 0;
      }
      continue;
    }
    if (value.slice(index, index + 3).toLowerCase() !== "url") {
      index += 1;
      continue;
    }
    const before = value[index - 1] ?? "";
    const after = value[index + 3] ?? "";
    if (
      (before && /[\p{L}\p{N}_-]/u.test(before)) ||
      (after && /[\p{L}\p{N}_-]/u.test(after))
    ) {
      index += 3;
      continue;
    }
    let cursor = index + 3;
    while (/\s/u.test(value[cursor] ?? "")) cursor += 1;
    if (value[cursor] !== "(") {
      index += 3;
      continue;
    }
    const start = cursor + 1;
    cursor = start;
    let quote = null;
    let escaped = false;
    let parentheses = 1;
    while (cursor < value.length && parentheses > 0) {
      const character = value[cursor];
      if (quote !== null) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = null;
      } else if (character === '"' || character === "'") quote = character;
      else if (character === "(") parentheses += 1;
      else if (character === ")") parentheses -= 1;
      cursor += 1;
    }
    ranges.push([start, parentheses === 0 ? cursor - 1 : value.length]);
    index = cursor;
  }
  return ranges;
}

function decodeCssIdentifier(value) {
  return value.replace(
    /\\([0-9A-Fa-f]{1,6})(?:\r\n|[\t\n\f\r ])?|\\(?:\r\n|[\n\f\r])|\\([\s\S])/g,
    (escape, hexadecimal, escapedCharacter) => {
      if (hexadecimal !== undefined) {
        const codePoint = Number.parseInt(hexadecimal, 16);
        if (
          codePoint > 0 &&
          codePoint <= 0x10ffff &&
          !(codePoint >= 0xd800 && codePoint <= 0xdfff)
        )
          return String.fromCodePoint(codePoint);
        return "\ufffd";
      }
      return escapedCharacter ?? "";
    },
  );
}

function* cssContentDeclarationValues(value) {
  let index = 0;
  let statementStart = 0;
  let parentheses = 0;
  const blockKinds = [];
  while (index < value.length) {
    if (value[index] === '"' || value[index] === "'") {
      const quote = value[index];
      index += 1;
      while (index < value.length) {
        if (value[index] === "\\") {
          index += 2;
          continue;
        }
        index += 1;
        if (value[index - 1] === quote) break;
      }
      continue;
    }
    if (value[index] === "(") {
      parentheses += 1;
      index += 1;
      continue;
    }
    if (value[index] === ")" && parentheses > 0) {
      parentheses -= 1;
      index += 1;
      continue;
    }
    if (value[index] === "{" && parentheses === 0) {
      const header = value.slice(statementStart, index).trimStart();
      blockKinds.push(header.startsWith("@") ? "at-rule" : "style-rule");
      statementStart = index + 1;
      index += 1;
      continue;
    }
    if (value[index] === "}" && parentheses === 0) {
      blockKinds.pop();
      statementStart = index + 1;
      index += 1;
      continue;
    }
    if (value[index] === ";" && parentheses === 0) {
      statementStart = index + 1;
      index += 1;
      continue;
    }
    if (value[index] !== ":") {
      index += 1;
      continue;
    }
    if (
      blockKinds.at(-1) !== "style-rule" ||
      decodeCssIdentifier(value.slice(statementStart, index).trim()).toLowerCase() !==
        "content"
    ) {
      index += 1;
      continue;
    }
    const start = index + 1;
    let cursor = start;
    let quote = null;
    let escaped = false;
    let valueParentheses = 0;
    while (cursor < value.length) {
      const character = value[cursor];
      if (quote !== null) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = null;
        cursor += 1;
        continue;
      }
      if (character === '"' || character === "'") quote = character;
      else if (character === "\\") {
        cursor += 2;
        continue;
      } else if (character === "(") valueParentheses += 1;
      else if (character === ")" && valueParentheses > 0) valueParentheses -= 1;
      else if ((character === ";" || character === "}") && valueParentheses === 0)
        break;
      cursor += 1;
    }
    yield value.slice(start, cursor);
    if (value[cursor] === "}") blockKinds.pop();
    index = cursor + 1;
    statementStart = index;
  }
}

function stripCssComments(value) {
  let rendered = "";
  let quote = null;
  let escaped = false;
  let index = 0;
  while (index < value.length) {
    const character = value[index];
    if (quote !== null) {
      rendered += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      rendered += character;
      index += 1;
      continue;
    }
    if (value.startsWith("/*", index)) {
      const end = value.indexOf("*/", index + 2);
      index = end < 0 ? value.length : end + 2;
      continue;
    }
    rendered += character;
    index += 1;
  }
  return rendered;
}

function splitCssAlternativeContent(value) {
  let quote = null;
  let escaped = false;
  let parentheses = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "(") parentheses += 1;
    else if (character === ")" && parentheses > 0) parentheses -= 1;
    else if (character === "/" && parentheses === 0)
      return [value.slice(0, index), value.slice(index + 1)];
  }
  return [value];
}

function renderEmbeddedCssContent(value) {
  const candidates = [];
  const stylePattern =
    /<style(?:\s+(?:"[^"]*"|'[^']*'|[^'">])*)?\s*>([\s\S]*?)<\/style\s*>/gi;
  for (const match of value.matchAll(stylePattern)) {
    candidates.push(...renderCssContent(match[1]));
  }
  return candidates;
}

const exposedMarkupAttributeNames = new Set([
  "alt",
  "aria-description",
  "aria-label",
  "aria-placeholder",
  "aria-roledescription",
  "aria-valuetext",
  "placeholder",
  "title",
]);
const nonTextualInputValueTypes = new Set([
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "password",
  "radio",
  "range",
]);
const labeledOptionElements = new Set(["option", "optgroup"]);

function renderMarkupAttributeValues(value) {
  const candidates = [];
  const tagPattern =
    /<([A-Za-z][A-Za-z0-9:-]*)(?:\s+(?:"[^"]*"|'[^']*'|[^'">])*)?\s*\/?>/gs;
  const attributePattern =
    /(?:^|\s)([^\s"'=<>`]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  for (const tag of value.matchAll(tagPattern)) {
    const tagName = tag[1].toLowerCase();
    const attributes = [...tag[0].matchAll(attributePattern)].map((attribute) => ({
      name: attribute[1].toLowerCase(),
      value: decodeHtmlCharacterReferences(
        attribute[2] ?? attribute[3] ?? attribute[4],
        true,
      ),
    }));
    const inputType = attributes
      .find((attribute) => attribute.name === "type")
      ?.value.trim()
      .toLowerCase();
    for (const attribute of attributes) {
      const exposedInputValue =
        tagName === "input" &&
        attribute.name === "value" &&
        !nonTextualInputValueTypes.has(inputType ?? "text");
      const exposedOptionLabel =
        labeledOptionElements.has(tagName) && attribute.name === "label";
      if (
        !exposedMarkupAttributeNames.has(attribute.name) &&
        !exposedInputValue &&
        !exposedOptionLabel
      )
        continue;
      candidates.push(attribute.value);
    }
  }
  return candidates;
}

function maskMarkupRcdataBodies(value) {
  return value.replace(
    /(<(textarea|title)\b(?:\s+(?:"[^"]*"|'[^']*'|[^'">])*)?\s*>)([\s\S]*?)(<\/\2\s*>)/gi,
    (segment, opening, tag, body, closing) =>
      opening + body.replace(/[^\r\n]/g, " ") + closing,
  );
}

function stripMarkupComments(value) {
  return value.replace(/<!--[\s\S]*?-->/g, (comment) =>
    comment.replace(/[^\r\n]/g, " "),
  );
}

function renderInlineEventHandlers(value) {
  const candidates = [];
  const tagPattern =
    /<[A-Za-z][A-Za-z0-9:-]*(?:\s+(?:"[^"]*"|'[^']*'|[^'">])*)?\s*\/?>/gs;
  const attributePattern =
    /(?:^|\s)([^\s"'=<>`]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  for (const tag of value.matchAll(tagPattern)) {
    for (const attribute of tag[0].matchAll(attributePattern)) {
      if (!/^on[a-z]+$/i.test(attribute[1])) continue;
      const source = decodeHtmlCharacterReferences(
        attribute[2] ?? attribute[3] ?? attribute[4],
        true,
      );
      candidates.push(...renderJavascriptLiterals(source));
    }
  }
  return candidates;
}

function renderInlineExecutableScripts(value) {
  const candidates = [];
  const scriptPattern =
    /<script\b((?:\s+(?:"[^"]*"|'[^']*'|[^'">])*)?)\s*>([\s\S]*?)<\/script\s*>/gi;
  const executableTypes = new Set([
    "",
    "application/ecmascript",
    "application/javascript",
    "module",
    "text/ecmascript",
    "text/javascript",
  ]);
  for (const script of value.matchAll(scriptPattern)) {
    const typeMatch = /(?:^|\s)type\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i.exec(
      script[1],
    );
    const type = decodeHtmlCharacterReferences(
      typeMatch?.[1] ?? typeMatch?.[2] ?? typeMatch?.[3] ?? "",
      true,
    )
      .trim()
      .toLowerCase()
      .split(";", 1)[0]
      .trim();
    if (executableTypes.has(type)) {
      candidates.push(...renderJavascriptLiterals(script[2]));
      candidates.push(...renderInlineHtmlAssignments(script[2]));
    }
  }
  return candidates;
}

function javascriptExpressionEnd(value, start) {
  let parentheses = 0;
  let brackets = 0;
  let braces = 0;
  let index = start;
  while (index < value.length) {
    if (value.startsWith("/*", index)) {
      const end = value.indexOf("*/", index + 2);
      index = end < 0 ? value.length : end + 2;
      continue;
    }
    if (value.startsWith("//", index)) {
      const end = /[\r\n\u2028\u2029]/u.exec(value.slice(index + 2));
      index = end ? index + 2 + (end.index ?? 0) + end[0].length : value.length;
      continue;
    }
    if (['"', "'", "`"].includes(value[index])) {
      const literal = scanJavascriptLiteral(value, index);
      if (!literal) return value.length;
      index = literal.end;
      continue;
    }
    if (value[index] === "(") parentheses += 1;
    else if (value[index] === ")" && parentheses > 0) parentheses -= 1;
    else if (value[index] === "[") brackets += 1;
    else if (value[index] === "]" && brackets > 0) brackets -= 1;
    else if (value[index] === "{") braces += 1;
    else if (value[index] === "}" && braces > 0) braces -= 1;
    else if (
      value[index] === ";" &&
      parentheses === 0 &&
      brackets === 0 &&
      braces === 0
    )
      return index;
    index += 1;
  }
  return value.length;
}

function renderHtmlFragmentCandidates(value) {
  const executableMarkup = maskMarkupRcdataBodies(stripMarkupComments(value));
  return [
    decodeHtmlCharacterReferences(stripMarkupNodes(value)),
    ...renderMarkupAttributeValues(executableMarkup),
    ...renderEmbeddedCssContent(executableMarkup),
    ...renderInlineEventHandlers(executableMarkup),
  ];
}

function skipJavascriptTrivia(value, start) {
  let index = start;
  while (index < value.length) {
    if (/\s/u.test(value[index])) {
      index += 1;
      continue;
    }
    if (value.startsWith("/*", index)) {
      const end = value.indexOf("*/", index + 2);
      return end < 0 ? value.length : skipJavascriptTrivia(value, end + 2);
    }
    if (value.startsWith("//", index)) {
      const terminator = /[\r\n\u2028\u2029]/u.exec(value.slice(index + 2));
      if (!terminator) return value.length;
      index += 2 + (terminator.index ?? 0) + terminator[0].length;
      continue;
    }
    break;
  }
  return index;
}

function htmlSinkAssignmentValueStart(value, start) {
  const dotProperty = /^\.\s*(?:innerHTML|outerHTML)\s*=\s*/u.exec(value.slice(start));
  if (dotProperty) return start + dotProperty[0].length;
  if (value[start] !== "[") return null;
  let cursor = skipJavascriptTrivia(value, start + 1);
  const property = scanJavascriptLiteral(value, cursor);
  if (!property) return null;
  const propertyName = renderStaticLiteral(property.literal);
  if (!new Set(["innerHTML", "outerHTML"]).has(propertyName ?? "")) return null;
  cursor = skipJavascriptTrivia(value, property.end);
  if (value[cursor] !== "]") return null;
  cursor = skipJavascriptTrivia(value, cursor + 1);
  if (value[cursor] !== "=" || value[cursor + 1] === "=") return null;
  return skipJavascriptTrivia(value, cursor + 1);
}

function renderInlineHtmlAssignments(value) {
  const candidates = [];
  let index = 0;
  while (index < value.length) {
    const triviaEnd = skipJavascriptTrivia(value, index);
    if (triviaEnd !== index) {
      index = triviaEnd;
      continue;
    }
    if (['"', "'", "`"].includes(value[index])) {
      const literal = scanJavascriptLiteral(value, index);
      if (!literal) {
        index += 1;
        continue;
      }
      if (literal.literal.startsWith("`")) {
        let templateIndex = 1;
        while (templateIndex < literal.literal.length - 1) {
          if (literal.literal[templateIndex] === "\\") {
            templateIndex += 2;
            continue;
          }
          if (literal.literal.startsWith("${", templateIndex)) {
            const end = findTemplateExpressionEnd(literal.literal, templateIndex + 2);
            if (end < 0) break;
            candidates.push(
              ...renderInlineHtmlAssignments(
                literal.literal.slice(templateIndex + 2, end),
              ),
            );
            templateIndex = end + 1;
            continue;
          }
          templateIndex += 1;
        }
      }
      index = literal.end;
      continue;
    }
    if (value[index] === "/" && javascriptRegexCanStart(value, index)) {
      const end = scanJavascriptRegex(value, index);
      if (end !== null) {
        index = end;
        continue;
      }
    }
    const start = htmlSinkAssignmentValueStart(value, index);
    if (start === null) {
      index += 1;
      continue;
    }
    const end = javascriptExpressionEnd(value, start);
    const rendered = renderConstantJavascriptExpression(value.slice(start, end));
    if (rendered !== null) candidates.push(...renderHtmlFragmentCandidates(rendered));
    index = Math.max(end + 1, start);
  }
  return candidates;
}

function stripJsxComments(value) {
  return value.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "");
}

const jsxVoidElements = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

function scanJsxTag(value, start) {
  if (value.startsWith("<>", start))
    return { closing: false, end: start + 2, fragment: true, selfClosing: false };
  if (value.startsWith("</>", start))
    return { closing: true, end: start + 3, fragment: true, selfClosing: false };
  const opening = /^<\/?([A-Za-z][A-Za-z0-9:.-]*)/u.exec(value.slice(start));
  if (!opening) return null;
  let quote = null;
  let escaped = false;
  let index = start + opening[0].length;
  while (index < value.length) {
    const character = value[index];
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === ">") {
      const closing = value[start + 1] === "/";
      const selfClosing = /\/\s*$/u.test(value.slice(start, index));
      return {
        closing,
        end: index + 1,
        fragment: false,
        name: opening[1].toLowerCase(),
        selfClosing,
      };
    }
    index += 1;
  }
  return null;
}

function jsxElementDepthAt(value, position) {
  let depth = 0;
  let index = 0;
  while (index < position) {
    if (value.startsWith("/*", index)) {
      const end = value.indexOf("*/", index + 2);
      index = end < 0 ? position : end + 2;
      continue;
    }
    if (value.startsWith("//", index)) {
      const end = /[\r\n\u2028\u2029]/u.exec(value.slice(index + 2));
      index = end ? index + 2 + (end.index ?? 0) + end[0].length : position;
      continue;
    }
    if (['"', "'", "`"].includes(value[index])) {
      const literal = scanJavascriptLiteral(value, index);
      index = literal ? literal.end : index + 1;
      continue;
    }
    if (value[index] === "<") {
      const tag = scanJsxTag(value, index);
      if (tag) {
        if (tag.closing) depth = Math.max(0, depth - 1);
        else if (
          !tag.selfClosing &&
          (tag.fragment || !jsxVoidElements.has(tag.name ?? ""))
        )
          depth += 1;
        index = tag.end;
        continue;
      }
    }
    if (value[index] === "{" && depth > 0) {
      const end = findTemplateExpressionEnd(value, index + 1);
      if (end >= 0 && end < position) {
        index = end + 1;
        continue;
      }
    }
    index += 1;
  }
  return depth;
}

function isLikelyJsxChildExpression(value, start, end) {
  if (jsxElementDepthAt(value, start) > 0) return true;
  const before = value.slice(0, start).trimEnd();
  const after = value.slice(end + 1).trimStart();
  return /<\/[A-Za-z][A-Za-z0-9:.-]*\s*>$/u.test(before) && /^(?:<|\{)/u.test(after);
}

function unwrapStaticJavascriptGrouping(expression) {
  let unwrapped = expression
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n\u2028\u2029]*/g, " ")
    .trim();
  while (unwrapped.startsWith("(")) {
    let depth = 0;
    let closing = -1;
    for (let index = 0; index < unwrapped.length; index += 1) {
      if (['"', "'", "`"].includes(unwrapped[index])) {
        const literal = scanJavascriptLiteral(unwrapped, index);
        if (!literal) return unwrapped;
        index = literal.end - 1;
        continue;
      }
      if (unwrapped[index] === "(") depth += 1;
      else if (unwrapped[index] === ")" && --depth === 0) {
        closing = index;
        break;
      }
    }
    if (closing !== unwrapped.length - 1) break;
    unwrapped = unwrapped.slice(1, -1).trim();
  }
  return unwrapped;
}

function renderStaticJsxChildExpression(expression) {
  const rendered = renderConstantJavascriptExpression(expression);
  if (rendered !== null) return rendered;
  const unwrapped = unwrapStaticJavascriptGrouping(expression);
  if (/^(?:false|null|true|undefined)$/u.test(unwrapped)) return "";
  if (/^(?:\(\s*)*(?:false|null|undefined)(?:\s*\))*\s*&&/u.test(unwrapped)) return "";
  return null;
}

function replaceStaticJsxExpressions(value) {
  let projected = "";
  let cursor = 0;
  while (cursor < value.length) {
    const start = value.indexOf("{", cursor);
    if (start < 0) {
      projected += value.slice(cursor);
      break;
    }
    projected += value.slice(cursor, start);
    const end = findTemplateExpressionEnd(value, start + 1);
    if (end < 0) {
      projected += value.slice(start);
      break;
    }
    const expression = renderStaticJsxChildExpression(value.slice(start + 1, end));
    const original = value.slice(start, end + 1);
    projected +=
      expression !== null && isLikelyJsxChildExpression(value, start, end)
        ? expression
        : original;
    cursor = end + 1;
  }
  return projected;
}

function removeNonRenderingJsxExpressions(value) {
  return value.replace(/\{\s*(?:false|null|true|undefined)\s*\}/g, "");
}

function stripMarkupNodes(value) {
  const rcdataSegments = [];
  const shielded = value.replace(
    /<(textarea|title)\b(?:\s+(?:"[^"]*"|'[^']*'|[^'">])*)?\s*>([\s\S]*?)<\/\1\s*>/gi,
    (segment, tag, body) => {
      const placeholder = `\u0000RCDATA${rcdataSegments.length}\u0000`;
      rcdataSegments.push([placeholder, body]);
      return placeholder;
    },
  );
  let rendered = shielded
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(
      /<(script|style|template)\b(?:\s+(?:"[^"]*"|'[^']*'|[^'">])*)?\s*>[\s\S]*?<\/\1\s*>/gi,
      "",
    )
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(
      /<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s+(?:"[^"]*"|'[^']*'|[^'">])*)?\s*\/?>/gs,
      " ",
    );
  for (const [placeholder, segment] of rcdataSegments)
    rendered = rendered.replaceAll(placeholder, segment);
  return rendered;
}

function normalizeMarkdownReferenceLabel(value) {
  return value.trim().replace(/\s+/gu, " ").toUpperCase().toLowerCase();
}

function replaceMarkdownFencedBlocks(value, replaceBlock) {
  const lines = [...value.matchAll(/[^\r\n]*(?:\r\n|[\r\n]|$)/g)]
    .map((match) => match[0])
    .filter(Boolean);
  let rendered = "";
  for (let index = 0; index < lines.length; index += 1) {
    const opening = /^ {0,3}(`{3,}|~{3,})[^\r\n]*(?:\r\n|[\r\n]|$)/u.exec(lines[index]);
    if (!opening) {
      rendered += lines[index];
      continue;
    }
    let closingIndex = index + 1;
    while (closingIndex < lines.length) {
      const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*(?:\r\n|[\r\n]|$)/u.exec(
        lines[closingIndex],
      );
      if (
        closing &&
        closing[1][0] === opening[1][0] &&
        closing[1].length >= opening[1].length
      )
        break;
      closingIndex += 1;
    }
    const finalIndex = Math.min(closingIndex, lines.length - 1);
    rendered += replaceBlock(lines.slice(index, finalIndex + 1).join(""));
    index = finalIndex;
  }
  return rendered;
}

function renderMarkdownLinkTitles(value) {
  let projected = replaceMarkdownFencedBlocks(value, () => "");
  projected = projected
    .replace(/(`+)([^\r\n]*?)\1/g, "")
    .replace(/^(?: {4}|\t)[^\r\n]*(?:\r\n|[\r\n]|$)/gm, "");
  const candidates = [];
  const inlineTitle =
    /!?\[[^\]\r\n]*\]\(\s*(?:<[^>\r\n]*>|[^\s)\r\n]+)[ \t]+(?:"([^"\r\n]*)"|'([^'\r\n]*)'|\(([^()\r\n]*)\))\s*\)/g;
  for (const match of projected.matchAll(inlineTitle))
    candidates.push(decodeHtmlCharacterReferences(match[1] ?? match[2] ?? match[3]));
  const definitionTitle =
    /^ {0,3}\[[^\]\r\n]+\]:[ \t]+(?:<[^>\r\n]*>|\S+)[ \t]+(?:"([^"\r\n]*)"|'([^'\r\n]*)'|\(([^()\r\n]*)\))[ \t]*$/gm;
  for (const match of projected.matchAll(definitionTitle))
    candidates.push(decodeHtmlCharacterReferences(match[1] ?? match[2] ?? match[3]));
  return candidates;
}

function renderMarkdown(value) {
  const codeSegments = [];
  const shield = (segment) => {
    const placeholder = `\u0000MARKDOWNCODE${codeSegments.length}\u0000`;
    codeSegments.push([placeholder, segment]);
    return placeholder;
  };
  let shielded = replaceMarkdownFencedBlocks(value, (segment) => shield(segment));
  shielded = shielded.replace(/^(?: {4}|\t)[^\r\n]*(?:\r\n|[\r\n]|$)/gm, (segment) =>
    shield(segment),
  );
  shielded = shielded.replace(/(`+)([^\r\n]*?)\1/g, (segment) => shield(segment));
  const referenceIds = new Set(
    [...shielded.matchAll(/^\s{0,3}\[([^\]]+)\]:\s+\S+.*$/gm)].map((match) =>
      normalizeMarkdownReferenceLabel(match[1]),
    ),
  );
  const withoutDefinitions = shielded.replace(/^\s{0,3}\[[^\]]+\]:\s+\S+.*$/gm, "");
  let rendered = stripMarkupNodes(withoutDefinitions)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/!?\[([^\]]+)\]\[([^\]]*)\]/g, (match, label, reference) =>
      referenceIds.has(normalizeMarkdownReferenceLabel(reference || label))
        ? label
        : match,
    )
    .replace(/!?\[([^\]]+)\]/g, (match, label) =>
      referenceIds.has(normalizeMarkdownReferenceLabel(label)) ? label : match,
    )
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "$1")
    .replace(/__(?=\S)([\s\S]*?\S)__/g, "$1")
    .replace(/\*(?=\S)([^*\r\n]*?\S)\*/g, "$1")
    .replace(/_(?=\S)([^_\r\n]*?\S)_/g, "$1")
    .replace(/\\(?:\r\n|[\r\n])/g, " ");
  rendered = decodeHtmlCharacterReferences(rendered);
  for (const [placeholder, segment] of codeSegments)
    rendered = rendered.replaceAll(placeholder, segment);
  return rendered;
}

const pythonNamedEscapeCharacters = new Map([
  ["CHARACTER TABULATION", "\t"],
  ["HYPHEN-MINUS", "-"],
  ["LINE FEED", "\n"],
  ["LOW LINE", "_"],
  ["NO-BREAK SPACE", "\u00a0"],
  ["SPACE", " "],
]);
for (let codePoint = 65; codePoint <= 90; codePoint += 1) {
  const capital = String.fromCodePoint(codePoint);
  pythonNamedEscapeCharacters.set(`LATIN CAPITAL LETTER ${capital}`, capital);
  pythonNamedEscapeCharacters.set(
    `LATIN SMALL LETTER ${capital}`,
    capital.toLowerCase(),
  );
}

function decodePythonStringBody(body) {
  return `"${body.replace(/"/g, '\\"')}"`
    .slice(1, -1)
    .replace(
      /\\N\{([^}\r\n]+)\}|\\u\{([0-9A-Fa-f]{1,6})\}|\\U([0-9A-Fa-f]{8})|\\u([0-9A-Fa-f]{4})|\\x([0-9A-Fa-f]{2})|\\([0-7]{1,3})|\\(?:\r\n|[\n\r])|\\([abtnvfr"'\\])/g,
      (
        escape,
        named,
        bracedUnicode,
        longUnicode,
        fixedUnicode,
        hexadecimal,
        octal,
        simple,
      ) => {
        if (named !== undefined)
          return pythonNamedEscapeCharacters.get(named) ?? escape;
        const encoded = bracedUnicode ?? longUnicode ?? fixedUnicode ?? hexadecimal;
        if (encoded !== undefined) {
          const codePoint = Number.parseInt(encoded, 16);
          if (codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff))
            return String.fromCodePoint(codePoint);
          return "\ufffd";
        }
        if (octal !== undefined) return String.fromCodePoint(Number.parseInt(octal, 8));
        if (simple !== undefined)
          return (
            {
              a: "\u0007",
              b: "\b",
              t: "\t",
              n: "\n",
              v: "\v",
              f: "\f",
              r: "\r",
              '"': '"',
              "'": "'",
              "\\": "\\",
            }[simple] ?? simple
          );
        return "";
      },
    );
}

function scanPythonLiteral(value, start) {
  const prefix = /^[rRuUbBfF]{0,2}/.exec(value.slice(start))?.[0] ?? "";
  const delimiterStart = start + prefix.length;
  const delimiter = value.startsWith('"""', delimiterStart)
    ? '"""'
    : value.startsWith("'''", delimiterStart)
      ? "'''"
      : ['"', "'"].includes(value[delimiterStart])
        ? value[delimiterStart]
        : null;
  if (delimiter === null) return null;
  let index = delimiterStart + delimiter.length;
  while (index < value.length) {
    if (value[index] === "\\" && !prefix.toLowerCase().includes("r")) {
      index += value[index + 1] === "\r" && value[index + 2] === "\n" ? 3 : 2;
      continue;
    }
    if (value.startsWith(delimiter, index))
      return {
        literal: value.slice(start, index + delimiter.length),
        end: index + delimiter.length,
      };
    index += 1;
  }
  return null;
}

function renderConstantPythonExpression(expression) {
  const rendered = [];
  let parentheses = 0;
  let expectOperand = true;
  let index = 0;
  while (index < expression.length) {
    if (/\s/u.test(expression[index])) {
      index += 1;
      continue;
    }
    if (expression[index] === "(") {
      parentheses += 1;
      index += 1;
      continue;
    }
    if (expression[index] === ")") {
      if (parentheses === 0 || expectOperand) return null;
      parentheses -= 1;
      index += 1;
      continue;
    }
    if (expression[index] === "+") {
      if (expectOperand) return null;
      expectOperand = true;
      index += 1;
      continue;
    }
    if (!expectOperand) return null;
    const literal = scanPythonLiteral(expression, index);
    if (!literal) return null;
    const value = renderPythonString(literal.literal);
    if (value === null) return null;
    rendered.push(value);
    expectOperand = false;
    index = literal.end;
  }
  return !expectOperand && parentheses === 0 ? rendered.join("") : null;
}

function renderStaticPythonFString(body, raw) {
  let rendered = "";
  let literalSegment = "";
  const flushLiteral = () => {
    rendered += raw ? literalSegment : decodePythonStringBody(literalSegment);
    literalSegment = "";
  };
  let index = 0;
  while (index < body.length) {
    if (body.startsWith("{{", index)) {
      literalSegment += "{";
      index += 2;
      continue;
    }
    if (body.startsWith("}}", index)) {
      literalSegment += "}";
      index += 2;
      continue;
    }
    if (body[index] === "{") {
      flushLiteral();
      let braces = 1;
      let end = index + 1;
      while (end < body.length && braces > 0) {
        const literal = scanPythonLiteral(body, end);
        if (literal) {
          end = literal.end;
          continue;
        }
        if (body[end] === "{") braces += 1;
        else if (body[end] === "}") braces -= 1;
        if (braces > 0) end += 1;
      }
      if (braces !== 0) return null;
      const expression = renderStaticPythonFStringField(body.slice(index + 1, end));
      if (expression === null) return null;
      rendered += expression;
      index = end + 1;
      continue;
    }
    if (body[index] === "}") return null;
    literalSegment += body[index];
    index += 1;
  }
  flushLiteral();
  return rendered;
}

function renderStaticPythonFStringField(field) {
  let parentheses = 0;
  let conversionIndex = -1;
  let formatIndex = -1;
  let index = 0;
  while (index < field.length) {
    const literal = scanPythonLiteral(field, index);
    if (literal) {
      index = literal.end;
      continue;
    }
    if (field[index] === "(") parentheses += 1;
    else if (field[index] === ")") parentheses -= 1;
    else if (parentheses === 0 && field[index] === "!" && conversionIndex < 0)
      conversionIndex = index;
    else if (parentheses === 0 && field[index] === ":") {
      formatIndex = index;
      break;
    }
    index += 1;
  }
  if (parentheses !== 0) return null;
  const expressionEnd = [conversionIndex, formatIndex]
    .filter((offset) => offset >= 0)
    .reduce((first, offset) => Math.min(first, offset), field.length);
  let rendered = renderConstantPythonExpression(field.slice(0, expressionEnd));
  if (rendered === null) return null;

  if (conversionIndex >= 0) {
    const conversionEnd = formatIndex >= 0 ? formatIndex : field.length;
    const conversion = field.slice(conversionIndex + 1, conversionEnd).trim();
    if (!new Set(["a", "r", "s"]).has(conversion)) return null;
    if (conversion === "a" || conversion === "r")
      rendered = `'${rendered.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
  }

  if (formatIndex < 0) return rendered;
  const specifier = field.slice(formatIndex + 1);
  const format = /^(?:(.)([<^>])|([<^>]))?(\d+)?(?:\.(\d+))?s?$/su.exec(specifier);
  if (!format) return null;
  const fill = format[1] ?? " ";
  const alignment = format[2] ?? format[3] ?? "<";
  const width = Number.parseInt(format[4] ?? "0", 10);
  const precision = format[5] === undefined ? null : Number.parseInt(format[5], 10);
  if (precision !== null) rendered = [...rendered].slice(0, precision).join("");
  const padding = Math.max(0, width - [...rendered].length);
  if (alignment === ">") return fill.repeat(padding) + rendered;
  if (alignment === "^") {
    const before = Math.floor(padding / 2);
    return fill.repeat(before) + rendered + fill.repeat(padding - before);
  }
  return rendered + fill.repeat(padding);
}

function renderPythonString(literal) {
  const prefixMatch = /^([rRuUbBfF]{0,2})("""|'''|"|')/.exec(literal);
  if (!prefixMatch) return literal;
  const prefix = prefixMatch[1].toLowerCase();
  const delimiter = prefixMatch[2];
  const body = literal.slice(prefixMatch[0].length, -delimiter.length);
  if (prefix.includes("f"))
    return renderStaticPythonFString(body, prefix.includes("r"));
  return prefix.includes("r") ? body : decodePythonStringBody(body);
}

function maskPythonComments(value) {
  let projected = "";
  let index = 0;
  while (index < value.length) {
    if (value[index] === '"' || value[index] === "'") {
      const delimiter = value.startsWith(value[index].repeat(3), index)
        ? value[index].repeat(3)
        : value[index];
      const start = index;
      index += delimiter.length;
      while (index < value.length) {
        if (value[index] === "\\") {
          index += value[index + 1] === "\r" && value[index + 2] === "\n" ? 3 : 2;
          continue;
        }
        if (value.startsWith(delimiter, index)) {
          index += delimiter.length;
          break;
        }
        index += 1;
      }
      projected += value.slice(start, index);
      continue;
    }
    if (value[index] === "#") {
      const end = /[\r\n]/u.exec(value.slice(index));
      const width = end?.index ?? value.length - index;
      projected += " ".repeat(width);
      index += width;
      continue;
    }
    projected += value[index];
    index += 1;
  }
  return projected;
}

function pythonGroupingDepthAt(value, position) {
  const grouping = [];
  let index = 0;
  while (index < position) {
    const literal = scanPythonLiteral(value, index);
    if (literal) {
      index = literal.end;
      continue;
    }
    if ("([{".includes(value[index])) grouping.push(value[index]);
    else if (")]}".includes(value[index])) grouping.pop();
    index += 1;
  }
  return grouping.length;
}

function renderPythonLiterals(value) {
  const candidates = [];
  const projectedValue = maskPythonComments(value);
  const literalPattern =
    /[rRuUbBfF]{0,2}(?:"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g;
  let previous = null;
  let chain = null;
  for (const match of projectedValue.matchAll(literalPattern)) {
    const rendered = renderPythonString(match[0]);
    if (rendered === null) {
      previous = null;
      chain = null;
      continue;
    }
    candidates.push(rendered);
    const separator = previous ? projectedValue.slice(previous.end, match.index) : "";
    const projectedSeparator = separator
      .replace(/\\(?:\r\n|[\r\n])/g, "")
      .replace(/[()]/g, "");
    if (
      previous &&
      (/^[ \t\f]*$/.test(projectedSeparator) ||
        (separator.includes("\\") && /^\s*$/.test(projectedSeparator)) ||
        (pythonGroupingDepthAt(projectedValue, previous.end) > 0 &&
          /^\s*$/.test(projectedSeparator)) ||
        /^\s*\+\s*$/.test(projectedSeparator))
    ) {
      chain = (chain ?? previous.rendered) + rendered;
      candidates.push(chain);
    } else {
      chain = null;
    }
    previous = {
      end: (match.index ?? 0) + match[0].length,
      rendered,
    };
  }
  return candidates;
}

function javascriptRegexCanStart(value, index) {
  const prefix = value.slice(0, index).trimEnd();
  if (!prefix) return true;
  if (/=>$/u.test(prefix)) return true;
  const last = prefix.at(-1) ?? "";
  if (/[([{,:;=!?~%&|^*+\-<>]/u.test(last)) return true;
  const word = /([A-Za-z_$][\w$]*)$/u.exec(prefix)?.[1];
  return new Set([
    "await",
    "case",
    "delete",
    "in",
    "instanceof",
    "of",
    "return",
    "throw",
    "typeof",
    "void",
    "yield",
  ]).has(word ?? "");
}

function scanJavascriptRegex(value, start) {
  let escaped = false;
  let characterClass = false;
  let index = start + 1;
  while (index < value.length) {
    const character = value[index];
    if (escaped) escaped = false;
    else if (character === "\\") escaped = true;
    else if (character === "[") characterClass = true;
    else if (character === "]") characterClass = false;
    else if (/\r|\n|\u2028|\u2029/u.test(character)) return null;
    else if (character === "/" && !characterClass) {
      index += 1;
      while (/[A-Za-z]/u.test(value[index] ?? "")) index += 1;
      return index;
    }
    index += 1;
  }
  return null;
}

function renderStaticRawTemplateLiteral(literal) {
  let rendered = "";
  let index = 1;
  while (index < literal.length - 1) {
    if (literal[index] === "\\") {
      const width = literal[index + 1] === "\r" && literal[index + 2] === "\n" ? 3 : 2;
      rendered += literal.slice(index, index + width);
      index += width;
      continue;
    }
    if (literal.startsWith("${", index)) {
      const end = findTemplateExpressionEnd(literal, index + 2);
      if (end < 0) return null;
      const expression = renderConstantJavascriptExpression(
        literal.slice(index + 2, end),
      );
      if (expression === null) return null;
      rendered += expression;
      index = end + 1;
      continue;
    }
    rendered += literal[index];
    index += 1;
  }
  return rendered;
}

function maskTypeScriptTypeAliases(value) {
  const masked = value.split("");
  const aliasPattern = /\btype\s+[A-Za-z_$][\w$]*(?:\s*<[^=;\r\n]*>)?\s*=/g;
  for (const alias of value.matchAll(aliasPattern)) {
    const start = alias.index ?? 0;
    const prefix = value.slice(0, start).trimEnd();
    if (
      prefix &&
      !/[;{}]$/u.test(prefix) &&
      !/(?:^|\s)(?:declare|export)$/u.test(prefix)
    )
      continue;
    const expressionStart = start + alias[0].length;
    const end = javascriptExpressionEnd(value, expressionStart);
    if (end >= value.length || value[end] !== ";") continue;
    for (let index = start; index <= end; index += 1)
      if (!/[\r\n]/u.test(masked[index])) masked[index] = " ";
  }
  return masked.join("");
}

function scanStaticConcatCall(value, start, receiver) {
  let cursor = skipJavascriptTrivia(value, start);
  if (value[cursor] !== ".") return null;
  cursor = skipJavascriptTrivia(value, cursor + 1);
  if (!/^concat\b/u.test(value.slice(cursor))) return null;
  cursor = skipJavascriptTrivia(value, cursor + "concat".length);
  if (value[cursor] !== "(") return null;
  let argumentStart = cursor + 1;
  let parentheses = 0;
  const argumentsRendered = [];
  cursor = argumentStart;
  while (cursor < value.length) {
    if (value.startsWith("/*", cursor) || value.startsWith("//", cursor)) {
      cursor = skipJavascriptTrivia(value, cursor);
      continue;
    }
    if (['"', "'", "`"].includes(value[cursor])) {
      const literal = scanJavascriptLiteral(value, cursor);
      if (!literal) return null;
      cursor = literal.end;
      continue;
    }
    if (value[cursor] === "/" && javascriptRegexCanStart(value, cursor)) {
      const end = scanJavascriptRegex(value, cursor);
      if (end !== null) {
        cursor = end;
        continue;
      }
    }
    if (value[cursor] === "(") parentheses += 1;
    else if (value[cursor] === ")") {
      if (parentheses > 0) parentheses -= 1;
      else {
        const argument = value.slice(argumentStart, cursor).trim();
        if (argument) {
          const rendered = renderConstantJavascriptExpression(argument);
          if (rendered === null) return null;
          argumentsRendered.push(rendered);
        }
        return {
          end: cursor + 1,
          rendered: receiver + argumentsRendered.join(""),
        };
      }
    } else if (value[cursor] === "," && parentheses === 0) {
      const rendered = renderConstantJavascriptExpression(
        value.slice(argumentStart, cursor),
      );
      if (rendered === null) return null;
      argumentsRendered.push(rendered);
      argumentStart = cursor + 1;
    }
    cursor += 1;
  }
  return null;
}

function renderStaticConcatChain(value, start, receiver) {
  let cursor = start;
  let rendered = receiver;
  let matched = false;
  while (true) {
    const call = scanStaticConcatCall(value, cursor, rendered);
    if (!call) break;
    matched = true;
    rendered = call.rendered;
    cursor = call.end;
  }
  return matched ? rendered : null;
}

function renderJavascriptLiterals(value) {
  const candidates = [];
  let previous = null;
  let chain = null;
  let index = 0;
  while (index < value.length) {
    if (value.startsWith("/*", index)) {
      const end = value.indexOf("*/", index + 2);
      index = end < 0 ? value.length : end + 2;
      continue;
    }
    if (value.startsWith("//", index)) {
      const terminator = /[\r\n\u2028\u2029]/u.exec(value.slice(index + 2));
      index = terminator
        ? index + 2 + (terminator.index ?? 0) + terminator[0].length
        : value.length;
      continue;
    }
    if (value[index] === "/" && javascriptRegexCanStart(value, index)) {
      const end = scanJavascriptRegex(value, index);
      if (end !== null) {
        previous = null;
        chain = null;
        index = end;
        continue;
      }
    }
    if (!['"', "'", "`"].includes(value[index])) {
      index += 1;
      continue;
    }
    const literal = scanJavascriptLiteral(value, index);
    if (!literal) {
      index += 1;
      continue;
    }
    const stringRawTag =
      literal.literal.startsWith("`") &&
      /String\s*\.\s*raw\s*$/u.test(
        value
          .slice(0, index)
          .replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n\u2028\u2029]*/g, " "),
      );
    const renderedLiteral = stringRawTag
      ? renderStaticRawTemplateLiteral(literal.literal)
      : renderStaticLiteral(literal.literal);
    if (renderedLiteral === null) {
      previous = null;
      chain = null;
      index = literal.end;
      continue;
    }
    candidates.push(renderedLiteral);
    const concatenatedCall = renderStaticConcatChain(
      value,
      literal.end,
      renderedLiteral,
    );
    if (concatenatedCall !== null) candidates.push(concatenatedCall);
    if (
      previous &&
      /^\s*\+\s*$/.test(
        value
          .slice(previous.end, index)
          .replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n\u2028\u2029]*/g, "")
          .replace(/[()]/g, ""),
      )
    ) {
      chain = (chain ?? previous.rendered) + renderedLiteral;
      candidates.push(chain);
    } else {
      chain = null;
    }
    previous = { rendered: renderedLiteral, end: literal.end };
    index = literal.end;
  }
  return candidates;
}

function renderedSourceCandidates(value, relativePath) {
  const extension = sourceExtension(relativePath);
  const candidates = [];
  const visibleValue = jsxSourceExtensions.has(extension)
    ? removeNonRenderingJsxExpressions(
        stripJsxComments(replaceStaticJsxExpressions(value)),
      )
    : value;
  if (markupSourceExtensions.has(extension)) {
    const executableMarkup = maskMarkupRcdataBodies(stripMarkupComments(visibleValue));
    candidates.push(decodeHtmlCharacterReferences(stripMarkupNodes(visibleValue)));
    candidates.push(...renderMarkupAttributeValues(executableMarkup));
    candidates.push(...renderEmbeddedCssContent(executableMarkup));
    candidates.push(...renderInlineExecutableScripts(executableMarkup));
    candidates.push(...renderInlineEventHandlers(executableMarkup));
  }
  if (markdownSourceExtensions.has(extension))
    candidates.push(
      renderMarkdown(visibleValue),
      ...renderMarkdownLinkTitles(visibleValue),
    );
  if (cssSourceExtensions.has(extension))
    candidates.push(...renderCssContent(value, extension));
  if (extension === ".py" || extension === ".pyw") {
    candidates.push(...renderPythonLiterals(value));
    return candidates;
  }
  if (!literalSourceExtensions.has(extension)) return candidates;
  const javascriptValue = typescriptSourceExtensions.has(extension)
    ? maskTypeScriptTypeAliases(value)
    : value;
  candidates.push(...renderJavascriptLiterals(javascriptValue));
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
const truncatedUtf16BeProbe = Buffer.concat([
  Buffer.from([0xfe, 0xff]),
  encodeUtf16Be(encodedPhraseProbe),
  Buffer.from([0]),
]);
if (
  !decodeRepositoryTexts(truncatedUtf16BeProbe, "probe.html").some((decoded) =>
    containsLanguagePhrase(normalizeLanguage(decoded), encodedPhraseProbe),
  )
) {
  errors.push("release_language_policy_self_test:truncated_utf16be_not_detected");
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
const spacedOrganizationalProbe = phrase(115, 105, 103, 110, 32, 111, 102, 102);
const fullwidthCompactProbe = [...compactOrganizationalProbe]
  .map((character) => String.fromCodePoint((character.codePointAt(0) ?? 0) + 0xfee0))
  .join("");
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
    "padded_braced_unicode_escape",
    `"\\u{0000073}${compactOrganizationalProbe.slice(1)}"`,
    "probe.js",
    compactOrganizationalProbe,
  ],
  [
    "javascript_identity_escape",
    `"${compactOrganizationalProbe.slice(0, 2)}\\${compactOrganizationalProbe.slice(2)}"`,
    "probe.js",
    compactOrganizationalProbe,
  ],
  [
    "ecmascript_line_separator_continuation",
    `"${compactOrganizationalProbe.slice(0, 4)}\\${String.fromCodePoint(0x2028)}${compactOrganizationalProbe.slice(4)}"`,
    "probe.js",
    compactOrganizationalProbe,
  ],
  [
    "legacy_octal_escape",
    `"\\163${compactOrganizationalProbe.slice(1)}"`,
    "probe.js",
    compactOrganizationalProbe,
  ],
  [
    "line_separator_comment_terminator",
    `"${compactOrganizationalProbe.slice(0, 2)}" // split${String.fromCodePoint(0x2028)} + "${compactOrganizationalProbe.slice(2, 4)}" + "${compactOrganizationalProbe.slice(4)}"`,
    "probe.js",
    compactOrganizationalProbe,
  ],
  [
    "commented_string_concatenation",
    `"${compactOrganizationalProbe.slice(0, 2)}" /* split */ + "${compactOrganizationalProbe.slice(2, 4)}" /* split */ + "${compactOrganizationalProbe.slice(4)}"`,
    "probe.js",
    compactOrganizationalProbe,
  ],
  [
    "constant_template_interpolation",
    "`" + probeFirstWord + ' ${""}' + probeSecondWord + "`",
    "probe.js",
    encodedPhraseProbe,
  ],
  [
    "commented_constant_template_literal_chain",
    "`" +
      probeFirstWord +
      ' ${/* split */ " " /* split */ + ""}' +
      probeSecondWord +
      "`",
    "probe.js",
    encodedPhraseProbe,
  ],
  [
    "grouped_constant_template_literal_chain",
    "`" + probeFirstWord + ' ${((/* split */ " " + ""))}' + probeSecondWord + "`",
    "probe.js",
    encodedPhraseProbe,
  ],
  [
    "nested_constant_template_literal",
    "`" + probeFirstWord + " ${(``)}" + probeSecondWord + "`",
    "probe.js",
    encodedPhraseProbe,
  ],
  [
    "grouped_javascript_literal_chain",
    `"${probeFirstWord} " + ("${probeSecondWord}")`,
    "probe.js",
    encodedPhraseProbe,
  ],
  [
    "quoted_interpolation_comment_is_not_an_operand",
    "`" + probeFirstWord + ' ${" " /* "hidden" */ + ""}' + probeSecondWord + "`",
    "probe.js",
    encodedPhraseProbe,
  ],
  [
    "json_unicode_escape",
    `{"copy":"${probeFirstWord}\\u0020${probeSecondWord}"}`,
    "probe.json",
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
    "html_default_ignorable_named_entity",
    `${compactOrganizationalProbe.slice(0, 4)}&InvisibleTimes;${compactOrganizationalProbe.slice(4)}`,
    "probe.html",
    compactOrganizationalProbe,
  ],
  [
    "html_legacy_entity_without_semicolon",
    `<span>${probeFirstWord}&nbsp ${probeSecondWord}</span>`,
    "probe.html",
    encodedPhraseProbe,
  ],
  [
    "html_legacy_entity_before_letter",
    `<span>${probeFirstWord}&nbsp${probeSecondWord}</span>`,
    "probe.html",
    encodedPhraseProbe,
  ],
  [
    "html_encoded_attribute",
    `<input aria-label="${probeFirstWord}&#32;${probeSecondWord}">`,
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
  [
    "markdown_reference_link",
    `${probeFirstWord} [${probeSecondWord}][policy]\n\n[policy]: https://example.test/policy`,
    "probe.md",
    encodedPhraseProbe,
  ],
  [
    "markdown_backslash_hard_break",
    `${probeFirstWord}\\\n${probeSecondWord}`,
    "probe.md",
    encodedPhraseProbe,
  ],
  [
    "css_generated_content_escape",
    `.status::after { content: "${probeFirstWord}\\20 ${probeSecondWord}"; }`,
    "probe.css",
    encodedPhraseProbe,
  ],
  [
    "css_escaped_content_property",
    `.status::after { con\\74 ent: "${probeFirstWord}\\20 ${probeSecondWord}"; }`,
    "probe.css",
    encodedPhraseProbe,
  ],
  [
    "css_string_declaration_terminator",
    `.status::after { content: "x;${probeFirstWord}\\20 ${probeSecondWord}"; }`,
    "probe.css",
    encodedPhraseProbe,
  ],
  [
    "css_adjacent_quoted_declaration_terminator",
    `.status::after { content: "${probeFirstWord} " "${probeSecondWord};"; }`,
    "probe.css",
    encodedPhraseProbe,
  ],
  [
    "quoted_html_attribute_boundary",
    `<span>${probeFirstWord} </span><span title='>'>${probeSecondWord}</span>`,
    "probe.html",
    encodedPhraseProbe,
  ],
  [
    "embedded_css_generated_content_escape",
    `<style>.status::after { content: "${probeFirstWord}\\20 ${probeSecondWord}"; }</style>`,
    "probe.html",
    encodedPhraseProbe,
  ],
  [
    "non_rendered_element_body",
    `<span>${probeFirstWord} </span><script>ignored()</script><span>${probeSecondWord}</span>`,
    "probe.html",
    encodedPhraseProbe,
  ],
  [
    "inline_script_visible_text_assignment",
    `<span id="copy"></span><script>document.querySelector("#copy").textContent = "${probeFirstWord}" + "\\u0020${probeSecondWord}";</script>`,
    "probe.html",
    encodedPhraseProbe,
  ],
  [
    "encoded_inline_script_type",
    `<script type="text&#47;javascript">document.body.textContent = "${probeFirstWord}" + " ${probeSecondWord}";</script>`,
    "probe.html",
    encodedPhraseProbe,
  ],
  [
    "inline_event_handler_literal_chain",
    `<button onclick='this.textContent = "${probeFirstWord} " + "${probeSecondWord}"'>Run</button>`,
    "probe.html",
    encodedPhraseProbe,
  ],
  [
    "inline_inner_html_literal_chain",
    `<div id="out"></div><script>` +
      `document.getElementById("out").innerHTML = ` +
      `"${probeFirstWord}" + "&#32;${probeSecondWord}";</script>`,
    "probe.html",
    encodedPhraseProbe,
  ],
  [
    "inline_bracket_inner_html_literal_chain",
    `<div id="out"></div><script>` +
      `out["innerHTML"] = ` +
      `"${probeFirstWord}" + "&#32;${probeSecondWord}";</script>`,
    "probe.html",
    encodedPhraseProbe,
  ],
  [
    "visible_submit_input_value",
    `<input type="submit" value="${probeFirstWord} ${probeSecondWord}">`,
    "probe.html",
    encodedPhraseProbe,
  ],
  [
    "visible_button_input_encoded_value",
    `<input type="button" value="${probeFirstWord}&#32;${probeSecondWord}">`,
    "probe.html",
    encodedPhraseProbe,
  ],
  [
    "visible_default_text_input_encoded_value",
    `<input value="${probeFirstWord}&#32;${probeSecondWord}">`,
    "probe.html",
    encodedPhraseProbe,
  ],
  [
    "visible_option_label_encoded_value",
    `<select><option label="${probeFirstWord}&#32;${probeSecondWord}">x</option></select>`,
    "probe.html",
    encodedPhraseProbe,
  ],
  [
    "rcdata_visible_text",
    `<textarea>${probeFirstWord} ${probeSecondWord}</textarea>`,
    "probe.html",
    encodedPhraseProbe,
  ],
  [
    "standalone_svg_text",
    `<svg><text>${probeFirstWord}<tspan> ${probeSecondWord}</tspan></text></svg>`,
    "probe.svg",
    encodedPhraseProbe,
  ],
  [
    "standalone_svg_cdata_text",
    `<svg><text>${probeFirstWord}<![CDATA[ ${probeSecondWord}]]></text></svg>`,
    "probe.svg",
    encodedPhraseProbe,
  ],
  [
    "xhtml_element_boundary",
    `<p>${probeFirstWord}<span> ${probeSecondWord}</span></p>`,
    "probe.xhtml",
    encodedPhraseProbe,
  ],
  [
    "default_ignorable_variation_selector",
    `${compactOrganizationalProbe.slice(0, 4)}${String.fromCodePoint(0xfe0f)}${compactOrganizationalProbe.slice(4)}`,
    "probe.html",
    compactOrganizationalProbe,
  ],
  ["nfkc_fullwidth", fullwidthCompactProbe, "probe.html", compactOrganizationalProbe],
  [
    "jsx_whitespace_expression",
    `<span>${probeFirstWord}</span>{' '}<span>${probeSecondWord}</span>`,
    "probe.jsx",
    encodedPhraseProbe,
  ],
  [
    "jsx_grouped_whitespace_expression",
    `<span>${probeFirstWord}</span>{((" " + ""))}<span>${probeSecondWord}</span>`,
    "probe.jsx",
    encodedPhraseProbe,
  ],
  [
    "jsx_static_string_child",
    `<p>{"${probeFirstWord} "}${probeSecondWord}</p>`,
    "probe.jsx",
    encodedPhraseProbe,
  ],
  [
    "jsx_comment_expression",
    `<span>${probeFirstWord}</span>{/* split */}<span> ${probeSecondWord}</span>`,
    "probe.jsx",
    encodedPhraseProbe,
  ],
  [
    "jsx_non_rendering_expression",
    `<span>${probeFirstWord}</span>{null}<span> ${probeSecondWord}</span>`,
    "probe.jsx",
    encodedPhraseProbe,
  ],
  [
    "jsx_statically_false_logical_child",
    `<p>${probeFirstWord} {false && "unused"}${probeSecondWord}</p>`,
    "probe.jsx",
    encodedPhraseProbe,
  ],
  [
    "python_implicit_literal_concatenation",
    `message = ("${probeFirstWord} " "${probeSecondWord}")`,
    "probe.py",
    encodedPhraseProbe,
  ],
  [
    "python_static_f_string",
    `message = f"${probeFirstWord}\\x20${probeSecondWord}"`,
    "probe.py",
    encodedPhraseProbe,
  ],
  [
    "python_named_unicode_escape",
    `message = "${probeFirstWord}\\N{SPACE}${probeSecondWord}"`,
    "probe.py",
    encodedPhraseProbe,
  ],
  [
    "python_static_f_string_substitution",
    `message = f"${compactOrganizationalProbe.slice(0, 2)}{''}${compactOrganizationalProbe.slice(2)}"`,
    "probe.py",
    compactOrganizationalProbe,
  ],
  [
    "python_nested_static_f_string",
    `message = f"${probeFirstWord} {f''}${probeSecondWord}"`,
    "probe.py",
    encodedPhraseProbe,
  ],
  [
    "python_static_f_string_conversion",
    `message = f"{'${probeFirstWord} '!s}${probeSecondWord}"`,
    "probe.py",
    encodedPhraseProbe,
  ],
  [
    "python_static_f_string_format",
    `message = f"{'${probeFirstWord} ':<7}${probeSecondWord}"`,
    "probe.py",
    encodedPhraseProbe,
  ],
  [
    "python_explicit_literal_concatenation",
    `message = "${probeFirstWord} " + "${probeSecondWord}"`,
    "probe.py",
    encodedPhraseProbe,
  ],
  [
    "python_grouped_literal_concatenation",
    `message = "${probeFirstWord} " + ("${probeSecondWord}")`,
    "probe.py",
    encodedPhraseProbe,
  ],
  [
    "python_grouped_newline_implicit_concatenation",
    `message = ("${probeFirstWord} "\n  "${probeSecondWord}")`,
    "probe.py",
    encodedPhraseProbe,
  ],
  [
    "markdown_visible_named_entity",
    `${probeFirstWord}&nbsp;${probeSecondWord}`,
    "probe.md",
    encodedPhraseProbe,
  ],
  [
    "markdown_unicode_case_folded_reference",
    `${probeFirstWord} [${probeSecondWord}][ς]\n\n[Σ]: https://example.test`,
    "probe.md",
    encodedPhraseProbe,
  ],
  [
    "markdown_inline_link_title",
    `[help](https://example.test "${probeFirstWord}&#32;${probeSecondWord}")`,
    "probe.md",
    encodedPhraseProbe,
  ],
  [
    "css_url_alternative_text",
    `.status::after { content: url("icon.svg") / "${probeFirstWord} ${probeSecondWord}"; }`,
    "probe.css",
    encodedPhraseProbe,
  ],
  [
    "css_rule_nested_in_supports",
    `@supports (display: grid) { ` +
      `.status::after { content: "${probeFirstWord}\\20 ${probeSecondWord}"; } }`,
    "probe.css",
    encodedPhraseProbe,
  ],
  [
    "scss_static_generated_content_interpolation",
    `.status::after { content: "${probeFirstWord} #{''}${probeSecondWord}"; }`,
    "probe.scss",
    encodedPhraseProbe,
  ],
  [
    "javascript_static_string_concat_call",
    `const label = "${probeFirstWord}".concat(" ${probeSecondWord}");`,
    "probe.js",
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

for (const [label, source, relativePath, target = encodedPhraseProbe] of [
  [
    "markdown_unmatched_delimiter",
    `${probeFirstWord} * ${probeSecondWord}`,
    "probe.md",
  ],
  [
    "python_separate_statements",
    `first = "${probeFirstWord} "\nsecond = "${probeSecondWord}"`,
    "probe.py",
  ],
  [
    "javascript_even_backslash",
    `"${compactOrganizationalProbe.slice(0, 2)}\\\\${compactOrganizationalProbe.slice(2)}"`,
    "probe.js",
    compactOrganizationalProbe,
  ],
  [
    "dynamic_template_interpolation",
    "`" + probeFirstWord + " ${separator}" + probeSecondWord + "`",
    "probe.js",
  ],
  [
    "constant_template_backslash_preserved",
    "`" +
      compactOrganizationalProbe.slice(0, 2) +
      '${"\\\\' +
      compactOrganizationalProbe[2] +
      '"}' +
      compactOrganizationalProbe.slice(3) +
      "`",
    "probe.js",
    compactOrganizationalProbe,
  ],
  [
    "python_raw_string_identity_escape",
    `r"${compactOrganizationalProbe.slice(0, 2)}\\${compactOrganizationalProbe.slice(2)}"`,
    "probe.py",
    compactOrganizationalProbe,
  ],
  [
    "machine_only_html_attribute",
    `<div data-policy="${probeFirstWord}&#32;${probeSecondWord}"></div>`,
    "probe.html",
  ],
  [
    "ambiguous_legacy_entity_in_attribute",
    `<div aria-label="${probeFirstWord}&nbsp${probeSecondWord}"></div>`,
    "probe.html",
  ],
  [
    "markdown_reference_punctuation_mismatch",
    `${probeFirstWord} [${probeSecondWord}][foo_bar]\n\n[foo-bar]: https://example.test`,
    "probe.md",
  ],
  [
    "markdown_code_span_markup",
    "`<span>" +
      compactOrganizationalProbe.slice(0, 4) +
      "</span><span>" +
      compactOrganizationalProbe.slice(4) +
      "</span>`",
    "probe.md",
    spacedOrganizationalProbe,
  ],
  [
    "css_alternative_content",
    `.status::after { content: "${compactOrganizationalProbe.slice(0, 4)}" / "${compactOrganizationalProbe.slice(4)}"; }`,
    "probe.css",
    compactOrganizationalProbe,
  ],
  [
    "css_comment_marker_inside_string",
    `.status::after { content: "${probeFirstWord}/*note*/ ${probeSecondWord}"; }`,
    "probe.css",
  ],
  [
    "css_url_resource_value",
    `.status::after { content: url("${probeFirstWord} ${probeSecondWord}"); }`,
    "probe.css",
  ],
  [
    "css_supports_condition",
    `@supports (content: "${probeFirstWord}\\20 ${probeSecondWord}") { .x { display: block; } }`,
    "probe.css",
  ],
  [
    "css_non_string_content_component",
    `.x { counter-reset: item 7 } ` +
      `.x::after { content: "${probeFirstWord} " ` +
      `counter(item) "${probeSecondWord}"; }`,
    "probe.css",
  ],
  [
    "python_comment_literal",
    `label = "${probeFirstWord} " # not "${probeSecondWord}"`,
    "probe.py",
  ],
  [
    "javascript_regex_literal",
    `const pattern = /"${probeFirstWord} " + "${probeSecondWord}"/;`,
    "probe.js",
  ],
  [
    "rcdata_tag_like_text",
    `<textarea>${probeFirstWord}<span> ${probeSecondWord}</textarea>`,
    "probe.html",
  ],
  [
    "dynamic_jsx_child",
    `<p>{"${probeFirstWord} "}{separator}${probeSecondWord}</p>`,
    "probe.jsx",
  ],
  ["markdown_code_entity", `\`${probeFirstWord}&#32;${probeSecondWord}\``, "probe.md"],
  [
    "markdown_indented_code_entity",
    `    ${probeFirstWord}&#32;${probeSecondWord}`,
    "probe.md",
  ],
  [
    "markdown_longer_closing_fence",
    `\`\`\`\n${probeFirstWord}&#32;${probeSecondWord}\n\`\`\`\``,
    "probe.md",
  ],
  [
    "commented_markup_attribute",
    `<!-- <img alt="${probeFirstWord}&#32;${probeSecondWord}"> -->`,
    "probe.html",
  ],
  [
    "typescript_template_literal_type",
    `type Label = \`${probeFirstWord} ${'${""}'}${probeSecondWord}\`;`,
    "probe.ts",
  ],
  [
    "inline_html_assignment_spelling_inside_string",
    `<script>const example = ".innerHTML = '${probeFirstWord}' + ` +
      `'&#32;${probeSecondWord}';";</script>`,
    "probe.html",
  ],
  [
    "string_raw_tag_with_comment",
    `String/* note */.raw\`${probeFirstWord}\\u0020${probeSecondWord}\``,
    "probe.js",
  ],
  [
    "string_raw_escape",
    `String.raw\`${probeFirstWord}\\u0020${probeSecondWord}\``,
    "probe.js",
  ],
]) {
  if (
    renderedSourceCandidates(source, relativePath).some((candidate) =>
      containsLanguagePhrase(normalizeLanguage(candidate), target),
    )
  ) {
    errors.push(`release_language_policy_self_test:${label}_false_positive`);
  }
}

const malformedKnownTextProbe = Buffer.concat([
  Buffer.from(encodedPhraseProbe, "utf8"),
  Buffer.alloc(4, 0xff),
]);
if (
  !decodeRepositoryTexts(malformedKnownTextProbe, "probe.html").some((decoded) =>
    containsLanguagePhrase(normalizeLanguage(decoded), encodedPhraseProbe),
  )
) {
  errors.push("release_language_policy_self_test:malformed_known_utf8_not_detected");
}

for (const trackedOutputDirectory of [".factory", "coverage", "dist", "workspaces"]) {
  if (excludedDirectories.has(trackedOutputDirectory))
    errors.push(
      `release_language_policy_self_test:tracked_output_excluded:${trackedOutputDirectory}`,
    );
}

const nulInterruptedUtf8Probe = Buffer.concat([
  Buffer.from(encodedPhraseProbe, "utf8"),
  Buffer.from([0]),
]);
if (
  !decodeRepositoryTexts(nulInterruptedUtf8Probe).some((decoded) =>
    containsLanguagePhrase(normalizeLanguage(decoded), encodedPhraseProbe),
  )
) {
  errors.push("release_language_policy_self_test:nul_utf8_not_detected");
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
  if (repositorySource.type === "error") {
    errors.push(
      `git_index_unreadable:${repositorySource.note}:exact_repository_cannot_be_scanned`,
    );
    return [];
  }
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
    const normalizedCandidates = decodeRepositoryTexts(
      data,
      entry.relativePath,
    ).flatMap((text) =>
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
