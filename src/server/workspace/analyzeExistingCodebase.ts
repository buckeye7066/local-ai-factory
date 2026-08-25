import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { promisify } from "node:util";
import type { PurposeEvidence } from "../../shared/schemas.js";
import { safeResolveExistingPath } from "./fileWriter.js";

const execFileAsync = promisify(execFile);
import { join, relative } from "node:path";

/**
 * analyzeExistingCodebase.ts — deterministic (no LLM call) understanding of an
 * ingested repo, in the same spirit as FlexFactor's stack detection: cheap,
 * reliable, and doesn't burn a model call just to know "this is a Vite+React
 * app with an Express server under server/". The result is injected as plain
 * text context into the SAME agents the greenfield pipeline already uses
 * (productSpecAgent, fileBuilderAgent) rather than growing a parallel prompt
 * stack for existing-codebase mode.
 */

const EXCLUDE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "out",
  "coverage",
  ".turbo",
  "venv",
  ".venv",
  "__pycache__",
  "target",
  ".factory",
]);

const MANIFEST_CANDIDATES = [
  "package.json",
  "client/package.json",
  "server/package.json",
  "requirements.txt",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "composer.json",
];

/** Hard prompt-safety bounds for evidence gathered from untrusted repos. */
export const PURPOSE_EVIDENCE_LIMIT = 30;
const EVIDENCE_CANDIDATE_LIMIT = 160;
const EVIDENCE_FILE_BYTE_LIMIT = 48 * 1024;
const EVIDENCE_TOTAL_BYTE_LIMIT = 256 * 1024;
const EVIDENCE_EXCERPT_LIMIT = 1_000;
const MAX_GIT_FILE_COUNT = 5_000;
const MAX_GIT_PATH_CHARS = 512_000;
const MAX_SINGLE_GIT_PATH_CHARS = 1_024;

const SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".go",
  ".html",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".mjs",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".svelte",
  ".ts",
  ".tsx",
  ".vue",
]);

const TEST_PATH_RE =
  /(^|\/)(?:__tests__|tests?|specs?)(?:\/|$)|(?:^|\/)(?:test_[^/]+|[^/]+\.(?:test|spec))\.[^.]+$/i;
const ROUTE_PATH_RE =
  /(^|\/)(?:api|controllers?|handlers?|routes?)(?:\/|$)|(?:^|\/)(?:route|router|server|controller|handler)\.[^.]+$/i;
const BOUNDARY_PATH_RE =
  /(^|\/)(?:adapters?|clients?|db|integrations?|models?|persistence|repositories?|schemas?|stores?)(?:\/|$)|(?:^|\/)[^/]*(?:adapter|client|database|integration|model|repository|schema|store)[^/]*\.[^.]+$/i;
const TEST_SIGNAL_RE =
  /\b(?:describe|it|test)\s*\(|\bdef\s+test_[A-Za-z0-9_]+|\bexpect\s*\(|\bassert(?:Equal|True|False|Raises)?\s*\(/;
const ROUTE_SIGNAL_RE =
  /\b(?:app|router|server)\s*\.\s*(?:get|post|put|patch|delete|use)\s*\(|\bexport\s+(?:async\s+)?function\s+(?:GET|POST|PUT|PATCH|DELETE)\b|<Route\b[^>]*\bpath=|@(?:app|router)\.(?:get|post|put|patch|delete|route)\s*\(/i;
const SOURCE_SIGNAL_RE =
  /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const)\b|\b(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(|\bclass\s+[A-Za-z_$][\w$]*\b|\b(?:interface|type)\s+[A-Za-z_$][\w$]*\s*[={]/;
const GAP_SIGNAL_RE =
  /\b(?:TODO|FIXME|not implemented|unsupported|known limitation|skip(?:ped)?)\b|throw\s+new\s+Error\s*\(\s*["'`]Not implemented/i;
const BOUNDARY_SIGNAL_RE =
  /\b(?:localStorage|sessionStorage|indexedDB|fetch|axios|prisma|sequelize|knex)\b|\b(?:SELECT|INSERT|UPDATE|DELETE)\s+(?:FROM|INTO|[A-Za-z_])/i;

export interface RepoAnalysis {
  rootPath: string;
  appNameGuess: string;
  detectedStack: string[];
  fileTree: string[];
  manifestExcerpts: { path: string; excerpt: string }[];
  readmeExcerpt: string;
  /** Bounded, line-addressable observations used to ground a purpose profile. */
  purposeEvidence: PurposeEvidence[];
  stackSummary: string;
}

async function walk(root: string, maxEntries: number): Promise<string[]> {
  const out: string[] = [];
  async function recurse(dir: string, depth: number): Promise<void> {
    if (out.length >= maxEntries || depth > 6) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= maxEntries) return;
      if (e.isDirectory()) {
        if (EXCLUDE_DIRS.has(e.name)) continue;
        await recurse(join(dir, e.name), depth + 1);
      } else {
        out.push(relative(root, join(dir, e.name)).split("\\").join("/"));
      }
    }
  }
  await recurse(root, 0);
  return out;
}

function detectFromPackageJson(raw: string): string[] {
  const tags: string[] = [];
  try {
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const has = (name: string) => name in deps;
    if (has("react")) tags.push("React");
    if (has("vue")) tags.push("Vue");
    if (has("vite")) tags.push("Vite");
    if (has("express")) tags.push("Express");
    if (has("fastify")) tags.push("Fastify");
    if (has("next")) tags.push("Next.js");
    if (has("typescript")) tags.push("TypeScript");
    if (has("prisma") || has("@prisma/client")) tags.push("Prisma");
    if (has("pg") || has("sequelize") || has("knex")) tags.push("PostgreSQL/SQL");
    if (has("sqlite3") || has("better-sqlite3")) tags.push("SQLite");
    if (has("tailwindcss")) tags.push("Tailwind CSS");
    if (has("vitest")) tags.push("Vitest");
    if (has("jest")) tags.push("Jest");
  } catch {
    // not valid JSON — ignore
  }
  return tags;
}

/** Bound a string to a max length for prompt injection. */
function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "\n…(truncated)" : s;
}

function fullFileDigest(contents: string): string {
  return `sha256:${createHash("sha256").update(contents, "utf8").digest("hex")}`;
}

function normalizeRepoPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

interface BoundedRepoFile {
  raw: string;
  size: number;
}

/** Read only a private regular file whose entire path remains inside the repo. */
async function readBoundedRepoFile(
  rootPath: string,
  repoPath: string,
  maxBytes = EVIDENCE_FILE_BYTE_LIMIT,
): Promise<BoundedRepoFile | null> {
  let abs: string;
  try {
    // Reject symlinks in every path component and verify physical containment.
    abs = safeResolveExistingPath(rootPath, repoPath);
  } catch {
    return null;
  }
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const handle = await open(abs, constants.O_RDONLY | noFollow).catch(() => null);
  if (!handle) return null;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink > 1 || info.size > maxBytes) return null;
    const raw = await handle.readFile("utf8");
    if (!raw || raw.includes("\0")) return null;
    return { raw, size: info.size };
  } finally {
    await handle.close().catch(() => {});
  }
}

function sourceExtension(path: string): string {
  const name = path.toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot) : "";
}

function firstSignalLine(lines: string[], pattern: RegExp): number {
  return lines.findIndex((line) => pattern.test(line));
}

function excerptAround(
  lines: string[],
  index: number,
): {
  excerpt: string;
  lineStart: number;
  lineEnd: number;
} {
  const start = Math.max(0, index - 1);
  const end = Math.min(lines.length, index + 3);
  return {
    excerpt: clip(lines.slice(start, end).join("\n").trim(), EVIDENCE_EXCERPT_LIMIT),
    lineStart: start + 1,
    lineEnd: Math.max(start + 1, end),
  };
}

function firstMeaningfulLine(lines: string[]): number {
  return lines.findIndex((line) => {
    const value = line.trim();
    return value.length > 0 && !value.startsWith("//") && !value.startsWith("/*");
  });
}

function candidateKind(path: string): PurposeEvidence["kind"] {
  if (TEST_PATH_RE.test(path)) return "test";
  if (ROUTE_PATH_RE.test(path)) return "route";
  return "source";
}

function candidatePriority(path: string): number {
  const kind = candidateKind(path);
  if (kind === "route") return 0;
  if (kind === "test") return 1;
  return BOUNDARY_PATH_RE.test(path) ? 2 : 3;
}

function evidenceSignal(kind: PurposeEvidence["kind"], path: string): string {
  if (kind === "route") return "route or request handler";
  if (kind === "test") return "executable behavior test";
  if (BOUNDARY_PATH_RE.test(path)) return "integration, persistence, or data boundary";
  return "exported or named source behavior";
}

async function collectPurposeEvidence(
  rootPath: string,
  fileTree: string[],
  manifests: { path: string; raw: string }[],
  readme: { path: string; raw: string } | null,
): Promise<PurposeEvidence[]> {
  const evidence: PurposeEvidence[] = [];
  const add = (item: Omit<PurposeEvidence, "id">): void => {
    if (evidence.length >= PURPOSE_EVIDENCE_LIMIT || !item.excerpt.trim()) return;
    evidence.push({
      ...item,
      id: `PE-${String(evidence.length + 1).padStart(3, "0")}`,
    });
  };

  if (readme) {
    const lines = readme.raw.split(/\r?\n/);
    const index = Math.max(0, firstMeaningfulLine(lines));
    add({
      kind: "readme",
      path: readme.path,
      sourceDigest: fullFileDigest(readme.raw),
      signal: "repository description",
      ...excerptAround(lines, index),
    });
  }

  for (const manifest of manifests) {
    if (evidence.length >= PURPOSE_EVIDENCE_LIMIT) break;
    const lines = manifest.raw.split(/\r?\n/);
    const dependencyIndex = firstSignalLine(
      lines,
      /\b(?:dependencies|devDependencies|requires?|scripts?)\b/i,
    );
    const index = Math.max(
      0,
      dependencyIndex >= 0 ? dependencyIndex : firstMeaningfulLine(lines),
    );
    add({
      kind: "manifest",
      path: manifest.path,
      sourceDigest: fullFileDigest(manifest.raw),
      signal: "runtime manifest and dependency surface",
      ...excerptAround(lines, index),
    });
  }

  const candidates = [...new Set(fileTree.map(normalizeRepoPath))]
    .filter((path) => SOURCE_EXTENSIONS.has(sourceExtension(path)))
    .filter(
      (path) => !/(^|\/)(?:vendor|generated|fixtures?|snapshots?)(\/|$)/i.test(path),
    )
    .filter((path) => !/\.(?:min|bundle)\.[^.]+$/i.test(path))
    .sort((a, b) => candidatePriority(a) - candidatePriority(b) || a.localeCompare(b))
    .slice(0, EVIDENCE_CANDIDATE_LIMIT);

  let bytesRead = 0;
  for (const path of candidates) {
    if (
      evidence.length >= PURPOSE_EVIDENCE_LIMIT ||
      bytesRead >= EVIDENCE_TOTAL_BYTE_LIMIT
    ) {
      break;
    }
    const file = await readBoundedRepoFile(rootPath, path);
    if (!file || bytesRead + file.size > EVIDENCE_TOTAL_BYTE_LIMIT) continue;
    const { raw } = file;
    bytesRead += file.size;

    const lines = raw.split(/\r?\n/);
    let kind = candidateKind(path);
    let index = firstSignalLine(
      lines,
      kind === "test"
        ? TEST_SIGNAL_RE
        : kind === "route"
          ? ROUTE_SIGNAL_RE
          : SOURCE_SIGNAL_RE,
    );

    // Behavior wins over a generic filename classification. This catches API
    // routes embedded in app entrypoints and tests kept outside test folders.
    if (kind === "source") {
      const routeIndex = firstSignalLine(lines, ROUTE_SIGNAL_RE);
      const testIndex = firstSignalLine(lines, TEST_SIGNAL_RE);
      if (routeIndex >= 0 && (testIndex < 0 || routeIndex <= testIndex)) {
        kind = "route";
        index = routeIndex;
      } else if (testIndex >= 0) {
        kind = "test";
        index = testIndex;
      }
    }

    if (index < 0 && kind !== "source") index = firstMeaningfulLine(lines);
    if (index < 0) continue;
    add({
      kind,
      path,
      sourceDigest: fullFileDigest(raw),
      signal: evidenceSignal(kind, path),
      ...excerptAround(lines, index),
    });

    const gapIndex = firstSignalLine(lines, GAP_SIGNAL_RE);
    if (gapIndex >= 0 && gapIndex !== index) {
      add({
        kind: kind === "test" ? "test" : "source",
        path,
        sourceDigest: fullFileDigest(raw),
        signal: "explicit gap, skipped behavior, or unfinished implementation",
        ...excerptAround(lines, gapIndex),
      });
    }
    const boundaryIndex = firstSignalLine(lines, BOUNDARY_SIGNAL_RE);
    if (boundaryIndex >= 0 && boundaryIndex !== index && boundaryIndex !== gapIndex) {
      add({
        kind: "source",
        path,
        sourceDigest: fullFileDigest(raw),
        signal: "external integration or persistence behavior",
        ...excerptAround(lines, boundaryIndex),
      });
    }
  }

  return evidence;
}

async function gitWorkspaceFiles(rootPath: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", rootPath, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      {
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    const files: string[] = [];
    let totalChars = 0;
    for (const rawPath of String(stdout).split("\0")) {
      const path = rawPath.replace(/\\/g, "/");
      if (
        !path ||
        path.length > MAX_SINGLE_GIT_PATH_CHARS ||
        /[\u0000-\u001f\u007f]/.test(path)
      ) {
        continue;
      }
      if (
        files.length >= MAX_GIT_FILE_COUNT ||
        totalChars + path.length > MAX_GIT_PATH_CHARS
      ) {
        break;
      }
      files.push(path);
      totalChars += path.length;
    }
    return files.length > 0 ? files : null;
  } catch {
    return null;
  }
}

export async function analyzeExistingCodebase(rootPath: string): Promise<RepoAnalysis> {
  // Extend workspaces are git clones. Their tracked index is complete and
  // deterministic, unlike a depth-first directory walk capped at 1,500 items
  // that can fill up on tooling/docs before ever seeing src/App.jsx.
  const fileTree = (await gitWorkspaceFiles(rootPath)) ?? (await walk(rootPath, 1500));

  const manifestExcerpts: { path: string; excerpt: string }[] = [];
  const rawManifests: { path: string; raw: string }[] = [];
  let detectedStack: string[] = [];
  let appNameGuess = "";

  for (const candidate of MANIFEST_CANDIDATES) {
    const file = await readBoundedRepoFile(rootPath, candidate);
    if (!file) continue;
    const { raw } = file;
    manifestExcerpts.push({ path: candidate, excerpt: clip(raw, 2500) });
    rawManifests.push({ path: candidate, raw });
    if (candidate.endsWith("package.json")) {
      detectedStack.push(...detectFromPackageJson(raw));
      if (!appNameGuess) {
        try {
          const name = (JSON.parse(raw) as { name?: string }).name;
          if (name) appNameGuess = name;
        } catch {
          /* ignore */
        }
      }
    } else if (candidate === "requirements.txt" || candidate === "pyproject.toml") {
      detectedStack.push("Python");
    } else if (candidate === "go.mod") {
      detectedStack.push("Go");
    } else if (candidate === "Cargo.toml") {
      detectedStack.push("Rust");
    } else if (candidate === "pom.xml") {
      detectedStack.push("Java (Maven)");
    } else if (candidate === "composer.json") {
      detectedStack.push("PHP");
    }
  }
  detectedStack = [...new Set(detectedStack)];
  if (!appNameGuess) {
    appNameGuess = rootPath.split(/[\\/]/).filter(Boolean).pop() ?? "existing-app";
  }

  let readmeExcerpt = "";
  let rawReadme: { path: string; raw: string } | null = null;
  for (const readmeName of ["README.md", "Readme.md", "readme.md"]) {
    const file = await readBoundedRepoFile(rootPath, readmeName);
    if (file) {
      readmeExcerpt = clip(file.raw, 2000);
      rawReadme = { path: readmeName, raw: file.raw };
      break;
    }
  }

  const purposeEvidence = await collectPurposeEvidence(
    rootPath,
    fileTree,
    rawManifests,
    rawReadme,
  );

  const stackSummary =
    (detectedStack.length ? detectedStack.join(", ") : "stack not auto-detected") +
    ` — ${fileTree.length} file(s) scanned, manifests: ${manifestExcerpts.map((m) => m.path).join(", ") || "none found"}.`;

  return {
    rootPath,
    appNameGuess,
    detectedStack,
    fileTree,
    manifestExcerpts,
    readmeExcerpt,
    purposeEvidence,
    stackSummary,
  };
}
