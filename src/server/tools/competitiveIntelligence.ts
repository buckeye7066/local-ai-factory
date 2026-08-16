import type { Architecture, ProductSpec } from "../../shared/schemas.js";
import { webFetchTool } from "./webFetch.js";
import { webSearchTool } from "./webSearch.js";

export type LicenseReusePolicy =
  | "direct-use"
  | "conditional-review"
  | "reference-only";

export interface LicenseAssessment {
  spdxId: string;
  name: string;
  policy: LicenseReusePolicy;
  reason: string;
  evidenceUrl: string;
}

export interface SourceEvidence {
  path: string;
  url: string;
  excerpt: string;
}

export interface CompetitiveCandidate {
  id: string;
  kind: "repository" | "web";
  name: string;
  url: string;
  description: string;
  stars: number;
  archived: boolean;
  updatedAt: string;
  discoveryEvidence: string[];
  license: LicenseAssessment;
  fileTree: string[];
  sourceEvidence: SourceEvidence[];
  inspectionError: string;
}

export interface CompetitiveDossier {
  queries: string[];
  candidates: CompetitiveCandidate[];
  discoveredCount: number;
  inspectedCount: number;
  generatedAt: string;
}

interface GitHubRepoRef {
  owner: string;
  repo: string;
  canonicalUrl: string;
}

interface GitHubRepositoryResponse {
  name?: string;
  full_name?: string;
  html_url?: string;
  description?: string | null;
  stargazers_count?: number;
  archived?: boolean;
  pushed_at?: string;
  default_branch?: string;
  license?: {
    key?: string;
    name?: string;
    spdx_id?: string;
    url?: string | null;
  } | null;
}

interface GitHubTreeResponse {
  tree?: Array<{ path?: string; type?: string; size?: number }>;
  truncated?: boolean;
}

const GITHUB_API = "https://api.github.com";
const MAX_DISCOVERED = 24;
const MAX_INSPECTED = 8;
const MAX_SOURCE_FILES = 24;
const MAX_SOURCE_BYTES = 360_000;
const MAX_FILE_BYTES = 28_000;
const MAX_EVIDENCE_EXCERPT = 1800;
const REQUEST_TIMEOUT_MS = 15_000;

const TEXT_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".graphql",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".md",
  ".php",
  ".prisma",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".svelte",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".vue",
  ".yaml",
  ".yml",
]);

const IGNORED_PATH_PARTS = [
  "node_modules/",
  "vendor/",
  "dist/",
  "build/",
  "coverage/",
  ".next/",
  ".cache/",
  "fixtures/",
  "__snapshots__/",
];

const PRIORITY_FILENAMES = new Set([
  "readme.md",
  "package.json",
  "pyproject.toml",
  "cargo.toml",
  "go.mod",
  "composer.json",
  "gemfile",
  "dockerfile",
]);

function normalizedSpdx(value: string | null | undefined): string {
  return (value ?? "NOASSERTION").trim().toUpperCase();
}

/** Identify common licenses from their canonical notice text. */
export function detectLicenseFromText(text: string): string | null {
  const normalized = text.toLowerCase().replace(/\s+/g, " ");
  if (normalized.includes("gnu affero general public license")) return "AGPL-3.0";
  if (normalized.includes("gnu lesser general public license")) return "LGPL-3.0";
  if (normalized.includes("mozilla public license") && normalized.includes("2.0")) {
    return "MPL-2.0";
  }
  if (normalized.includes("apache license") && normalized.includes("version 2.0")) {
    return "APACHE-2.0";
  }
  if (normalized.includes("gnu general public license")) return "GPL-3.0";
  if (
    normalized.includes("permission is hereby granted, free of charge") &&
    normalized.includes("the software is provided \"as is\"")
  ) {
    return "MIT";
  }
  if (
    normalized.includes("redistribution and use in source and binary forms") &&
    normalized.includes("neither the name")
  ) {
    return "BSD-3-CLAUSE";
  }
  if (normalized.includes("isc license") && normalized.includes("permission to use, copy")) {
    return "ISC";
  }
  return null;
}

/**
 * Conservative code-reuse policy. This is an engineering gate, not legal
 * advice: anything that is not plainly permissive is prevented from direct
 * source reuse and remains available only as documented reference material.
 */
export function assessLicense(
  spdxId: string | null | undefined,
  name = "Unknown license",
  evidenceUrl = "",
): LicenseAssessment {
  const spdx = normalizedSpdx(spdxId);
  const permissive = new Set([
    "0BSD",
    "APACHE-2.0",
    "BSD-2-CLAUSE",
    "BSD-3-CLAUSE",
    "BSL-1.0",
    "CC0-1.0",
    "ISC",
    "MIT",
    "UNLICENSE",
    "ZLIB",
  ]);
  const conditional = new Set([
    "EPL-1.0",
    "EPL-2.0",
    "LGPL-2.0",
    "LGPL-2.1",
    "LGPL-3.0",
    "MPL-2.0",
  ]);

  if (permissive.has(spdx)) {
    return {
      spdxId: spdx,
      name,
      policy: "direct-use",
      reason: "Recognized permissive license; retain required notices and attribution.",
      evidenceUrl,
    };
  }
  if (conditional.has(spdx)) {
    return {
      spdxId: spdx,
      name,
      policy: "conditional-review",
      reason:
        "Weak-copyleft or reciprocal terms may be compatible only under specific linkage, modification, and distribution conditions.",
      evidenceUrl,
    };
  }
  return {
    spdxId: spdx,
    name,
    policy: "reference-only",
    reason:
      spdx === "NOASSERTION" || spdx === "OTHER" || spdx === ""
        ? "No reliably identified license; direct source reuse is prohibited."
        : "License is copyleft, source-available, proprietary, or otherwise not automatically cleared for direct reuse.",
    evidenceUrl,
  };
}

export function parseGitHubRepoUrl(raw: string): GitHubRepoRef | null {
  try {
    const url = new URL(raw);
    if (url.hostname.toLowerCase() !== "github.com") return null;
    const parts = url.pathname
      .split("/")
      .filter(Boolean)
      .slice(0, 2);
    if (parts.length !== 2) return null;
    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/i, "");
    if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
      return null;
    }
    return {
      owner,
      repo,
      canonicalUrl: `https://github.com/${owner}/${repo}`,
    };
  } catch {
    return null;
  }
}

function extension(path: string): string {
  const name = path.toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot) : "";
}

function termsFor(spec: ProductSpec, arch: Architecture): string[] {
  const raw = [
    spec.appName,
    spec.tagline,
    spec.targetUser,
    ...spec.coreFeatures,
    ...spec.userFlows,
    arch.frontend,
    arch.backend,
  ]
    .join(" ")
    .toLowerCase()
    .match(/[a-z][a-z0-9-]{3,}/g);
  return [...new Set(raw ?? [])]
    .filter((word) => !new Set(["application", "feature", "users", "using", "with", "from", "that", "this"]).has(word))
    .slice(0, 32);
}

export function rankRelevantPaths(paths: string[], terms: string[]): string[] {
  const normalizedTerms = terms.map((t) => t.toLowerCase()).filter(Boolean);
  return paths
    .filter((path) => {
      const lower = path.toLowerCase();
      const basename = lower.split("/").pop() ?? "";
      if (IGNORED_PATH_PARTS.some((part) => lower.includes(part))) return false;
      if (/\.(min|map|lock)$/i.test(lower)) return false;
      if (
        /^(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.ya?ml|yarn\.lock|bun\.lockb?|cargo\.lock|composer\.lock|gemfile\.lock|poetry\.lock|uv\.lock)$/i.test(
          basename,
        )
      ) {
        return false;
      }
      return TEXT_EXTENSIONS.has(extension(lower)) || PRIORITY_FILENAMES.has(basename);
    })
    .map((path) => {
      const lower = path.toLowerCase();
      let score = 0;
      if (PRIORITY_FILENAMES.has(lower.split("/").pop() ?? "")) score += 12;
      if (/^(src|app|lib|packages|server|client)\//.test(lower)) score += 5;
      if (/(service|provider|adapter|route|controller|model|schema|auth|search|integration)/.test(lower)) score += 4;
      for (const term of normalizedTerms) if (lower.includes(term)) score += 3;
      if (/test|spec|example|demo/.test(lower)) score -= 2;
      return { path, score };
    })
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .map((entry) => entry.path);
}

function githubHeaders(): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "factory-deck-competitive-intelligence/1.0",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: githubHeaders(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return (await response.json()) as T;
}

async function fetchText(url: string, maxBytes = MAX_FILE_BYTES): Promise<string> {
  const response = await fetch(url, {
    headers: { "User-Agent": "factory-deck-competitive-intelligence/1.0" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();
  return new TextDecoder("utf-8", { fatal: false }).decode(buffer.slice(0, maxBytes));
}

function rawGitHubUrl(ref: GitHubRepoRef, branch: string, path: string): string {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${branch}/${encodedPath}`;
}

async function inspectGitHubRepository(
  ref: GitHubRepoRef,
  discoveryEvidence: string[],
  terms: string[],
): Promise<CompetitiveCandidate> {
  const metadata = await fetchJson<GitHubRepositoryResponse>(
    `${GITHUB_API}/repos/${ref.owner}/${ref.repo}`,
  );
  const branch = metadata.default_branch || "main";
  const tree = await fetchJson<GitHubTreeResponse>(
    `${GITHUB_API}/repos/${ref.owner}/${ref.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
  );
  const blobPaths = (tree.tree ?? [])
    .filter((entry) => entry.type === "blob" && entry.path)
    .map((entry) => entry.path as string);
  const ranked = rankRelevantPaths(blobPaths, terms).slice(0, MAX_SOURCE_FILES);
  const sourceEvidence: SourceEvidence[] = [];
  let usedBytes = 0;

  for (const path of ranked) {
    if (usedBytes >= MAX_SOURCE_BYTES) break;
    const url = rawGitHubUrl(ref, branch, path);
    try {
      const text = await fetchText(url, Math.min(MAX_FILE_BYTES, MAX_SOURCE_BYTES - usedBytes));
      usedBytes += text.length;
      sourceEvidence.push({
        path,
        url,
        excerpt: text.slice(0, MAX_EVIDENCE_EXCERPT),
      });
    } catch {
      // One inaccessible/binary-looking file must not discard the repository.
    }
  }

  const licensePath = blobPaths.find((path) =>
    /(^|\/)(license|licence|copying|notice)(\.[a-z0-9]+)?$/i.test(path),
  );
  const licenseUrl = licensePath
    ? `${ref.canonicalUrl}/blob/${branch}/${licensePath}`
    : metadata.license?.url || `${ref.canonicalUrl}/tree/${branch}`;
  let declaredSpdx = metadata.license?.spdx_id;
  let detectedSpdx: string | null = null;
  if (licensePath) {
    try {
      const licenseText = await fetchText(rawGitHubUrl(ref, branch, licensePath), 80_000);
      detectedSpdx = detectLicenseFromText(licenseText);
      if (!declaredSpdx || normalizedSpdx(declaredSpdx) === "NOASSERTION") {
        declaredSpdx = detectedSpdx ?? declaredSpdx;
      }
    } catch {
      // Missing evidence is handled conservatively by assessLicense below.
    }
  }
  let license = assessLicense(
    declaredSpdx,
    metadata.license?.name || metadata.license?.key || detectedSpdx || "Unknown license",
    String(licenseUrl),
  );
  if (
    detectedSpdx &&
    declaredSpdx &&
    normalizedSpdx(declaredSpdx) !== normalizedSpdx(detectedSpdx)
  ) {
    license = {
      ...license,
      policy: "reference-only",
      reason: `License conflict: repository metadata declares ${declaredSpdx}, but the inspected license text resembles ${detectedSpdx}. Direct reuse is prohibited pending review.`,
    };
  }
  return {
    id: `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}`,
    kind: "repository",
    name: metadata.full_name || `${ref.owner}/${ref.repo}`,
    url: metadata.html_url || ref.canonicalUrl,
    description: metadata.description || "",
    stars: metadata.stargazers_count ?? 0,
    archived: metadata.archived ?? false,
    updatedAt: metadata.pushed_at ?? "",
    discoveryEvidence,
    license,
    fileTree: blobPaths.slice(0, 500),
    sourceEvidence,
    inspectionError: tree.truncated
      ? "GitHub reported a truncated recursive tree; the highest-ranked visible files were inspected."
      : "",
  };
}

function candidateScore(
  candidate: { title: string; snippet: string; hits: number },
  terms: string[],
): number {
  const haystack = `${candidate.title} ${candidate.snippet}`.toLowerCase();
  const termMatches = terms.filter((term) => haystack.includes(term)).length;
  return candidate.hits * 10 + termMatches * 3;
}

/**
 * Owner directive 2026-08-15: every build/extend run must look for AT LEAST
 * the top five COMPETITORS to the app — real market products, not just
 * open-source implementations — and glean their most valuable ideas. The
 * first three queries hunt competitor products; the rest hunt inspectable
 * open-source implementations.
 */
export function buildDiscoveryQueries(spec: ProductSpec): string[] {
  const features = spec.coreFeatures.slice(0, 5);
  const primary = features[0] ?? spec.tagline;
  return [
    `${spec.appName} competitors`,
    `best ${primary} software for ${spec.targetUser}`,
    `top alternatives to ${spec.appName}`,
    `${spec.appName} alternatives open source GitHub`,
    `${spec.targetUser} software open source GitHub`,
    ...features.map((feature) => `${feature} open source GitHub implementation`),
  ].slice(0, 10);
}

/** True for queries whose results are competitor PRODUCT pages, not code. */
export function isCompetitorQuery(query: string): boolean {
  return /(^|\s)competitors?(\s|$)|^best |^top alternatives/i.test(query);
}

/**
 * Discover broadly, then inspect a smaller evidence-rich shortlist. This is
 * intentionally bounded by candidate, byte, and timeout budgets so one run
 * cannot turn into an unending crawler.
 */
export async function buildCompetitiveDossier(
  spec: ProductSpec,
  arch: Architecture,
): Promise<CompetitiveDossier> {
  const queries = buildDiscoveryQueries(spec);
  const terms = termsFor(spec, arch);
  const repositories = new Map<
    string,
    { ref: GitHubRepoRef; title: string; snippet: string; hits: number; evidence: string[] }
  >();
  const webCandidates = new Map<
    string,
    { title: string; snippet: string; hits: number; evidence: string[] }
  >();

  for (const query of queries) {
    const results = await webSearchTool(query);
    for (const result of results) {
      const repo = parseGitHubRepoUrl(result.url);
      if (repo) {
        const existing = repositories.get(repo.canonicalUrl);
        repositories.set(repo.canonicalUrl, {
          ref: repo,
          title: result.title || existing?.title || repo.repo,
          snippet: result.snippet || existing?.snippet || "",
          hits: (existing?.hits ?? 0) + 1,
          evidence: [...new Set([...(existing?.evidence ?? []), `${query}: ${result.url}`])],
        });
      } else if (
        /docs|api|library|sdk|framework|tool/i.test(`${result.title} ${result.snippet}`) ||
        // Competitor-intent queries surface product pages that never say
        // "library" or "sdk" — dropping them was how a grant-platform run
        // researched ten repos and zero actual competitors.
        isCompetitorQuery(query)
      ) {
        const existing = webCandidates.get(result.url);
        webCandidates.set(result.url, {
          title: result.title,
          snippet: result.snippet,
          hits: (existing?.hits ?? 0) + 1,
          evidence: [...new Set([...(existing?.evidence ?? []), `${query}: ${result.url}`])],
        });
      }
    }
  }

  const rankedRepos = [...repositories.values()]
    .sort(
      (a, b) =>
        candidateScore(b, terms) - candidateScore(a, terms) ||
        a.ref.canonicalUrl.localeCompare(b.ref.canonicalUrl),
    )
    .slice(0, Math.min(MAX_DISCOVERED, MAX_INSPECTED));

  const inspected = await Promise.all(
    rankedRepos.map(async (candidate): Promise<CompetitiveCandidate> => {
      try {
        return await inspectGitHubRepository(candidate.ref, candidate.evidence, terms);
      } catch (err) {
        return {
          id: `${candidate.ref.owner.toLowerCase()}/${candidate.ref.repo.toLowerCase()}`,
          kind: "repository",
          name: `${candidate.ref.owner}/${candidate.ref.repo}`,
          url: candidate.ref.canonicalUrl,
          description: candidate.snippet,
          stars: 0,
          archived: false,
          updatedAt: "",
          discoveryEvidence: candidate.evidence,
          license: assessLicense(null, "Unknown license", candidate.ref.canonicalUrl),
          fileTree: [],
          sourceEvidence: [],
          inspectionError: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  const remainingSlots = Math.max(0, MAX_INSPECTED - inspected.length);
  const pages = [...webCandidates.entries()]
    .sort(
      ([, a], [, b]) =>
        candidateScore(b, terms) - candidateScore(a, terms),
    )
    .slice(0, remainingSlots);
  for (const [url, candidate] of pages) {
    const fetched = await webFetchTool(url);
    inspected.push({
      id: `web:${url}`,
      kind: "web",
      name: candidate.title || url,
      url,
      description: candidate.snippet,
      stars: 0,
      archived: false,
      updatedAt: "",
      discoveryEvidence: candidate.evidence,
      license: assessLicense(null, "Web documentation; code license unverified", url),
      fileTree: [],
      sourceEvidence: fetched.ok
        ? [{ path: "web-page", url, excerpt: fetched.textExcerpt.slice(0, MAX_EVIDENCE_EXCERPT) }]
        : [],
      inspectionError: fetched.ok ? "" : fetched.error || `HTTP ${fetched.status}`,
    });
  }

  return {
    queries,
    candidates: inspected,
    discoveredCount: repositories.size + webCandidates.size,
    inspectedCount: inspected.length,
    generatedAt: new Date().toISOString(),
  };
}
