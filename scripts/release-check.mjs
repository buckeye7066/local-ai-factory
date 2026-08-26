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
  const candidates = [data.toString("utf8")];
  if (!data.includes(0)) return uniqueTextCandidates(candidates);

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
      /\\u\{(0*[0-9A-Fa-f]{1,6})\}|\\u([0-9A-Fa-f]{4})|\\x([0-9A-Fa-f]{2})|\\(?:\r\n|[\n\r\u2028\u2029])|\\([0btnvfr"'`\\])/g,
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

function renderStaticLiteral(literal) {
  if (!literal.startsWith("`")) return unquoteStaticLiteral(literal);
  const body = literal
    .slice(1, -1)
    .replace(
      /(?<!\\)\$\{\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)\s*\}/gs,
      (match, interpolation) => unquoteStaticLiteral(interpolation),
    );
  return unquoteStaticLiteral(`\`${body}\``);
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

function renderCssContent(value) {
  const candidates = [];
  const withoutComments = value.replace(/\/\*[\s\S]*?\*\//g, "");
  const declarationPattern = /\bcontent\s*:\s*([^;}]+)/gi;
  const stringPattern = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/gs;
  for (const declaration of withoutComments.matchAll(declarationPattern)) {
    let combined = "";
    for (const literal of declaration[1].matchAll(stringPattern)) {
      const rendered = decodeCssString(literal[0]);
      candidates.push(rendered);
      combined += rendered;
    }
    if (combined) candidates.push(combined);
  }
  return candidates;
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

function renderMarkupAttributeValues(value) {
  const candidates = [];
  const tagPattern =
    /<[A-Za-z][A-Za-z0-9:-]*(?:\s+(?:"[^"]*"|'[^']*'|[^'">])*)?\s*\/?>/gs;
  const attributePattern =
    /(?:^|\s)[^\s"'=<>`]+\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  for (const tag of value.matchAll(tagPattern)) {
    for (const attribute of tag[0].matchAll(attributePattern)) {
      candidates.push(
        decodeHtmlCharacterReferences(attribute[1] ?? attribute[2] ?? attribute[3]),
      );
    }
  }
  return candidates;
}

function stripJsxComments(value) {
  return value.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "");
}

function replaceJsxWhitespaceExpressions(value) {
  return value.replace(
    /\{\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)\s*\}/gs,
    (match, literal) => {
      const rendered = renderStaticLiteral(literal);
      return rendered && /^\s+$/u.test(rendered) ? rendered : match;
    },
  );
}

function stripMarkupNodes(value) {
  return value
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s+[^<>]*?)?\s*\/?>/gs, " ");
}

function renderMarkdown(value) {
  const referenceIds = new Set(
    [...value.matchAll(/^\s{0,3}\[([^\]]+)\]:\s+\S+.*$/gm)].map((match) =>
      normalizeLanguage(match[1]),
    ),
  );
  const withoutDefinitions = value.replace(/^\s{0,3}\[[^\]]+\]:\s+\S+.*$/gm, "");
  return stripMarkupNodes(withoutDefinitions)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/!?\[([^\]]+)\]\[([^\]]*)\]/g, (match, label, reference) =>
      referenceIds.has(normalizeLanguage(reference || label)) ? label : match,
    )
    .replace(/!?\[([^\]]+)\]/g, (match, label) =>
      referenceIds.has(normalizeLanguage(label)) ? label : match,
    )
    .replace(/(`+)([\s\S]*?)\1/g, "$2")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "$1")
    .replace(/__(?=\S)([\s\S]*?\S)__/g, "$1")
    .replace(/\*(?=\S)([^*\r\n]*?\S)\*/g, "$1")
    .replace(/_(?=\S)([^_\r\n]*?\S)_/g, "$1");
}

function renderPythonString(literal) {
  const prefixMatch = /^([rRuUbBfF]{0,2})("""|'''|"|')/.exec(literal);
  if (!prefixMatch) return literal;
  const prefix = prefixMatch[1].toLowerCase();
  const delimiter = prefixMatch[2];
  const body = literal.slice(prefixMatch[0].length, -delimiter.length);
  if (prefix.includes("r")) return body;
  return `"${body.replace(/"/g, '\\"')}"`
    .slice(1, -1)
    .replace(
      /\\u\{([0-9A-Fa-f]{1,6})\}|\\U([0-9A-Fa-f]{8})|\\u([0-9A-Fa-f]{4})|\\x([0-9A-Fa-f]{2})|\\([0-7]{1,3})|\\(?:\r\n|[\n\r])|\\([abtnvfr"'\\])/g,
      (
        escape,
        bracedUnicode,
        longUnicode,
        fixedUnicode,
        hexadecimal,
        octal,
        simple,
      ) => {
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

function renderPythonLiterals(value) {
  const candidates = [];
  const literalPattern =
    /[rRuUbBfF]{0,2}(?:"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g;
  let previous = null;
  let chain = null;
  for (const match of value.matchAll(literalPattern)) {
    const rendered = renderPythonString(match[0]);
    candidates.push(rendered);
    const separator = previous ? value.slice(previous.end, match.index) : "";
    if (previous && /^(?:(?:[ \t\f]+)|(?:#[^\r\n]*$)|(?:\\\r?\n))*$/.test(separator)) {
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

function renderedSourceCandidates(value, relativePath) {
  const extension = sourceExtension(relativePath);
  const candidates = [];
  const visibleValue = markupSourceExtensions.has(extension)
    ? stripJsxComments(replaceJsxWhitespaceExpressions(value))
    : value;
  if (markupSourceExtensions.has(extension)) {
    candidates.push(decodeHtmlCharacterReferences(stripMarkupNodes(visibleValue)));
    candidates.push(...renderMarkupAttributeValues(visibleValue));
    candidates.push(...renderEmbeddedCssContent(visibleValue));
  }
  if (markdownSourceExtensions.has(extension))
    candidates.push(decodeHtmlCharacterReferences(renderMarkdown(visibleValue)));
  if (cssSourceExtensions.has(extension)) candidates.push(...renderCssContent(value));
  if (extension === ".py" || extension === ".pyw")
    candidates.push(...renderPythonLiterals(value));
  if (!literalSourceExtensions.has(extension)) return candidates;

  const literalPattern = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/gs;
  let previous = null;
  let chain = null;
  for (const match of value.matchAll(literalPattern)) {
    const renderedLiteral = renderStaticLiteral(match[0]);
    candidates.push(renderedLiteral);
    if (
      previous &&
      /^\s*\+\s*$/.test(
        value
          .slice(previous.end, match.index)
          .replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, ""),
      )
    ) {
      chain = (chain ?? renderStaticLiteral(previous.literal)) + renderedLiteral;
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
const fullwidthCompactProbe = [...compactOrganizationalProbe]
  .map((character) =>
    String.fromCodePoint((character.codePointAt(0) ?? 0) + 0xfee0),
  )
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
    "ecmascript_line_separator_continuation",
    `"${compactOrganizationalProbe.slice(0, 4)}\\${String.fromCodePoint(0x2028)}${compactOrganizationalProbe.slice(4)}"`,
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
    "html_legacy_entity_without_semicolon",
    `<span>${probeFirstWord}&nbsp ${probeSecondWord}</span>`,
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
    "css_generated_content_escape",
    `.status::after { content: "${probeFirstWord}\\20 ${probeSecondWord}"; }`,
    "probe.css",
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
    "default_ignorable_variation_selector",
    `${compactOrganizationalProbe.slice(0, 4)}${String.fromCodePoint(0xfe0f)}${compactOrganizationalProbe.slice(4)}`,
    "probe.html",
    compactOrganizationalProbe,
  ],
  [
    "nfkc_fullwidth",
    fullwidthCompactProbe,
    "probe.html",
    compactOrganizationalProbe,
  ],
  [
    "jsx_whitespace_expression",
    `<span>${probeFirstWord}</span>{' '}<span>${probeSecondWord}</span>`,
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
    "python_implicit_literal_concatenation",
    `message = ("${probeFirstWord} " "${probeSecondWord}")`,
    "probe.py",
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

for (const [label, source, relativePath] of [
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
]) {
  if (
    renderedSourceCandidates(source, relativePath).some((candidate) =>
      containsLanguagePhrase(normalizeLanguage(candidate), encodedPhraseProbe),
    )
  ) {
    errors.push(`release_language_policy_self_test:${label}_false_positive`);
  }
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
