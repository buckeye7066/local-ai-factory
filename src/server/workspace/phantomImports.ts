import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { builtinModules } from "node:module";

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

/** Bare package specifiers imported by a JS/TS source file. */
export function importedPackages(source: string): string[] {
  const specs = new Set<string>();
  const add = (raw?: string) => {
    if (!raw) return;
    if (raw.startsWith(".") || raw.startsWith("/") || raw.startsWith("#")) return;
    if (/^[a-zA-Z]+:/.test(raw) && !raw.startsWith("node:")) return; // http:, data:
    const parts = raw.split("/");
    const pkg = raw.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
    if (pkg) specs.add(pkg);
  };
  for (const m of source.matchAll(/\bfrom\s+["']([^"']+)["']/g)) add(m[1]);
  for (const m of source.matchAll(/\bimport\s+["']([^"']+)["']/g)) add(m[1]);
  for (const m of source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) add(m[1]);
  for (const m of source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) add(m[1]);
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
  if (!/\.(m?[jt]sx?|cjs)$/i.test(relPath)) return { refused: false };
  const declared = declaredDependencies(workspacePath);
  if (declared.size === 0) return { refused: false };

  const missing: string[] = [];
  for (const pkg of importedPackages(contents)) {
    if (BUILTINS.has(pkg) || declared.has(pkg)) continue;
    const near = nearestDeclared(pkg, declared);
    missing.push(near ? `${pkg} (this repo has ${near})` : pkg);
  }
  if (missing.length === 0) return { refused: false };
  return {
    refused: true,
    reason:
      `imports ${missing.length} package(s) the repo does not depend on: ` +
      `${missing.slice(0, 4).join(", ")} — import what the manifests declare, ` +
      `or add the dependency to package.json in this same build`,
  };
}
