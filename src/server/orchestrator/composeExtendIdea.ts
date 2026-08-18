import type { RepoAnalysis } from "../workspace/analyzeExistingCodebase.js";
import type {
  AdditionalSourceContext,
  ExistingRepoContext,
} from "../agents/fileBuilderAgent.js";

/**
 * composeExtendIdea.ts — the bridge that lets extend-mode reuse
 * productSpecAgent/architectAgent/taskPlannerAgent COMPLETELY UNCHANGED. Those
 * agents only ever see a plain "idea" string; they don't know or care whether
 * it describes a brand-new app or a change to an existing one. So instead of
 * forking new spec/architect agents for existing-codebase mode, we compose a
 * richer idea string that tells the model, in its own terms, "this app already
 * exists, keep its name, here is its stack, here is what to add" — and, for a
 * multi-program combination, "here is what else to glean from / port in."
 */

/**
 * Standing rules every extend run must carry — GrantFlow ba870e71 / PR #1266.
 * Spec, architect, planner, file builder, and Foundry Factory Deck dispatch
 * all read this same text.
 */
export const EXTEND_PERSISTENCE_CONTRACT =
  "EXTEND PERSISTENCE CONTRACT: Do not regenerate App.jsx/App.tsx/server.js/schema.sql/client.js/migrate.js as whole files — edits only. Never write _gh_* / _restore_* / *_from_<sha>* overlay files into the host repo. Unique counters (invoice/order/ticket numbers) are allocated atomically on the server (INSERT … ON CONFLICT … DO UPDATE … RETURNING), never incremented in the browser. Do not leave createStubEntityClient or in-memory Maps as the production client for a user-visible entity — real route + table + client map, or do not expose it. Do not rewrite a live router in a new auth style; nest new routes under an existing mount. New tables: IF NOT EXISTS extras after schema.sql on BOTH the early-return and fresh-bootstrap paths, plus numbered SQLite AND Postgres twins. Changing one create-path field must not drop sibling fields or calls.";

/** Append the standing contract once so Foundry / Factory Deck cannot omit it. */
export function withExtendPersistenceGoals(goals: string[]): string[] {
  if (goals.some((g) => g.includes("EXTEND PERSISTENCE CONTRACT"))) return goals;
  return [...goals, EXTEND_PERSISTENCE_CONTRACT];
}

export function composeExtendIdea(
  analysis: RepoAnalysis,
  goals: string[],
  additionalSources: AdditionalSourceContext[] = [],
): string {
  const goalList = withExtendPersistenceGoals(goals)
    .map((g, i) => `${i + 1}. ${g}`)
    .join("\n");
  return [
    `This is NOT a new app. It is an EXISTING application called "${analysis.appNameGuess}" that already ships.`,
    `Keep the appName exactly "${analysis.appNameGuess}" in your response — do not rename it.`,
    `Existing stack: ${analysis.stackSummary}`,
    analysis.readmeExcerpt ? `Existing README excerpt:\n${analysis.readmeExcerpt}` : "",
    additionalSources.length
      ? `This change also COMBINES functionality gleaned from ${additionalSources.length} additional reference(s) — not owned by the target app, read-only: ${additionalSources.map((s) => s.label).join(", ")}. coreFeatures should reflect what is being ported/combined in from them.`
      : "",
    `The product spec you produce is for the CHANGE being made to this existing app, not a rewrite from scratch. coreFeatures should describe what is being ADDED or FIXED.`,
    `Goals for this change:\n${goalList}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Bound how much of the existing repo goes into the fileBuilder prompt. */
export function buildExistingContext(analysis: RepoAnalysis): ExistingRepoContext {
  const fileTreeExcerpt = analysis.fileTree.slice(0, 400).join("\n");
  const manifestExcerpt = analysis.manifestExcerpts
    .map((m) => `--- ${m.path} ---\n${m.excerpt}`)
    .join("\n\n")
    .slice(0, 8000);
  return {
    fileTreeExcerpt:
      fileTreeExcerpt +
      (analysis.fileTree.length > 400
        ? `\n…(+${analysis.fileTree.length - 400} more files)`
        : ""),
    manifestExcerpt,
    readmeExcerpt: analysis.readmeExcerpt,
  };
}
