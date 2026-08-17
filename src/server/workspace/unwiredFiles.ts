import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative } from "node:path";
import * as ts from "typescript";
import { JS_TS_SOURCE_EXTENSION_RX } from "./sourceExtensions.js";

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

const SOURCE_EXT = JS_TS_SOURCE_EXTENSION_RX;
const TEST_LIKE = /(?:^|[\\/])(?:__tests__|tests?)[\\/]|\.(?:test|spec)\.[a-z]+$/i;
const CONFIG_LIKE =
  /(?:^|\/)(?:vitest|jest|playwright|vite)(?:\.[\w-]+)?\.config\.[cm]?[jt]s$/i;
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
    } catch (error) {
      throw new Error(
        `Wiring scan could not read ${dir}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(join(dir, entry.name));
      } else if (entry.isFile() && SOURCE_EXT.test(entry.name)) {
        out.push(join(dir, entry.name));
      }
    }
  }
  if (stack.length > 0) {
    throw new Error(
      `Wiring scan exceeded the ${MAX_SCAN_FILES}-file safety limit.`,
    );
  }
  return out;
}

function withoutSourceExtension(path: string): string {
  return path.replace(/\\/g, "/").replace(SOURCE_EXT, "");
}

function moduleSpecifiers(source: string): string[] {
  const file = ts.createSourceFile(
    "factory-wiring.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const found = new Set<string>();
  const addLiteral = (node: ts.Expression | undefined) => {
    if (node && ts.isStringLiteralLike(node)) found.add(node.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addLiteral(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      addLiteral(node.moduleReference.expression);
    } else if (ts.isCallExpression(node)) {
      const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const requireCall =
        ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (dynamicImport || requireCall) addLiteral(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...found];
}

function referencesModule(
  sourcePath: string,
  source: string,
  candidate: string,
): boolean {
  const candidateNoExt = withoutSourceExtension(candidate);
  const candidateFragments = [
    candidateNoExt,
    candidateNoExt.split("/").slice(-2).join("/"),
  ];
  for (const rawSpecifier of moduleSpecifiers(source)) {
    const specifier = withoutSourceExtension(rawSpecifier);
    if (specifier.startsWith(".")) {
      const resolved = posix.normalize(
        posix.join(posix.dirname(sourcePath.replace(/\\/g, "/")), specifier),
      );
      if (resolved === candidateNoExt) return true;
      continue;
    }
    const clean = specifier.replace(/^\/+/, "");
    if (
      candidateFragments.some(
        (fragment) => clean === fragment || clean.endsWith(`/${fragment}`),
      )
    ) {
      return true;
    }
  }
  return false;
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
    generatedPaths.map((path) => path.replace(/\\/g, "/")),
  );
  const candidates = [...generated].filter(
    (path) =>
      SOURCE_EXT.test(path) &&
      !TEST_LIKE.test(path) &&
      !CONFIG_LIKE.test(path),
  );
  if (!candidates.length) return [];

  const preExisting = walkSourceFiles(workspacePath).filter((absolute) => {
    const rel = relative(workspacePath, absolute).replace(/\\/g, "/");
    return !generated.has(rel) && !TEST_LIKE.test(rel);
  });
  // With no prior source there is no existing product wiring claim (new app).
  if (!preExisting.length) return [];

  const readBounded = (absolute: string): string => {
    const size = statSync(absolute).size;
    if (size > MAX_FILE_BYTES) {
      throw new Error(
        `Wiring scan cannot inspect oversized source file: ${absolute}`,
      );
    }
    return readFileSync(absolute, "utf8");
  };
  const preExistingSources = preExisting.map((absolute) => ({
    path: relative(workspacePath, absolute).replace(/\\/g, "/"),
    contents: readBounded(absolute),
  }));
  const generatedTexts = new Map<string, string>();
  for (const candidate of candidates) {
    try {
      generatedTexts.set(
        candidate,
        readBounded(join(workspacePath, candidate)),
      );
    } catch {
      // A missing/unreadable generated module cannot be proven reachable.
    }
  }

  // Seed reachability from real pre-existing code (including host files this
  // run modified), then traverse imports among generated product modules.
  // Only actual module specifiers count: comments, strings, and longer path
  // prefixes cannot certify reachability.
  const wired = new Set<string>();
  for (const candidate of candidates) {
    if (
      preExistingSources.some((source) =>
        referencesModule(source.path, source.contents, candidate),
      )
    ) {
      wired.add(candidate);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const sourcePath of [...wired]) {
      const source = generatedTexts.get(sourcePath);
      if (!source) continue;
      for (const candidate of candidates) {
        if (
          !wired.has(candidate) &&
          referencesModule(sourcePath, source, candidate)
        ) {
          wired.add(candidate);
          changed = true;
        }
      }
    }
  }

  return candidates.filter((candidate) => !wired.has(candidate)).sort();
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

export const _internal = { moduleSpecifiers, referencesModule };

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
