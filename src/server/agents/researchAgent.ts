import { z } from "zod";
import { SYSTEM_PREAMBLE, type AgentDeps } from "./types.js";
import { webSearchTool } from "../tools/webSearch.js";
import { webFetchTool } from "../tools/webFetch.js";
import type { ProductSpec, Architecture } from "../../shared/schemas.js";

/**
 * researchAgent.ts — "if there is a tool out there that it can use, it can
 * find it and use it to properly build the thing." A bounded ReAct-style loop
 * with two real tools — web_search (genuine, keyless DuckDuckGo Lite search)
 * and web_fetch (read a specific page/API doc it found) — that decides
 * whether an existing library/API would help build the spec, evaluates what
 * it finds, and returns concrete, actionable recommendations the builder
 * stage can actually wire in (not a decorative "consider using X" aside).
 *
 * Runs after architecture is set (so it knows what's being built) and before
 * the task planner commits to an implementation approach, per the design
 * goal of feeding real findings into planning rather than bolting research on
 * after the fact.
 */

const RecommendationSchema = z.object({
  name: z.string(),
  why: z.string().default(""),
  sourceUrl: z.string().default(""),
  howToIntegrate: z.string().default(""),
});
export type ResearchRecommendation = z.infer<typeof RecommendationSchema>;

export const ResearchFindingsSchema = z.object({
  summary: z.string().default(""),
  recommendations: z.array(RecommendationSchema).default([]),
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

export async function researchAgent(
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
      maxTokens: 1400,
    });

    if (turn.action === "conclude") {
      return (
        turn.findings ?? {
          summary: "No specific external tool identified.",
          recommendations: [],
        }
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
      continue;
    }
  }

  // Bounded — never block the pipeline indefinitely on research. An honest
  // "didn't reach a conclusion" is safer than fabricating one this late.
  return {
    summary: `Research did not reach a conclusion within ${MAX_STEPS} steps — proceeding without external recommendations.`,
    recommendations: [],
  };
}
