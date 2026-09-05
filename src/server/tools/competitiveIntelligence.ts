import type { Architecture, ProductSpec } from "../../shared/schemas.js";
import { webFetchTool, type WebFetchResult } from "./webFetch.js";
import {
  webSearch,
  type SearchAttempt,
  type SearchResult,
  type WebSearchProvider,
} from "./webSearch.js";
import { repoRewardsSearch } from "./repoRewards.js";

export type LicenseReusePolicy = "direct-use" | "conditional-review" | "reference-only";

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
  /** Commercial/hosted product competitors stay distinct from OSS repos. */
  kind: "product" | "repository";
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

export type DiscoverySourceStatus = "ok" | "partial" | "empty" | "failed" | "skipped";

export interface DiscoverySourceHealth {
  name: string;
  ok: boolean;
  status: DiscoverySourceStatus;
  detail: string;
  attempts: number;
  succeeded: number;
  empty: number;
  failed: number;
  skipped: number;
  resultCount: number;
}

export interface CompetitiveCoverage {
  productTarget: number;
  productDiscoveredCount: number;
  productInspectedCount: number;
  productVerifiedCount: number;
  productCoverageMet: boolean;
  repositoryDiscoveredCount: number;
  repositoryInspectedCount: number;
  repositoryVerifiedCount: number;
}

export interface CompetitiveDossier {
  queries: string[];
  candidates: CompetitiveCandidate[];
  discoveredCount: number;
  inspectedCount: number;
  generatedAt: string;
  /**
   * Which discovery sources actually answered, and why any did not. The
   * owner's own Repo Rewards service runs alongside web search (owner order
   * 2026-08-16); an unreachable source is REPORTED, never silently dropped.
   */
  sources: DiscoverySourceHealth[];
  /** Product-competitor coverage cannot be satisfied by OSS repositories. */
  coverage: CompetitiveCoverage;
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
const MAX_REPOSITORY_INSPECTED = 8;
export const MIN_PRODUCT_COMPETITORS = 5;
/** Headroom lets failed/dead product pages be replaced while pursuing five verified products. */
export const MAX_PRODUCT_INSPECTION_ATTEMPTS = 10;
const DISCOVERY_CONCURRENCY = 3;
const MAX_SOURCE_FILES = 24;
const MAX_SOURCE_BYTES = 360_000;
const MAX_FILE_BYTES = 28_000;
const MAX_EVIDENCE_EXCERPT = 1800;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MIN_PRODUCT_EVIDENCE_CHARS = 120;

// A deliberately conservative subset of common multi-label public suffixes.
// Collapsing unknown hosts to their final two labels may merge a few unrelated
// sites on exotic suffixes, but it cannot inflate the evidence count. That is
// the safe direction for a strict five-product gate.
const COMMON_SECOND_LEVEL_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "me.uk",
  "com.au",
  "net.au",
  "org.au",
  "com.br",
  "com.cn",
  "com.hk",
  "com.mx",
  "co.in",
  "co.jp",
  "co.kr",
  "co.nz",
  "com.sg",
  "com.tr",
  "co.za",
]);

const GENERIC_PRODUCT_WORDS = new Set([
  "about",
  "application",
  "best",
  "business",
  "company",
  "features",
  "home",
  "platform",
  "product",
  "service",
  "software",
  "solution",
  "technology",
  "tool",
]);

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
    normalized.includes('the software is provided "as is"')
  ) {
    return "MIT";
  }
  if (
    normalized.includes("redistribution and use in source and binary forms") &&
    normalized.includes("neither the name")
  ) {
    return "BSD-3-CLAUSE";
  }
  if (
    normalized.includes("isc license") &&
    normalized.includes("permission to use, copy")
  ) {
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
    const parts = url.pathname.split("/").filter(Boolean).slice(0, 2);
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

const REPOSITORY_HOSTS = new Set([
  "bitbucket.org",
  "codeberg.org",
  "gitea.com",
  "github.com",
  "gitlab.com",
  "sourceforge.net",
]);

/** Prevent code-hosting links from being misclassified as market products. */
export function isRepositoryCandidateUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return (
      [...REPOSITORY_HOSTS].some(
        (candidate) => host === candidate || host.endsWith(`.${candidate}`),
      ) || url.pathname.toLowerCase().endsWith(".git")
    );
  } catch {
    return false;
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
    .filter(
      (word) =>
        !new Set([
          "application",
          "feature",
          "users",
          "using",
          "with",
          "from",
          "that",
          "this",
        ]).has(word),
    )
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
      if (
        /(service|provider|adapter|route|controller|model|schema|auth|search|integration)/.test(
          lower,
        )
      )
        score += 4;
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
  const body = await readResponseBytes(response, MAX_JSON_BYTES);
  if (body.truncated) throw new Error(`${url} exceeded the JSON response limit`);
  return JSON.parse(new TextDecoder("utf-8", { fatal: false }).decode(body.bytes)) as T;
}

async function readResponseBytes(
  response: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const remaining = maxBytes - total;
      if (next.value.byteLength > remaining) {
        if (remaining > 0) {
          chunks.push(next.value.subarray(0, remaining));
          total += remaining;
        }
        truncated = true;
        await reader.cancel("response exceeded byte limit").catch(() => {});
        break;
      }
      chunks.push(next.value);
      total += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
}

async function fetchText(
  url: string,
  maxBytes = MAX_FILE_BYTES,
): Promise<{ text: string; bytesRead: number }> {
  const response = await fetch(url, {
    headers: { "User-Agent": "factory-deck-competitive-intelligence/1.0" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  const body = await readResponseBytes(response, maxBytes);
  return {
    text: new TextDecoder("utf-8", { fatal: false }).decode(body.bytes),
    bytesRead: body.bytes.byteLength,
  };
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
  const blobEntries = (tree.tree ?? []).filter(
    (entry) => entry.type === "blob" && entry.path,
  );
  const blobPaths = blobEntries.map((entry) => entry.path as string);
  const inspectableBlobPaths = blobEntries
    .filter(
      (entry) =>
        typeof entry.size !== "number" ||
        (entry.size >= 0 && entry.size <= MAX_FILE_BYTES),
    )
    .map((entry) => entry.path as string);
  const ranked = rankRelevantPaths(inspectableBlobPaths, terms).slice(
    0,
    MAX_SOURCE_FILES,
  );
  const sourceEvidence: SourceEvidence[] = [];
  let usedBytes = 0;

  for (const path of ranked) {
    if (usedBytes >= MAX_SOURCE_BYTES) break;
    const url = rawGitHubUrl(ref, branch, path);
    try {
      const fetched = await fetchText(
        url,
        Math.min(MAX_FILE_BYTES, MAX_SOURCE_BYTES - usedBytes),
      );
      usedBytes += fetched.bytesRead;
      sourceEvidence.push({
        path,
        url,
        excerpt: fetched.text.slice(0, MAX_EVIDENCE_EXCERPT),
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
      const licenseText = await fetchText(
        rawGitHubUrl(ref, branch, licensePath),
        80_000,
      );
      detectedSpdx = detectLicenseFromText(licenseText.text);
      if (!declaredSpdx || normalizedSpdx(declaredSpdx) === "NOASSERTION") {
        declaredSpdx = detectedSpdx ?? declaredSpdx;
      }
    } catch {
      // Missing evidence is handled conservatively by assessLicense below.
    }
  }
  let license = assessLicense(
    declaredSpdx,
    metadata.license?.name ||
      metadata.license?.key ||
      detectedSpdx ||
      "Unknown license",
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
  const mission = (spec.goalContract?.purpose || spec.tagline || primary)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
  // Product discovery needs several short, independent queries. A single long
  // audience/outcome sentence was returning articles about implementation
  // rather than official competitor pages and made the five-product gate
  // depend on one search result surviving HTTP verification.
  const productNeed = (spec.tagline || mission || primary)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
  const audience = (spec.goalContract?.targetUsers[0] || spec.targetUser)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  const activeOutcome = (spec.goalContract?.activeGoals[0] || primary)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
  return [
    `${mission} software competitors`,
    `best ${productNeed} apps for ${audience}`,
    `top ${productNeed} software products`,
    `${productNeed} alternative products`,
    `${mission} open source GitHub`,
    `${activeOutcome} open source GitHub implementation`,
    `${spec.targetUser} software open source GitHub`,
    ...features.map((feature) => `${feature} open source GitHub implementation`),
  ].slice(0, 10);
}

/** True for queries whose results are competitor PRODUCT pages, not code. */
export function isCompetitorQuery(query: string): boolean {
  return (
    /(^|\s)competitors?(\s|$)|^best |^top |^official /i.test(query) ||
    /\balternative products?\b|\bofficial (?:site|website|product|app|software)\b/i.test(
      query,
    )
  );
}

/**
 * Keep model-suggested discovery bounded, unique, and unmistakably classified
 * as product discovery. The model proposes names; search plus page inspection
 * still supplies all evidence and the strict distinct-domain gate remains
 * authoritative.
 */
export function normalizeProductDiscoveryQueries(queries: string[]): string[] {
  const normalized = queries
    .map((query) => query.replace(/\s+/g, " ").trim().slice(0, 180))
    .filter((query) => query.length >= 3)
    .map((query) =>
      isCompetitorQuery(query) ? query : `official product website ${query}`,
    );
  return [...new Set(normalized)].slice(0, 8);
}

const NON_PRODUCT_HOSTS = new Set([
  "alternativeto.net",
  "archlinux.org",
  "capterra.com",
  "facebook.com",
  "forbes.com",
  "g2.com",
  "go.dev",
  "getapp.com",
  "github.com",
  "gitlab.com",
  "linkedin.com",
  "linuxlinks.com",
  "medium.com",
  "npmjs.com",
  "pinterest.com",
  "reddit.com",
  "saasworthy.com",
  "stackexchange.com",
  "stackoverflow.com",
  "dev.to",
  "deepwiki.com",
  "codemag.com",
  "weeklyjs.io",
  "sourceforge.net",
  "wikipedia.org",
  "x.com",
  "youtube.com",
]);

function registrableProductHost(hostname: string): string | null {
  const host = hostname
    .toLowerCase()
    .replace(/^www\d*\./, "")
    .replace(/\.$/, "");
  if (!host || host.includes(":")) return null;
  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2 || labels.some((label) => !/^[a-z0-9-]+$/i.test(label))) {
    return null;
  }
  const finalTwo = labels.slice(-2).join(".");
  return COMMON_SECOND_LEVEL_SUFFIXES.has(finalTwo) && labels.length >= 3
    ? labels.slice(-3).join(".")
    : finalTwo;
}

function productDomainKeyFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const rawHost = url.hostname.toLowerCase().replace(/^www\d*\./, "");
    if (
      [...NON_PRODUCT_HOSTS].some(
        (blocked) => rawHost === blocked || rawHost.endsWith(`.${blocked}`),
      )
    ) {
      return null;
    }
    return registrableProductHost(rawHost);
  } catch {
    return null;
  }
}

/**
 * Return one stable identity for an apparent product result. Documentation,
 * support, and app subdomains collapse to the product's host so five URLs for
 * one vendor can never satisfy the five-competitor floor.
 */
export function productCandidateKey(result: SearchResult): string | null {
  try {
    const url = new URL(result.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (isRepositoryCandidateUrl(result.url)) return null;
    const host = productDomainKeyFromUrl(result.url);
    if (!host) return null;
    const looksLikeRoundup =
      /\b(?:top\s+\d+|alternatives?|competitors?|comparisons?|reviews?)\b/i.test(
        result.title,
      ) ||
      /\bbest\b.*\b(?:apps?|platforms?|products?|services?|software|solutions?|tools?)\b/i.test(
        result.title,
      ) ||
      /\/(?:best|blog|compare|comparison|news|resources?|reviews?|top-?\d+)(?:\/|$)/i.test(
        url.pathname,
      );
    if (looksLikeRoundup) return null;
    return host;
  } catch {
    return null;
  }
}

export interface ProductEvidenceContext {
  candidateKey: string;
  title: string;
}

/**
 * A 200 alone is not evidence. Require readable, same-product content and
 * reject common challenge, login, and domain-parking responses. The optional
 * context is supplied by competitive discovery; leaving it out preserves the
 * small content-only helper used by callers that do not claim product identity.
 */
export function isMeaningfulProductEvidence(
  result: WebFetchResult,
  context?: ProductEvidenceContext,
): boolean {
  const text = result.textExcerpt.trim();
  if (
    !result.ok ||
    result.truncated === true ||
    !/^(?:text\/|application\/(?:json|ld\+json|xml|xhtml\+xml))/i.test(
      result.contentType.trim(),
    ) ||
    text.length < MIN_PRODUCT_EVIDENCE_CHARS
  ) {
    return false;
  }
  if (!context) return true;

  const finalKey = productDomainKeyFromUrl(result.finalUrl);
  if (!finalKey || finalKey !== context.candidateKey) return false;
  try {
    if (/\/(?:auth|login|sign-?in)(?:\/|$)/i.test(new URL(result.finalUrl).pathname)) {
      return false;
    }
  } catch {
    return false;
  }

  const lower = text.toLowerCase();
  if (
    /\b(?:buy this domain|domain (?:is )?for sale|parked domain|verify you are human|captcha|checking your browser|access denied)\b/i.test(
      text,
    )
  ) {
    return false;
  }

  const brand = context.candidateKey.split(".")[0] ?? "";
  const relevanceTokens = [brand, ...context.title.split(/[^a-z0-9]+/i)]
    .map((token) => token.toLowerCase())
    .filter(
      (token, index, all) =>
        token.length >= 2 &&
        !GENERIC_PRODUCT_WORDS.has(token) &&
        all.indexOf(token) === index,
    );
  return relevanceTokens.some((token) => lower.includes(token));
}

function sourceHealthFromAttempts(
  provider: WebSearchProvider,
  attempts: SearchAttempt[],
): DiscoverySourceHealth {
  const relevant = attempts.filter((attempt) => attempt.provider === provider);
  const actual = relevant.filter((attempt) => attempt.status !== "skipped");
  const succeeded = actual.filter((attempt) => attempt.status === "ok").length;
  const empty = actual.filter((attempt) => attempt.status === "empty").length;
  const failed = actual.filter((attempt) => attempt.status === "failed").length;
  const skipped = relevant.length - actual.length;
  const resultCount = relevant.reduce((sum, attempt) => sum + attempt.resultCount, 0);
  let status: DiscoverySourceStatus;
  if (!actual.length) status = "skipped";
  else if (failed && succeeded + empty) status = "partial";
  else if (failed === actual.length) status = "failed";
  else if (succeeded) status = "ok";
  else status = "empty";
  const details = [...new Set(relevant.map((attempt) => attempt.detail))];
  return {
    name: provider === "firecrawl" ? "firecrawl-v2" : "duckduckgo-lite",
    ok: status !== "failed",
    status,
    detail:
      `${actual.length} attempt(s): ${succeeded} with results, ${empty} empty, ` +
      `${failed} failed, ${skipped} skipped; ${resultCount} result(s)` +
      (details.length ? ` — ${details.join("; ").slice(0, 500)}` : ""),
    attempts: actual.length,
    succeeded,
    empty,
    failed,
    skipped,
    resultCount,
  };
}

/**
 * Deterministic coverage assessment used by research and release gates. Only
 * evidence-verified product pages satisfy the product floor; repositories are
 * counted independently and can never substitute for market competitors.
 */
export function assessCompetitiveCoverage(
  candidates: CompetitiveCandidate[],
  productDiscoveredCount: number,
  repositoryDiscoveredCount: number,
  productTarget = MIN_PRODUCT_COMPETITORS,
): CompetitiveCoverage {
  const products = candidates.filter((candidate) => candidate.kind === "product");
  const repositories = candidates.filter(
    (candidate) => candidate.kind === "repository",
  );
  const verified = (candidate: CompetitiveCandidate): boolean =>
    candidate.sourceEvidence.some(
      (item) => /^https?:\/\//i.test(item.url) && item.excerpt.trim().length > 0,
    );
  const productVerifiedCount = products.filter(verified).length;
  return {
    productTarget,
    productDiscoveredCount,
    productInspectedCount: products.length,
    productVerifiedCount,
    productCoverageMet: productVerifiedCount >= productTarget,
    repositoryDiscoveredCount,
    repositoryInspectedCount: repositories.length,
    repositoryVerifiedCount: repositories.filter(verified).length,
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const runners = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        results[index] = await worker(items[index]);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

/**
 * Discover broadly, then inspect a smaller evidence-rich shortlist. This is
 * intentionally bounded by candidate, byte, and timeout budgets so one run
 * cannot turn into an unending crawler.
 */
export interface CompetitiveDiscoveryOptions {
  /**
   * Short, product-specific searches proposed by the run's orchestrator.
   * They replace only the generic product searches; deterministic repository
   * discovery, URL classification, evidence inspection, and release gates are
   * unchanged.
   */
  productQueries?: string[];
}

export async function buildCompetitiveDossier(
  spec: ProductSpec,
  arch: Architecture,
  options: CompetitiveDiscoveryOptions = {},
): Promise<CompetitiveDossier> {
  const defaultQueries = buildDiscoveryQueries(spec);
  const productQueries = normalizeProductDiscoveryQueries(options.productQueries ?? []);
  const deterministicProductQueries = defaultQueries.filter((query) =>
    isCompetitorQuery(query),
  );
  const implementationQueries = defaultQueries.filter(
    (query) => !isCompetitorQuery(query),
  );
  const queries = productQueries.length
    ? [
        ...new Set([
          ...productQueries,
          ...deterministicProductQueries,
          ...implementationQueries,
        ]),
      ].slice(0, 12)
    : defaultQueries;
  const terms = termsFor(spec, arch);
  const repositories = new Map<
    string,
    {
      ref: GitHubRepoRef;
      title: string;
      snippet: string;
      hits: number;
      evidence: string[];
    }
  >();
  const repositoryDiscoveries = new Set<string>();
  const productCandidates = new Map<
    string,
    { url: string; title: string; snippet: string; hits: number; evidence: string[] }
  >();

  // Discovery runs BOTH sources per query: the owner's Repo Rewards service
  // (ranked real repositories for a need) and keyless web search (market
  // products with no GitHub presence). Repo Rewards results are
  // metadata-screened candidates only — they get the same inspection, license
  // gate, and reuse-mode enforcement as anything found on the web.
  const sources: CompetitiveDossier["sources"] = [];
  const rrEndpoints = new Set<string>();
  const rrFailures = new Set<string>();
  let rrAnswered = 0;
  let rrWithResults = 0;
  let rrEmpty = 0;
  let rrHits = 0;
  const searchAttempts: SearchAttempt[] = [];

  // Query sources concurrently for each need, with a small global bound to
  // avoid both 10x serial latency and an unbounded request burst.
  const discovered = await mapWithConcurrency(
    queries,
    DISCOVERY_CONCURRENCY,
    async (query) => {
      const [rr, searched] = await Promise.all([
        repoRewardsSearch(query, { limit: 10 }),
        webSearch(query),
      ]);
      return { query, rr, searched };
    },
  );

  // Process in original query order so evidence ordering and tie-breaking are
  // deterministic even though requests were concurrent.
  for (const { query, rr, searched } of discovered) {
    if (rr.endpoint) {
      rrAnswered++;
      rrEndpoints.add(rr.endpoint);
      rrHits += rr.results.length;
      if (rr.results.length) rrWithResults++;
      else rrEmpty++;
    } else if (rr.unreachableReason) {
      rrFailures.add(rr.unreachableReason);
    }
    searchAttempts.push(...searched.attempts);
    const results = [...rr.results, ...searched.results];
    for (const result of results) {
      const repo = parseGitHubRepoUrl(result.url);
      if (repo) {
        repositoryDiscoveries.add(repo.canonicalUrl.toLowerCase());
        const existing = repositories.get(repo.canonicalUrl);
        repositories.set(repo.canonicalUrl, {
          ref: repo,
          title: result.title || existing?.title || repo.repo,
          snippet: result.snippet || existing?.snippet || "",
          hits: (existing?.hits ?? 0) + 1,
          evidence: [
            ...new Set([...(existing?.evidence ?? []), `${query}: ${result.url}`]),
          ],
        });
      } else if (isRepositoryCandidateUrl(result.url)) {
        // Only GitHub repositories currently have a source inspector, but all
        // code-host links remain repository discoveries and can never inflate
        // the market-product floor.
        try {
          const normalized = new URL(result.url);
          normalized.hash = "";
          repositoryDiscoveries.add(normalized.href.toLowerCase());
        } catch {
          // productCandidateKey performs the same URL validation below.
        }
      } else if (isCompetitorQuery(query)) {
        const key = productCandidateKey(result);
        if (!key) continue;
        const existing = productCandidates.get(key);
        productCandidates.set(key, {
          url: existing?.url ?? result.url,
          title: result.title,
          snippet: result.snippet,
          hits: (existing?.hits ?? 0) + 1,
          evidence: [
            ...new Set([...(existing?.evidence ?? []), `${query}: ${result.url}`]),
          ],
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
    .slice(0, MAX_REPOSITORY_INSPECTED);

  const inspectedRepositories = await Promise.all(
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

  // Product competitors have their own reserved capacity. Repositories never
  // consume these slots and therefore can never make the product floor look
  // satisfied.
  const pages = [...productCandidates.entries()]
    .sort(
      ([, a], [, b]) =>
        candidateScore(b, terms) - candidateScore(a, terms) ||
        a.url.localeCompare(b.url),
    )
    .slice(0, MAX_PRODUCT_INSPECTION_ATTEMPTS);
  const inspectedProducts = await mapWithConcurrency(
    pages,
    DISCOVERY_CONCURRENCY,
    async ([key, candidate]): Promise<CompetitiveCandidate> => {
      const fetched = await webFetchTool(candidate.url);
      const meaningful = isMeaningfulProductEvidence(fetched, {
        candidateKey: key,
        title: candidate.title,
      });
      return {
        id: `product:${key}`,
        kind: "product",
        name: candidate.title || key,
        url: candidate.url,
        description: candidate.snippet,
        stars: 0,
        archived: false,
        updatedAt: "",
        discoveryEvidence: candidate.evidence,
        license: assessLicense(
          null,
          "Product page; source-code license not applicable or unverified",
          candidate.url,
        ),
        fileTree: [],
        sourceEvidence: meaningful
          ? [
              {
                path: "product-page",
                url: fetched.finalUrl || candidate.url,
                excerpt: fetched.textExcerpt.slice(0, MAX_EVIDENCE_EXCERPT),
              },
            ]
          : [],
        inspectionError: meaningful
          ? ""
          : fetched.error ||
            (fetched.ok
              ? "Fetched page did not contain enough readable product evidence."
              : `HTTP ${fetched.status}`),
      };
    },
  );

  const rrFailed = queries.length - rrAnswered;
  const rrStatus: DiscoverySourceStatus = !rrAnswered
    ? "failed"
    : rrFailed
      ? "partial"
      : rrHits
        ? "ok"
        : "empty";
  sources.push({
    name: "repo-rewards",
    ok: rrStatus !== "failed",
    status: rrStatus,
    detail:
      `${rrAnswered}/${queries.length} queries answered; ${rrHits} ranked repo hit(s)` +
      (rrEndpoints.size ? ` — ${[...rrEndpoints].join(", ")}` : "") +
      (rrFailures.size ? ` — ${[...rrFailures].join("; ").slice(0, 500)}` : ""),
    attempts: queries.length,
    succeeded: rrWithResults,
    empty: rrEmpty,
    failed: rrFailed,
    skipped: 0,
    resultCount: rrHits,
  });
  sources.push(sourceHealthFromAttempts("firecrawl", searchAttempts));
  sources.push(sourceHealthFromAttempts("duckduckgo", searchAttempts));

  const candidates = [...inspectedProducts, ...inspectedRepositories];
  const coverage = assessCompetitiveCoverage(
    candidates,
    productCandidates.size,
    repositoryDiscoveries.size,
  );

  return {
    queries,
    sources,
    coverage,
    candidates,
    discoveredCount: repositoryDiscoveries.size + productCandidates.size,
    inspectedCount: candidates.length,
    generatedAt: new Date().toISOString(),
  };
}
