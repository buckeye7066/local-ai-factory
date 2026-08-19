import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import * as ts from "typescript";
import { JS_TS_SOURCE_EXTENSION_RX } from "./sourceExtensions.js";
import { safeResolveExistingPath } from "./fileWriter.js";

/**
 * protectedFiles.ts — the ingested repo's manifests and tooling configs are
 * NOT the run's to destroy.
 *
 * Measured incident (run a8a9c84a, 2026-08-15, live GrantFlow extend): the
 * test-writer REPLACED the host's 10,998-byte package.json (87 scripts) with a
 * 192-byte from-scratch stub, and the repair loop then "fixed" the resulting
 * lockfile desync by shrinking it further (103 bytes) and regenerating the
 * lockfile to match — so `npm test` became a bare `vitest run` that executed
 * only the run's own two generated tests while the host's ~1,900-test suite
 * silently vanished from verification. A second, subtler hijack in the same
 * run: writing a NEW root `vitest.config.ts` beside the host's tracked
 * `vitest.config.js` — vitest prefers the .ts variant, so test discovery was
 * redirected without touching any tracked file.
 *
 * The guard is deliberately NOT a blanket write ban (adding a dependency to
 * the host package.json is legitimate extend work). Rules, all scoped to
 * files TRACKED in the workspace's git HEAD (extend runs are clones; new-app
 * workspaces have no git at build time, so the guard is inert there):
 *
 *   1. Tracked LOCKFILES: every generated write refused. Locks are derived
 *      artifacts — package managers may mutate them via commands, agents
 *      must never hand-write them.
 *   2. Tracked package.json: refused when the replacement is DESTRUCTIVE —
 *      smaller than 80% of the tracked version. A merge/addition preserves or
 *      grows the manifest; a from-scratch stub collapses it.
 *   3. Tracked root build/test configs (vitest/jest/playwright/vite/
 *      tsconfig/eslint): replacement refused outright.
 *   4. NEW root test-config VARIANT while the host tracks another variant of
 *      the same tool (the .ts-outranks-.js hijack): refused.
 *
 * Every refusal is loud (the caller logs file + reason), never silent.
 */

const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

/** Root tool-config shapes; capture group 1 is the tool identity. */
const ROOT_CONFIG_RX =
  /^(vitest|jest|playwright|vite)(?:\.[A-Za-z0-9_-]+)?\.config\.(?:js|cjs|mjs|ts|cts|mts)$/i;
const OTHER_ROOT_CONFIGS_RX = /^(?:tsconfig(?:\.[A-Za-z0-9_-]+)?\.json|\.eslintrc(?:\.[A-Za-z0-9.]+)?|eslint\.config\.[cm]?[jt]s)$/i;

const DEPENDENCY_MAP_KEYS = new Set([
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
]);
const PYTHON_TEST_CONFIGS = new Set([
  "pytest.ini",
  "tox.ini",
  "setup.cfg",
  ".coveragerc",
  "pyproject.toml",
]);

function additiveManifestChange(beforeText: string, afterText: string): boolean {
  try {
    const before = JSON.parse(beforeText) as Record<string, unknown>;
    const after = JSON.parse(afterText) as Record<string, unknown>;
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (DEPENDENCY_MAP_KEYS.has(key)) {
        const oldMap =
          before[key] && typeof before[key] === "object"
            ? (before[key] as Record<string, unknown>)
            : {};
        const newMap =
          after[key] && typeof after[key] === "object"
            ? (after[key] as Record<string, unknown>)
            : {};
        for (const [name, value] of Object.entries(oldMap)) {
          if (!(name in newMap) || !isDeepStrictEqual(newMap[name], value)) {
            return false;
          }
        }
        continue;
      }
      if (!isDeepStrictEqual(after[key], before[key])) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function isProtectedConfig(base: string): boolean {
  return (
    ROOT_CONFIG_RX.test(base) ||
    OTHER_ROOT_CONFIGS_RX.test(base) ||
    PYTHON_TEST_CONFIGS.has(base.toLowerCase())
  );
}

export interface ProtectedVerdict {
  refused: boolean;
  reason?: string;
}

interface TrackedBaseline {
  head: string;
  files: Set<string>;
}

/** Workspace-relative paths tracked at git HEAD, or null when not a git repo. */
function trackedFiles(
  workspacePath: string,
  knownHead?: string,
): TrackedBaseline | null {
  let head = knownHead;
  try {
    head =
      head ??
      execFileSync(
        "git",
        ["-C", workspacePath, "rev-parse", "--verify", "HEAD"],
        { encoding: "utf8", timeout: 30_000 },
      ).trim();
  } catch {
    return null; // genuinely not a git repo/new-app workspace
  }
  try {
    const out = execFileSync("git", ["-C", workspacePath, "ls-files", "-z"], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return {
      head: head!,
      files: new Set(
        out
          .split("\0")
          .map((line) => line.replace(/\\/g, "/"))
          .filter(Boolean),
      ),
    };
  } catch (error) {
    throw new Error(
      `Cannot enumerate the host git baseline safely: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

const baselineCache = new Map<string, TrackedBaseline | null>();
function baseline(workspacePath: string): Set<string> | null {
  let head: string;
  try {
    head = execFileSync(
      "git",
      ["-C", workspacePath, "rev-parse", "--verify", "HEAD"],
      { encoding: "utf8", timeout: 30_000 },
    ).trim();
  } catch {
    baselineCache.set(workspacePath, null);
    return null;
  }
  const cached = baselineCache.get(workspacePath);
  if (cached?.head === head) return cached.files;
  const refreshed = trackedFiles(workspacePath, head);
  baselineCache.set(workspacePath, refreshed);
  return refreshed?.files ?? null;
}

/** For tests: reset the per-workspace tracked-file cache. */
export function _resetProtectedFilesCache(): void {
  baselineCache.clear();
}

const SOURCE_RX = JS_TS_SOURCE_EXTENSION_RX;

function hasModifier(
  node: ts.Node,
  kind: ts.SyntaxKind,
): boolean {
  return Boolean(
    ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some((modifier) => modifier.kind === kind),
  );
}

function collectBindingNames(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) {
    out.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) collectBindingNames(element.name, out);
  }
}

/**
 * Parse the module surface with TypeScript's real JS/TS parser. Regex matching
 * was spoofable by strings/templates/regex literals containing "export", and
 * missed type-only declarations. A preservation guard must inspect syntax.
 */
export function exportedSymbols(source: string): Set<string> {
  const names = new Set<string>();
  const sourceFile = ts.createSourceFile(
    "factory-module.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) {
      names.add("default");
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      if (!statement.exportClause) {
        const moduleName =
          statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
            ? statement.moduleSpecifier.text
            : "(unknown)";
        names.add(`*:${moduleName}`);
      } else if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          names.add(element.name.text);
        }
      } else if (ts.isNamespaceExport(statement.exportClause)) {
        names.add(statement.exportClause.name.text);
      }
      continue;
    }

    const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
    if (exported) {
      if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
        names.add("default");
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          collectBindingNames(declaration.name, names);
        }
      } else if (
        (ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement) ||
          ts.isInterfaceDeclaration(statement) ||
          ts.isTypeAliasDeclaration(statement) ||
          ts.isEnumDeclaration(statement) ||
          ts.isModuleDeclaration(statement)) &&
        statement.name
      ) {
        names.add(statement.name.getText(sourceFile));
      }
    }

    if (!ts.isExpressionStatement(statement)) continue;
    const expression = statement.expression;
    if (
      !ts.isBinaryExpression(expression) ||
      expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken
    ) {
      continue;
    }
    const left = expression.left.getText(sourceFile);
    const direct = /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)$/.exec(left);
    if (direct) {
      names.add(direct[1]!);
      continue;
    }
    if (left !== "module.exports") continue;
    if (ts.isObjectLiteralExpression(expression.right)) {
      for (const property of expression.right.properties) {
        if (
          (ts.isPropertyAssignment(property) ||
            ts.isShorthandPropertyAssignment(property) ||
            ts.isMethodDeclaration(property)) &&
          property.name
        ) {
          const text = property.name.getText(sourceFile).replace(/^["']|["']$/g, "");
          if (/^[A-Za-z_$][\w$]*$/.test(text)) names.add(text);
        }
      }
    } else {
      names.add("default");
    }
  }
  return names;
}

export function assessProtectedHostWrite(
  workspacePath: string,
  relPath: string,
  newContents: string,
): ProtectedVerdict {
  const tracked = baseline(workspacePath);
  if (!tracked) return { refused: false };

  const norm = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const base = norm.split("/").pop() ?? norm;
  const isTracked = tracked.has(norm);

  // 1. Lockfiles: derived artifacts, never hand-written. In an extend repo,
  // a new yarn.lock beside a tracked package-lock would switch the planner's
  // package manager and bypass the host's locked dependency graph.
  if (LOCKFILE_NAMES.has(base)) {
    return {
      refused: true,
      reason:
        "lockfiles are derived artifacts of the host repo — mutate them via the " +
        "package manager, never by generated write",
    };
  }

  // 2. package.json: only additive dependency-map entries may change.
  // Test/build scripts, workspaces, package-manager configuration, and every
  // existing dependency value are verification infrastructure and immutable.
  if (isTracked && base === "package.json") {
    let current = "";
    try {
      current = readFileSync(safeResolveExistingPath(workspacePath, norm), "utf8");
    } catch {
      return {
        refused: true,
        reason: "the tracked host manifest could not be read safely",
      };
    }
    if (!additiveManifestChange(current, newContents)) {
      return {
        refused: true,
        reason:
          "tracked package.json may only add dependency-map entries; existing scripts, " +
          "workspaces, configuration, and dependency versions must remain unchanged",
      };
    }
    return { refused: false };
  }

  // 2b. TRACKED SOURCE FILES: a rewrite must not delete the module's public
  //     surface. SermonSmith slice 40c4c51d rewrote services/api/.../auth.js
  //     from ESM to CommonJS (dropping every `export`, breaking 12 tests) and
  //     replaced apps/web/src/App.jsx with a version missing its auth route
  //     gating (breaking 50 more) — a frontend navigation slice destroying
  //     unrelated working code. Additive edits and refactors that KEEP the
  //     exported symbols still pass; only removal is refused.
  if (isTracked && SOURCE_RX.test(base)) {
    let current = "";
    try {
      current = readFileSync(safeResolveExistingPath(workspacePath, norm), "utf8");
    } catch {
      /* unreadable on disk — nothing to protect */
    }
    if (current) {
      const before = exportedSymbols(current);
      const after = exportedSymbols(newContents);
      const dropped = [...before].filter((name) => !after.has(name));
      if (dropped.length > 0) {
        return {
          refused: true,
          reason:
            `replacement drops ${dropped.length} export(s) the host file provides ` +
            `(${dropped.slice(0, 6).join(", ")}) — other files and tests import them; ` +
            `edit additively instead of rewriting the module`,
        };
      }
    }
  }

  // A new JS/TS sibling with the same path stem as tracked source is almost
  // always an accidental shadow entrypoint (for example App.tsx beside the
  // host's real App.jsx). Imports keep resolving the tracked file while the
  // generated feature remains unreachable.
  const isRootToolConfig =
    !norm.includes("/") &&
    ROOT_CONFIG_RX.test(base);
  if (!isTracked && SOURCE_RX.test(norm) && !isRootToolConfig) {
    const stem = norm.replace(SOURCE_RX, "");
    const sibling = [...tracked].find(
      (path) =>
        path !== norm &&
        SOURCE_RX.test(path) &&
        path.replace(SOURCE_RX, "") === stem,
    );
    if (sibling) {
      return {
        refused: true,
        reason:
          `the host already tracks ${sibling} for this source path — edit that real ` +
          "integration point instead of creating a shadow extension variant",
      };
    }
  }

  // 3. Tracked test/build configuration is immutable at every package depth.
  if (isTracked && isProtectedConfig(base)) {
    return {
      refused: true,
      reason: "the host repo's test/build configuration governs its own verification",
    };
  }

  // Root-level new tool-config variants from here on.
  if (norm.includes("/")) return { refused: false };

  // Python's test config files form one precedence family. A new pytest.ini
  // can override a tracked pyproject.toml/setup.cfg without editing it.
  if (!isTracked && PYTHON_TEST_CONFIGS.has(base.toLowerCase())) {
    const hostHasPythonConfig = [...tracked].some(
      (path) =>
        !path.includes("/") &&
        PYTHON_TEST_CONFIGS.has(path.toLowerCase()),
    );
    if (hostHasPythonConfig) {
      return {
        refused: true,
        reason:
          "the host already tracks Python test configuration — a new root variant could redirect pytest discovery",
      };
    }
  }

  // 4. NEW variant of a tool whose config the host already tracks — the
  //    .ts-outranks-.js discovery hijack.
  const toolMatch = ROOT_CONFIG_RX.exec(base);
  if (toolMatch && !isTracked) {
    const tool = toolMatch[1]!.toLowerCase();
    const hostHasVariant = [...tracked].some((t) => {
      if (t.includes("/")) return false;
      const m = ROOT_CONFIG_RX.exec(t);
      return m ? m[1]!.toLowerCase() === tool : false;
    });
    if (hostHasVariant) {
      return {
        refused: true,
        reason:
          `the host already tracks a ${tool} config — a new root variant would ` +
          `silently take precedence and redirect ${tool}'s discovery`,
      };
    }
  }

  return { refused: false };
}
