import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * unwiredFiles.ts — mechanical honesty about SCAFFOLDING in extend runs.
 *
 * Three consecutive Factory Deck deliveries against GrantFlow (#1233 700222c1,
 * #1235 dac77d5c, d687f5fd) produced new pages, components, and backend
 * modules that NOTHING pre-existing imports — pages reachable only from the
 * delivery's own acceptance test, backend modules imported only by their own
 * smoke tests, parallel implementations of live systems. Each read as
 * delivered features until a human traced the imports by hand. This module is
 * that trace, run mechanically at delivery time: a generated source file that
 * no PRE-EXISTING file references is named in the final report's caveats as
 * scaffolding. Generated files (including generated tests) are never evidence
 * for each other — self-wiring is exactly the pattern being detected.
 *
 * Detection is deliberately conservative in the honest direction: matching is
 * by module-path fragment (`pages/RepositoryTruth`, `modules/matching/engine`)
 * against pre-existing source text, so an aliased import that still names the
 * path counts as wired, while a name coincidence on a different path does not.
 */

const SOURCE_EXT = /\.(?:js|jsx|ts|tsx|mjs|cjs)$/i;
const TEST_LIKE = /(?:^|[\\/])(?:__tests__|tests?)[\\/]|\.(?:test|spec)\.[a-z]+$/i;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  "out",
]);
const MAX_SCAN_FILES = 4000;
const MAX_FILE_BYTES = 512 * 1024;

function walkSourceFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length && out.length < MAX_SCAN_FILES) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(join(dir, entry.name));
      } else if (entry.isFile() && SOURCE_EXT.test(entry.name)) {
        out.push(join(dir, entry.name));
      }
    }
  }
  return out;
}

/** `src/pages/Foo.jsx` → `src/pages/Foo` (and the `pages/Foo` suffix). */
function importFragments(relPath: string): string[] {
  const noExt = relPath.replace(/\\/g, "/").replace(SOURCE_EXT, "");
  const segments = noExt.split("/");
  const fragments = [noExt];
  if (segments.length >= 2) fragments.push(segments.slice(-2).join("/"));
  return fragments;
}

/**
 * Generated source files (excluding tests/docs/configs) that no PRE-EXISTING
 * source file references. Returns workspace-relative paths, sorted. An empty
 * result for a new-app run (no pre-existing files) is honest: with no prior
 * code there is no wiring claim to check.
 */
export function findUnwiredNewFiles(
  workspacePath: string,
  generatedPaths: string[],
): string[] {
  const generated = new Set(
    generatedPaths.map((p) => p.replace(/\\/g, "/")),
  );
  const candidates = generatedPaths.filter((p) => {
    const n = p.replace(/\\/g, "/");
    return (
      SOURCE_EXT.test(n) &&
      !TEST_LIKE.test(n) &&
      (n.startsWith("src/") || n.startsWith("backend/"))
    );
  });
  if (!candidates.length) return [];

  const preExisting = walkSourceFiles(workspacePath).filter((abs) => {
    const rel = relative(workspacePath, abs).replace(/\\/g, "/");
    return !generated.has(rel) && !TEST_LIKE.test(rel);
  });
  if (!preExisting.length) return [];

  const texts: string[] = [];
  for (const abs of preExisting) {
    try {
      if (statSync(abs).size > MAX_FILE_BYTES) continue;
      texts.push(readFileSync(abs, "utf8"));
    } catch {
      /* unreadable pre-existing file is simply not evidence */
    }
  }

  const unwired: string[] = [];
  for (const candidate of candidates) {
    const fragments = importFragments(candidate.replace(/\\/g, "/"));
    const wired = texts.some((text) =>
      fragments.some((f) => text.includes(f)),
    );
    if (!wired) unwired.push(candidate.replace(/\\/g, "/"));
  }
  return unwired.sort();
}

/** One-line caveat for the final report; null when everything is wired. */
export function unwiredCaveat(unwired: string[]): string | null {
  if (!unwired.length) return null;
  const shown = unwired.slice(0, 12).join(", ");
  const more = unwired.length > 12 ? ` (+${unwired.length - 12} more)` : "";
  return (
    `UNWIRED SCAFFOLDING: ${unwired.length} generated source file(s) are referenced by ` +
    `NOTHING pre-existing in the repository — they are not reachable features until wired ` +
    `into the live routers/modules: ${shown}${more}`
  );
}

export const _internal = { importFragments };
