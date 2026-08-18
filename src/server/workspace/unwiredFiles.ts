import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { isFactoryOverlayPath } from "./protectedFiles.js";

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

/**
 * UNWIRED SCAFFOLDING FAILS QA — it does not merely caption the report
 * (2026-08-16, run 5590b773). The GrantFlow extend slice's intake said
 * "You MUST wire the changes into src/App.tsx ..."; the builder wrote seven
 * new source files, wired NONE of them, QA passed, and the caveat announcing
 * "not reachable" appeared only at final review — after every chance to fix
 * it had passed. Features on paper are the exact "interface decoration"
 * failure the product doctrine forbids.
 *
 * This turns the same deterministic detection into a QA verdict: on an
 * EXTEND run, generated source files that no pre-existing file references
 * make QA fail with a high-severity issue carrying a concrete repair
 * instruction, so the EXISTING repair loop gets its shot at wiring — and the
 * loop's re-QA re-runs the detection, so it can only exit green when the
 * wiring genuinely happened. Fresh-app runs are untouched (with no prior
 * code there is no wiring claim to check — findUnwiredNewFiles already
 * returns [] there).
 */
export interface QaLikeReport {
  summary: string;
  passed: boolean;
  issues: Array<{
    severity: "low" | "medium" | "high" | "critical";
    title: string;
    detail: string;
    file: string | null;
    repairInstruction: string;
  }>;
}

export function enforceWiredIntegration<T extends QaLikeReport>(
  qa: T,
  unwired: string[],
  isExtendRun: boolean,
): T {
  if (!isExtendRun || !unwired.length) return qa;
  return {
    ...qa,
    passed: false,
    summary: `UNWIRED: ${unwired.length} generated file(s) are reachable from nothing pre-existing. ${qa.summary}`,
    issues: [
      {
        severity: "high" as const,
        title: `${unwired.length} generated source file(s) are wired into nothing`,
        detail:
          `No pre-existing source file imports or routes to: ${unwired.join(", ")}. ` +
          `Until wired, these are unreachable features — interface decoration, not delivered behavior.`,
        file: unwired[0] ?? null,
        repairInstruction:
          `WIRE the generated files into the application's real entry points by EDITING ` +
          `pre-existing files (imports, routes, component usage) so each becomes reachable. ` +
          `Do NOT delete the generated files to silence this check, and do NOT create new ` +
          `unreferenced files as "wiring".`,
      },
      ...qa.issues,
    ],
  };
}

const STUB_CLIENT_PATH_RX =
  /(?:^|\/)(?:client|entities|entityResourceMap)[^/]*\.(?:js|ts|jsx|tsx)$/i;

/** Overlay names or leftover createStubEntityClient in a generated client/map. */
export function findPersistenceContractViolations(
  generatedPaths: string[],
  generatedFiles?: Iterable<{ path: string; contents: string }>,
): { overlays: string[]; stubClients: string[] } {
  const overlays = [
    ...new Set(
      generatedPaths.map((p) => p.replace(/\\/g, "/")).filter(isFactoryOverlayPath),
    ),
  ].sort();
  const stubClients: string[] = [];
  if (generatedFiles) {
    for (const file of generatedFiles) {
      const n = file.path.replace(/\\/g, "/");
      if (
        STUB_CLIENT_PATH_RX.test(n) &&
        file.contents.includes("createStubEntityClient")
      ) {
        stubClients.push(n);
      }
    }
  }
  return { overlays, stubClients: [...new Set(stubClients)].sort() };
}

/**
 * EXTEND QA net for the ba870e71 persistence pitfalls. Overlay writes are
 * also refused at assessProtectedHostWrite; this fails QA if any still appear
 * in the generated set, or if a generated client/entity map still ships
 * createStubEntityClient.
 */
export function enforceExtendPersistenceQa<T extends QaLikeReport>(
  qa: T,
  generatedPaths: string[],
  generatedFiles: Iterable<{ path: string; contents: string }> | undefined,
  isExtendRun: boolean,
): T {
  if (!isExtendRun) return qa;
  const { overlays, stubClients } = findPersistenceContractViolations(
    generatedPaths,
    generatedFiles,
  );
  if (!overlays.length && !stubClients.length) return qa;
  const issues = [...qa.issues];
  if (overlays.length) {
    issues.unshift({
      severity: "high",
      title: `${overlays.length} factory overlay file(s) must not ship`,
      detail: `Generated overlay/scratch paths: ${overlays.join(", ")}. These must never be written into an extend workspace or delivered to origin.`,
      file: overlays[0] ?? null,
      repairInstruction:
        "Delete the _gh_* / _restore_* / *_from_<sha>* overlay files. Edit the host files in place instead.",
    });
  }
  if (stubClients.length) {
    issues.unshift({
      severity: "high",
      title: "User-visible entity still uses createStubEntityClient",
      detail: `${stubClients.join(", ")} still contains createStubEntityClient — toasts succeed, reload loses the data.`,
      file: stubClients[0] ?? null,
      repairInstruction:
        "Replace the stub with a real route + table + client map, or do not expose the entity.",
    });
  }
  return {
    ...qa,
    passed: false,
    summary: `PERSISTENCE: overlay or stub-entity client in generated files. ${qa.summary}`,
    issues,
  };
}
