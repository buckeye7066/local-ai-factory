import { readdir, readFile, stat } from "node:fs/promises";
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

export interface RepoAnalysis {
  rootPath: string;
  appNameGuess: string;
  detectedStack: string[];
  fileTree: string[];
  manifestExcerpts: { path: string; excerpt: string }[];
  readmeExcerpt: string;
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

export async function analyzeExistingCodebase(rootPath: string): Promise<RepoAnalysis> {
  const fileTree = await walk(rootPath, 1500);

  const manifestExcerpts: { path: string; excerpt: string }[] = [];
  let detectedStack: string[] = [];
  let appNameGuess = "";

  for (const candidate of MANIFEST_CANDIDATES) {
    const abs = join(rootPath, candidate);
    const st = await stat(abs).catch(() => null);
    if (!st || !st.isFile()) continue;
    const raw = await readFile(abs, "utf8").catch(() => "");
    if (!raw) continue;
    manifestExcerpts.push({ path: candidate, excerpt: clip(raw, 2500) });
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
  for (const readmeName of ["README.md", "Readme.md", "readme.md"]) {
    const raw = await readFile(join(rootPath, readmeName), "utf8").catch(() => "");
    if (raw) {
      readmeExcerpt = clip(raw, 2000);
      break;
    }
  }

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
    stackSummary,
  };
}
