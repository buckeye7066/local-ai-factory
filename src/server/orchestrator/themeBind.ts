/**
 * themeBind.ts — bind WorkTheme at the HTTP/CLI boundary without rewriting
 * runFactory.ts (large). startRun schedules executeRun on a promise chain that
 * inherits AsyncLocalStorage when created inside withWorkTheme.
 */
import {
  createWorkTheme,
  withWorkTheme,
  type WorkTheme,
} from "./workTheme.js";

const THEME_CONSTRAINTS = [
  "Never treat node_modules/, dist/, build/, .next/, out/, or coverage/ as the fix target — edit the source that produced them.",
  "Stay on this program's verified failure; do not invent unrelated refactors.",
];

export function themeForIdea(input: {
  idea: string;
  appName?: string | null;
  stage?: string;
  issue?: string;
}): WorkTheme {
  return createWorkTheme({
    idea: input.idea,
    appName: input.appName,
    stage: input.stage ?? "build",
    issue: input.issue,
    constraints: THEME_CONSTRAINTS,
  });
}

/** Run fn with a directed theme so SYSTEM_PREAMBLE / ThemedProvider stamp every call. */
export function underWorkTheme<T>(
  input: {
    idea: string;
    appName?: string | null;
    stage?: string;
    issue?: string;
  },
  fn: () => T,
): T {
  return withWorkTheme(themeForIdea(input), fn);
}
