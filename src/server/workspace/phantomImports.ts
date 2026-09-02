import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import ts from "typescript";
import { JS_TS_SOURCE_EXTENSION_RX } from "./sourceExtensions.js";

/**
 * phantomImports.ts — a generated file may only import packages the workspace
 * actually depends on.
 *
 * SermonSmith slice 40c4c51d then ed781d62 both failed the same way: the model
 * wrote `import { Link } from "react-router-dom"` into a repo that depends on
 * `react-router` v8 (where react-router-dom is retired). Nothing catches that
 * until the test run explodes with "Failed to resolve import", and the repair
 * loop then burns paid cycles rediscovering it. The host's manifests already
 * state the truth; this checks the write against them.
 *
 * Declaring the dependency first is a legitimate fix — the check reads the
 * CURRENT manifests on disk, so a build that adds the package to package.json
 * and then imports it passes.
 */

const BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);

/** package.json locations worth reading in a mono-or-single repo. */
const MANIFEST_DIRS = [
  "",
  "apps/web",
  "apps/api",
  "web",
  "api",
  "client",
  "server",
  "services/api",
  "services/web",
  "packages/shared",
  "backend",
  "frontend",
];

export function declaredDependencies(workspacePath: string): Set<string> {
  const names = new Set<string>();
  for (const dir of MANIFEST_DIRS) {
    const p = join(workspacePath, dir, "package.json");
    if (!existsSync(p)) continue;
    try {
      const pkg = JSON.parse(readFileSync(p, "utf8")) as Record<
        string,
        Record<string, string> | undefined
      >;
      for (const field of [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
      ]) {
        for (const name of Object.keys(pkg[field] ?? {})) names.add(name);
      }
    } catch {
      /* unreadable manifest — treated as declaring nothing */
    }
  }
  return names;
}

interface ImportedSpecifier {
  text: string;
  /** Character range inside the specifier's quotes. */
  start: number;
  end: number;
}

function scriptKind(relPath: string): ts.ScriptKind {
  const lower = relPath.toLowerCase();
  if (lower.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (lower.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(lower)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * Return only module specifiers attached to actual syntax nodes. A regex over
 * arbitrary source also matches comments, error messages, and test fixtures
 * such as `const forbidden = ["react", "express"]`.
 */
function importedSpecifiers(
  source: string,
  relPath = "generated.tsx",
): ImportedSpecifier[] {
  const sourceFile = ts.createSourceFile(
    relPath,
    source,
    ts.ScriptTarget.Latest,
    false,
    scriptKind(relPath),
  );
  const specs: ImportedSpecifier[] = [];
  const add = (literal: ts.StringLiteralLike | undefined) => {
    if (!literal) return;
    specs.push({
      text: literal.text,
      start: literal.getStart(sourceFile) + 1,
      end: literal.getEnd() - 1,
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        add(node.moduleSpecifier);
      }
    } else if (ts.isCallExpression(node)) {
      const isRequire =
        ts.isIdentifier(node.expression) && node.expression.text === "require";
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const first = node.arguments[0];
      if ((isRequire || isDynamicImport) && first && ts.isStringLiteralLike(first)) {
        add(first);
      }
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      add(node.argument.literal);
    } else if (
      ts.isExternalModuleReference(node) &&
      node.expression &&
      ts.isStringLiteralLike(node.expression)
    ) {
      add(node.expression);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specs;
}

function packageName(raw: string): string | null {
  if (!raw || raw.startsWith(".") || raw.startsWith("/") || raw.startsWith("#")) {
    return null;
  }
  if (/^[a-zA-Z]+:/.test(raw) && !raw.startsWith("node:")) return null;
  const parts = raw.split("/");
  return raw.startsWith("@") ? parts.slice(0, 2).join("/") || null : parts[0] || null;
}

/** Bare package specifiers imported by a JS/TS source file. */
export function importedPackages(source: string, relPath = "generated.tsx"): string[] {
  const specs = new Set<string>();
  for (const imported of importedSpecifiers(source, relPath)) {
    const pkg = packageName(imported.text);
    if (pkg) specs.add(pkg);
  }
  return [...specs];
}

/** A declared package that looks like what the model meant (react-router-dom → react-router). */
export function nearestDeclared(pkg: string, declared: Set<string>): string | null {
  const trimmed = pkg.replace(/-(dom|native|core|js|node)$/, "");
  if (trimmed !== pkg && declared.has(trimmed)) return trimmed;
  for (const name of declared) {
    if (name.startsWith(`${pkg}-`) || pkg.startsWith(`${name}-`)) return name;
  }
  return null;
}

export interface PhantomVerdict {
  refused: boolean;
  reason?: string;
  /** Contents with fixable specifiers corrected (owner rule: fix, don't block). */
  corrected?: string;
  /** Human-readable list of corrections actually applied. */
  corrections?: string[];
}

/**
 * Rewrite import specifiers the repo does not have to the ones it does.
 * `react-router-dom` in a react-router v8 repo is a KNOWN wrong answer with a
 * known right answer — correcting it is strictly better than refusing the file
 * and making the model guess again (owner rule 2026-08-16: errors are to be
 * FIXED, not blocked).
 */
export function correctPhantomImports(
  contents: string,
  declared: Set<string>,
  relPath = "generated.tsx",
): { contents: string; corrections: string[] } {
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  const corrections = new Set<string>();
  for (const specifier of importedSpecifiers(contents, relPath)) {
    const pkg = packageName(specifier.text);
    if (!pkg || BUILTINS.has(pkg) || declared.has(pkg)) continue;
    const near = nearestDeclared(pkg, declared);
    if (!near) continue;
    replacements.push({
      start: specifier.start,
      end: specifier.end,
      text: `${near}${specifier.text.slice(pkg.length)}`,
    });
    corrections.add(`${pkg} -> ${near}`);
  }
  let out = contents;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    out =
      out.slice(0, replacement.start) + replacement.text + out.slice(replacement.end);
  }
  return { contents: out, corrections: [...corrections] };
}

/**
 * Refuse a generated source file that imports packages the workspace does not
 * declare. Inert when the workspace has no manifests at all (a brand-new app
 * whose package.json arrives in the same build is checked once it exists).
 */
export function assessPhantomImports(
  workspacePath: string,
  relPath: string,
  contents: string,
): PhantomVerdict {
  if (!JS_TS_SOURCE_EXTENSION_RX.test(relPath)) return { refused: false };
  const declared = declaredDependencies(workspacePath);
  if (declared.size === 0) return { refused: false };

  // FIX FIRST: correct every specifier that has a known right answer.
  const fixed = correctPhantomImports(contents, declared, relPath);
  const remaining: string[] = [];
  for (const pkg of importedPackages(fixed.contents, relPath)) {
    if (BUILTINS.has(pkg) || declared.has(pkg)) continue;
    remaining.push(pkg);
  }
  if (remaining.length === 0) {
    return fixed.corrections.length
      ? { refused: false, corrected: fixed.contents, corrections: fixed.corrections }
      : { refused: false };
  }
  // Only a package with NO declared counterpart is still a hard problem: the
  // build must declare it before importing it.
  return {
    refused: true,
    corrected: fixed.corrections.length ? fixed.contents : undefined,
    corrections: fixed.corrections,
    reason:
      `imports ${remaining.length} package(s) the repo does not depend on and that have no ` +
      `declared counterpart: ${remaining.slice(0, 4).join(", ")} — add them to package.json ` +
      `in this same build, or import what the manifests already declare`,
  };
}
