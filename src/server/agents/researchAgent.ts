import { z } from "zod";
import { SYSTEM_PREAMBLE, type AgentDeps } from "./types.js";
import { webSearchTool } from "../tools/webSearch.js";
import { webFetchTool } from "../tools/webFetch.js";
import {
  buildCompetitiveDossier,
  type CompetitiveCandidate,
  type CompetitiveDossier,
} from "../tools/competitiveIntelligence.js";
import type { ProductSpec, Architecture } from "../../shared/schemas.js";

const LicensePolicySchema = z.enum([
  "direct-use",
  "conditional-review",
  "reference-only",
  "not-applicable",
]);
const ReuseModeSchema = z.enum([
  "dependency",
  "direct-code",
  "clean-room-pattern",
  "api-integration",
  "reference-only",
]);

const RecommendationSchema = z.object({
  name: z.string(),
  why: z.string().default(""),
  sourceUrl: z.string().default(""),
  howToIntegrate: z.string().default(""),
  candidateId: z.string().default(""),
  licenseSpdx: z.string().default("NOASSERTION"),
  licensePolicy: LicensePolicySchema.default("not-applicable"),
  reuseMode: ReuseModeSchema.default("api-integration"),
  evidenceUrls: z.array(z.string()).default([]),
  score: z.number().min(0).max(100).default(0),
});
export type ResearchRecommendation = z.infer<typeof RecommendationSchema>;

const CandidateComparisonSchema = z.object({
  candidateId: z.string(),
  name: z.string().default(""),
  score: z.number().min(0).max(100).default(0),
  matchedFeatures: z.array(z.string()).default([]),
  strengths: z.array(z.string()).default([]),
  gaps: z.array(z.string()).default([]),
  evidenceUrls: z.array(z.string()).default([]),
  decision: z.enum(["integrate", "adapt", "reference", "reject"]),
  rationale: z.string().default(""),
});

const CompetitiveAuditSchema = z.object({
  queries: z.array(z.string()).default([]),
  discoveredCount: z.number().int().nonnegative().default(0),
  inspectedCount: z.number().int().nonnegative().default(0),
  generatedAt: z.string().default(""),
  candidates: z
    .array(
      z.object({
        candidateId: z.string(),
        name: z.string(),
        url: z.string(),
        licenseSpdx: z.string(),
        licensePolicy: z.enum([
          "direct-use",
          "conditional-review",
          "reference-only",
        ]),
        inspectedFiles: z.number().int().nonnegative(),
        inspectionError: z.string().default(""),
      }),
    )
    .default([]),
});

export const ResearchFindingsSchema = z.object({
  summary: z.string().default(""),
  recommendations: z.array(RecommendationSchema).default([]),
  comparisons: z.array(CandidateComparisonSchema).default([]),
  competitiveAudit: CompetitiveAuditSchema.nullable().default(null),
});
export type ResearchFindings = z.infer<typeof ResearchFindingsSchema>;

const ACTIONS = ["web_search", "web_fetch", "conclude"] as const;
const ResearchActionSchema = z.object({
  thought: z.string().default(""),
  action: z.enum(ACTIONS),
  query: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  findings: ResearchFindingsSchema.nullable().optional(),
});
type ResearchAction = z.infer<typeof ResearchActionSchema>;

const CompetitiveSelectionSchema = z.object({
  summary: z.string().default(""),
  comparisons: z.array(CandidateComparisonSchema).default([]),
  selected: z
    .array(
      z.object({
        candidateId: z.string(),
        element: z.string(),
        why: z.string().default(""),
        howToIntegrate: z.string().default(""),
        reuseMode: ReuseModeSchema,
        evidenceUrls: z.array(z.string()).default([]),
        score: z.number().min(0).max(100).default(0),
      }),
    )
    .default([]),
});
type CompetitiveSelection = z.infer<typeof CompetitiveSelectionSchema>;

export interface ResearchOptions {
  /** Preserve the small legacy research loop for tests and constrained callers. */
  competitive?: boolean;
}

const MAX_STEPS = 5;

function buildPrompt(spec: ProductSpec, arch: Architecture, toolLog: string[]): string {
  return [
    `You are deciding whether any EXISTING tool, library, or public API would genuinely help build this app, rather than writing everything from scratch.`,
    `SPEC:\n${JSON.stringify(spec)}`,
    `ARCHITECTURE:\n${JSON.stringify(arch)}`,
    toolLog.length
      ? `Tool results so far:\n${toolLog.join("\n\n")}`
      : "(no tool calls yet)",
    `Available actions:`,
    `- web_search: search the web for a candidate tool/library/API (needs "query"). Use this FIRST for anything you're not certain about.`,
    `- web_fetch: read a specific page/doc URL a search turned up, to verify it's real and see how to actually use it (needs "url").`,
    `- conclude: you're done. Provide "findings": { summary, recommendations: [{ name, why, sourceUrl, howToIntegrate }] }. If nothing external genuinely helps, conclude with an EMPTY recommendations array and say so in summary — do not invent a recommendation just to have one.`,
    `Only recommend something you actually found real evidence for via a tool call (or that is extremely well-established, e.g. a standard library) — never invent a plausible-sounding tool name.`,
  ].join("\n\n");
}

async function runToolResearch(
  deps: AgentDeps,
  spec: ProductSpec,
  arch: Architecture,
): Promise<ResearchFindings> {
  const toolLog: string[] = [];

  for (let step = 0; step < MAX_STEPS; step++) {
    const turn = await deps.provider.generateJson<ResearchAction>({
      system:
        `${SYSTEM_PREAMBLE}\nYou are the RESEARCH agent. Find real, existing tools/APIs/libraries that would ` +
        `genuinely help build this app, using the search and fetch tools described. Be concrete and honest — ` +
        `an empty, honest "nothing needed" beats a fabricated recommendation.`,
      prompt: buildPrompt(spec, arch, toolLog),
      schema: ResearchActionSchema,
      schemaName: "ResearchAction",
      temperature: 0.2,
      maxTokens: 1800,
    });

    if (turn.action === "conclude") {
      return ResearchFindingsSchema.parse(
        turn.findings ?? {
          summary: "No specific external tool identified.",
          recommendations: [],
        },
      );
    }

    if (turn.action === "web_search") {
      const q = turn.query ?? spec.appName;
      const results = await webSearchTool(q);
      toolLog.push(
        `web_search("${q}") -> ` +
          results
            .map((r) => `${r.title} — ${r.url} — ${r.snippet.slice(0, 200)}`)
            .join(" | "),
      );
      continue;
    }

    if (turn.action === "web_fetch") {
      if (!turn.url) {
        toolLog.push("web_fetch requested without a url — nothing to fetch.");
        continue;
      }
      const res = await webFetchTool(turn.url);
      toolLog.push(
        `web_fetch(${turn.url}) -> ok=${res.ok} status=${res.status}\n` +
          (res.error ? `error: ${res.error}` : res.textExcerpt.slice(0, 1200)),
      );
    }
  }

  return ResearchFindingsSchema.parse({
    summary: `Research did not reach a conclusion within ${MAX_STEPS} steps — proceeding without external recommendations.`,
    recommendations: [],
  });
}

function compactCandidate(candidate: CompetitiveCandidate) {
  return {
    id: candidate.id,
    kind: candidate.kind,
    name: candidate.name,
    url: candidate.url,
    description: candidate.description,
    stars: candidate.stars,
    archived: candidate.archived,
    updatedAt: candidate.updatedAt,
    discoveryEvidence: candidate.discoveryEvidence,
    license: candidate.license,
    inspectionError: candidate.inspectionError,
    fileTree: candidate.fileTree.slice(0, 160),
    sourceEvidence: candidate.sourceEvidence.slice(0, 12),
  };
}

function auditFrom(dossier: CompetitiveDossier) {
  return {
    queries: dossier.queries,
    discoveredCount: dossier.discoveredCount,
    inspectedCount: dossier.inspectedCount,
    generatedAt: dossier.generatedAt,
    candidates: dossier.candidates.map((candidate) => ({
      candidateId: candidate.id,
      name: candidate.name,
      url: candidate.url,
      licenseSpdx: candidate.license.spdxId,
      licensePolicy: candidate.license.policy,
      inspectedFiles: candidate.sourceEvidence.length,
      inspectionError: candidate.inspectionError,
    })),
  };
}

export function enforceReuseMode(
  requested: z.infer<typeof ReuseModeSchema>,
  candidate: CompetitiveCandidate,
): z.infer<typeof ReuseModeSchema> {
  if (candidate.kind === "web" && requested === "direct-code") return "api-integration";
  if (
    candidate.license.policy !== "direct-use" &&
    (requested === "direct-code" || requested === "dependency")
  ) {
    return "clean-room-pattern";
  }
  return requested;
}

async function evaluateCompetitiveDossier(
  deps: AgentDeps,
  spec: ProductSpec,
  arch: Architecture,
  dossier: CompetitiveDossier,
): Promise<CompetitiveSelection> {
  return deps.provider.generateJson<CompetitiveSelection>({
    system:
      `${SYSTEM_PREAMBLE}\nYou are the COMPETITIVE INTELLIGENCE reviewer. Compare only the supplied, ` +
      `evidence-backed candidates. Score feature fit, implementation quality, maintenance, and integration cost. ` +
      `Never invent a candidate, file, feature, or license. License policy is authoritative: direct code reuse is ` +
      `allowed only when policy=direct-use; otherwise choose clean-room-pattern or reference-only.`,
    prompt: [
      `TARGET SPEC:\n${JSON.stringify(spec)}`,
      `TARGET ARCHITECTURE:\n${JSON.stringify(arch)}`,
      `DISCOVERY DOSSIER:\n${JSON.stringify(dossier.candidates.map(compactCandidate))}`,
      `Return a feature-by-feature comparison for every credible candidate and a selected list of concrete elements ` +
        `worth integrating. Cover AT LEAST the five strongest competitors in the comparisons (all of them when fewer ` +
        `than five candidates exist), and for each competitor name the single most valuable idea worth adopting - ` +
        `the thing it does better than this app - respecting its license policy. Every selected candidateId must ` +
        `exactly match the dossier. Cite file/page URLs in evidenceUrls. ` +
        `Reject stale, irrelevant, unverifiable, or legally unusable candidates. Do not select something merely because it is popular.`,
    ].join("\n\n"),
    schema: CompetitiveSelectionSchema,
    schemaName: "CompetitiveSelection",
    temperature: 0.1,
    maxTokens: 8000,
  });
}

function mergeCompetitiveResults(
  base: ResearchFindings,
  dossier: CompetitiveDossier,
  selection: CompetitiveSelection,
): ResearchFindings {
  const candidates = new Map(dossier.candidates.map((candidate) => [candidate.id, candidate]));
  const validComparisons = selection.comparisons.filter((item) => candidates.has(item.candidateId));
  const competitiveRecommendations: ResearchRecommendation[] = [];

  for (const selected of selection.selected) {
    const candidate = candidates.get(selected.candidateId);
    if (!candidate) continue;
    const reuseMode = enforceReuseMode(selected.reuseMode, candidate);
    const legalPrefix =
      reuseMode !== selected.reuseMode
        ? `License gate changed requested ${selected.reuseMode} to ${reuseMode}. `
        : "";
    competitiveRecommendations.push({
      name: `${candidate.name}: ${selected.element}`,
      why: selected.why,
      sourceUrl: candidate.url,
      howToIntegrate: `${legalPrefix}${selected.howToIntegrate}`.trim(),
      candidateId: candidate.id,
      licenseSpdx: candidate.license.spdxId,
      licensePolicy: candidate.license.policy,
      reuseMode,
      evidenceUrls: [
        ...new Set([
          ...selected.evidenceUrls,
          candidate.license.evidenceUrl,
          ...candidate.sourceEvidence.slice(0, 4).map((item) => item.url),
        ].filter(Boolean)),
      ],
      score: selected.score,
    });
  }

  return ResearchFindingsSchema.parse({
    summary: [base.summary, selection.summary].filter(Boolean).join("\n\n"),
    recommendations: [...base.recommendations, ...competitiveRecommendations],
    comparisons: validComparisons,
    competitiveAudit: auditFrom(dossier),
  });
}

/**
 * Research existing tools plus, when requested by the production pipeline,
 * autonomously discover and compare competing open-source implementations.
 */
export async function researchAgent(
  deps: AgentDeps,
  spec: ProductSpec,
  arch: Architecture,
  options: ResearchOptions = {},
): Promise<ResearchFindings> {
  const base = await runToolResearch(deps, spec, arch);
  if (!options.competitive) return base;

  const dossier = await buildCompetitiveDossier(spec, arch);
  if (!dossier.candidates.length) {
    return ResearchFindingsSchema.parse({
      ...base,
      summary: `${base.summary}\n\nCompetitive discovery found no inspectable candidates.`,
      competitiveAudit: auditFrom(dossier),
    });
  }

  const selection = await evaluateCompetitiveDossier(deps, spec, arch, dossier);
  const merged = mergeCompetitiveResults(base, dossier, selection);
  if (dossier.candidates.length < 5) {
    // No silent caps: the owner's floor is the top FIVE competitors. Fewer
    // discovered is reported, never papered over.
    return ResearchFindingsSchema.parse({
      ...merged,
      summary: `${merged.summary}

Competitor coverage below the owner's floor: only ${dossier.candidates.length} candidate(s) were discovered and inspected (target: at least 5).`,
    });
  }
  return merged;
}
