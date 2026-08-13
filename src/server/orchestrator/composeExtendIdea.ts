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
export function composeExtendIdea(
  analysis: RepoAnalysis,
  goals: string[],
  additionalSources: AdditionalSourceContext[] = [],
): string {
  const goalList = goals.map((g, i) => `${i + 1}. ${g}`).join("\n");
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
