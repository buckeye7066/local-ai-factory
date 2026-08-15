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
      if (IGNORED_PATH_PARTS.some((part) => lower.includes(part))) return false;
      if (/\.(min|map|lock)$/i.test(lower)) return false;
      return TEXT_EXTENSIONS.has(extension(lower)) || PRIORITY_FILENAMES.has(lower.split("/").pop() ?? "");
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

  const licenseUrl = metadata.license?.url
    ? String(metadata.license.url).replace("api.github.com/repos", "github.com").replace("/license", "/blob/HEAD/LICENSE")
    : `${ref.canonicalUrl}/tree/${branch}`;
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
    license: assessLicense(
      metadata.license?.spdx_id,
      metadata.license?.name || metadata.license?.key || "Unknown license",
      licenseUrl,
    ),
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

export function buildDiscoveryQueries(spec: ProductSpec): string[] {
  const features = spec.coreFeatures.slice(0, 5);
  return [
    `${spec.appName} alternatives open source GitHub`,
    `${spec.targetUser} software open source GitHub`,
    ...features.map((feature) => `${feature} open source GitHub implementation`),
  ].slice(0, 7);
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
      } else if (/docs|api|library|sdk|framework|tool/i.test(`${result.title} ${result.snippet}`)) {
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
