import { z } from "zod";
import type { RepoSource } from "../../shared/schemas.js";
import { SYSTEM_PREAMBLE, type AgentDeps } from "./types.js";
import { webFetchTool, looksLikeRepoUrl, extractAllUrls } from "../tools/webFetch.js";
import {
  readProjectRoster,
  matchRoster,
  searchFilesystemForProject,
} from "../tools/projectRoster.js";

/**
 * repoResolverAgent.ts — turns free text like "here's a repo: <url> — do X, Y,
 * Z" or "improve error handling in GrantFlow" into a concrete
 * {repoSource, goals}, WITHOUT requiring the owner to fill in a separate
 * structured "which program" field first. This is what direct-prompt mode's
 * single text box runs before the normal extend pipeline starts.
 *
 * Two tiers:
 *  1. Deterministic fast path — a URL in the text, or an exact/near roster
 *     name match — resolved directly, no model call. Cheap and reliable for
 *     the common case.
 *  2. A bounded ReAct-style tool loop (web_fetch / list_known_projects /
 *     search_filesystem / resolve) for the ambiguous cases: a URL that needs
 *     reading before we know what it is, or a name that isn't an exact roster
 *     hit and needs a filesystem search.
 */

export class ResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResolveError";
  }
}

export interface ResolvedRepo {
  /** The TARGET repo — where the build's output is written. */
  repoSource: RepoSource;
  /**
   * ADDITIONAL, read-only SOURCE repos referenced alongside the target — e.g.
   * "combine X and Y" or "take the auth system from A and put it into B"
   * names TWO+ programs, not one. Empty when the prompt only ever meant one.
   */
  additionalSources: RepoSource[];
  goals: string[];
  /** Human-readable trace of what the resolver looked at, for the run log. */
  transcript: string[];
}

const ACTIONS = [
  "web_fetch",
  "list_known_projects",
  "search_filesystem",
  "resolve",
] as const;
const SourceRefSchema = z.object({
  repoType: z.enum(["path", "git"]),
  location: z.string(),
});
const ResolverActionSchema = z.object({
  thought: z.string().default(""),
  action: z.enum(ACTIONS),
  url: z.string().nullable().optional(),
  query: z.string().nullable().optional(),
  repoType: z.enum(["path", "git"]).nullable().optional(),
  location: z.string().nullable().optional(),
  /**
   * When the prompt combines TWO OR MORE programs, every reference beyond
   * the primary target (repoType/location above) goes here — never silently
   * dropped in favor of just the first one found.
   */
  additionalSources: z.array(SourceRefSchema).nullable().optional(),
  goals: z.array(z.string()).nullable().optional(),
});
type ResolverAction = z.infer<typeof ResolverActionSchema>;

function stripUrl(text: string, url: string | null): string[] {
  const goal = url ? text.replace(url, "").trim() : text.trim();
  return goal ? [goal] : [text.trim()];
}

/**
 * Cheap, reliable path — no model call. Returns null when text is ambiguous
 * OR when it names more than one program (that needs real language
 * understanding to tell "combine X and Y" apart from "X, then also do Y to
 * it", so multi-program prompts always fall through to the tool loop below).
 */
async function fastResolve(freeformPrompt: string): Promise<ResolvedRepo | null> {
  const allUrls = extractAllUrls(freeformPrompt).filter(looksLikeRepoUrl);
  if (allUrls.length > 1) return null; // multi-program — needs the LLM loop
  const url = allUrls[0] ?? null;
  if (url) {
    return {
      repoSource: { type: "git", location: url },
      additionalSources: [],
      goals: stripUrl(freeformPrompt, url),
      transcript: [`Fast path: found repo URL ${url} directly in the prompt.`],
    };
  }
  const roster = await readProjectRoster();
  const hit = matchRoster(freeformPrompt, roster);
  if (hit) {
    return {
      repoSource: { type: "path", location: hit.path },
      additionalSources: [],
      goals: [freeformPrompt.trim()],
      transcript: [
        `Fast path: matched project "${hit.name}" -> ${hit.path} in the roster (~/CLAUDE.md).`,
      ],
    };
  }
  return null;
}

const MAX_STEPS = 6;

function buildPrompt(freeformPrompt: string, toolLog: string[]): string {
  return [
    `The owner typed this into a single free-text prompt box — it may reference a project/app/program by NAME, a local path, a git repo URL, or ANY OTHER URL (docs page, live site, API reference, article), or several of these mixed together with instructions.`,
    `IMPORTANT — a reference does NOT have to be a git repo, and does NOT have to be owned by the owner. "Glean from" / "look at how X does it" / "combine X and Y" / "take the auth from A and put it into B" are all legitimate, where A/X can be: someone else's public project (read-only), a local non-git program/folder, or just a URL to a page worth reading (not clonable at all — that's fine, it becomes reference material instead of a codebase to ingest).`,
    `"""${freeformPrompt}"""`,
    toolLog.length
      ? `Tool results so far:\n${toolLog.join("\n\n")}`
      : "(no tool calls yet)",
    `Decide the next action. Available actions:`,
    `- web_fetch: fetch a URL to see what it actually is before deciding to use it (needs "url").`,
    `- list_known_projects: list the owner's known local project roster with canonical paths.`,
    `- search_filesystem: search common project roots on this machine for a directory matching a name (needs "query").`,
    `- resolve: you are confident. Provide repoType ("path" or "git"), location (the URL or local path) for the PRIMARY TARGET (where output should be written), and — ONLY if the prompt references TWO OR MORE distinct programs to combine/glean from/port between — additionalSources: an array of { repoType, location } for every OTHER program referenced (read-only; never treated as the target). Also provide goals (an array of concrete instruction strings extracted from the prompt, with resolved references removed).`,
    `Only call "resolve" once you actually know real, concrete location(s) — never guess a path or URL that wasn't confirmed by a tool result or wasn't literally present in the prompt. If the prompt clearly names two+ programs (e.g. "combine X and Y", "port the auth from A into B"), you MUST resolve ALL of them — never silently pick just one and drop the rest.`,
  ].join("\n\n");
}

export async function repoResolverAgent(
  deps: AgentDeps,
  freeformPrompt: string,
): Promise<ResolvedRepo> {
  const fast = await fastResolve(freeformPrompt);
  if (fast) return fast;

  const transcript: string[] = [];
  const toolLog: string[] = [];

  for (let step = 0; step < MAX_STEPS; step++) {
    const turn = await deps.provider.generateJson<ResolverAction>({
      system:
        `${SYSTEM_PREAMBLE}\nYou are the REPO RESOLVER agent. Your only job is to figure out WHICH existing ` +
        `codebase the owner means and WHAT they want done to it, using the tools described. Be precise and ` +
        `literal — never invent a path or URL.`,
      prompt: buildPrompt(freeformPrompt, toolLog),
      schema: ResolverActionSchema,
      schemaName: "ResolverAction",
      intent: { role: "judge", needs: ["structured_json"] },
      temperature: 0.1,
      maxTokens: 1200,
    });
    transcript.push(
      `step ${step + 1}: ${turn.action}${turn.thought ? ` — ${turn.thought}` : ""}`,
    );

    if (turn.action === "resolve") {
      if (!turn.repoType || !turn.location) {
        throw new ResolveError(
          "Resolver returned action=resolve without a repoType/location — refusing to guess.",
        );
      }
      return {
        repoSource: { type: turn.repoType, location: turn.location },
        additionalSources: (turn.additionalSources ?? []).map((s) => ({
          type: s.repoType,
          location: s.location,
        })),
        goals: turn.goals && turn.goals.length ? turn.goals : [freeformPrompt.trim()],
        transcript,
      };
    }

    if (turn.action === "web_fetch") {
      if (!turn.url) {
        toolLog.push("web_fetch requested without a url — nothing to fetch.");
        continue;
      }
      const res = await webFetchTool(turn.url);
      toolLog.push(
        `web_fetch(${turn.url}) -> ok=${res.ok} status=${res.status} contentType=${res.contentType}\n` +
          (res.error ? `error: ${res.error}` : res.textExcerpt.slice(0, 1500)),
      );
      continue;
    }

    if (turn.action === "list_known_projects") {
      const roster = await readProjectRoster();
      toolLog.push(
        `list_known_projects -> ${roster.length} entries: ` +
          roster.map((r) => `${r.name} => ${r.path}`).join("; "),
      );
      continue;
    }

    if (turn.action === "search_filesystem") {
      const q = turn.query ?? freeformPrompt;
      const found = await searchFilesystemForProject(q);
      toolLog.push(
        `search_filesystem("${q}") -> ${
          found.length
            ? found.map((f) => `${f.name} => ${f.path}`).join("; ")
            : "no matches"
        }`,
      );
      continue;
    }
  }

  throw new ResolveError(
    `Could not resolve a concrete existing codebase from the prompt after ${MAX_STEPS} tool steps. ` +
      `Try including a repo URL, or the exact project name from ~/CLAUDE.md.`,
  );
}
