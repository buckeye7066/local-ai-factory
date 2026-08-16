import { execFileSync } from "node:child_process";
import { statSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
const OTHER_ROOT_CONFIGS_RX = /^(?:tsconfig(?:\.[A-Za-z0-9_-]+)?\.json|\.eslintrc(?:\.[A-Za-z0-9.]+)?|eslint\.config\.(?:js|cjs|mjs|ts))$/i;

export interface ProtectedVerdict {
  refused: boolean;
  reason?: string;
}

/** Workspace-relative paths tracked at git HEAD, or null when not a git repo. */
function trackedFiles(workspacePath: string): Set<string> | null {
  try {
    const out = execFileSync("git", ["-C", workspacePath, "ls-files"], {
      encoding: "utf8",
      timeout: 30_000,
    });
    return new Set(
      out
        .split(/\r?\n/)
        .map((l) => l.trim().replace(/\\/g, "/"))
        .filter(Boolean),
    );
  } catch {
    return null; // not a git repo (new-app workspace) — guard inert
  }
}

const baselineCache = new Map<string, Set<string> | null>();
function baseline(workspacePath: string): Set<string> | null {
  if (!baselineCache.has(workspacePath)) {
    baselineCache.set(workspacePath, trackedFiles(workspacePath));
  }
  return baselineCache.get(workspacePath) ?? null;
}

/** For tests: reset the per-workspace tracked-file cache. */
export function _resetProtectedFilesCache(): void {
  baselineCache.clear();
}

const SOURCE_RX = /\.(m?[jt]sx?|cjs)$/i;

/**
 * Exported symbol names of a JS/TS module — ESM `export` forms plus the
 * CommonJS `module.exports.x` / `exports.x` shapes, so an ESM→CJS rewrite is
 * compared on equal footing.
 */
export function exportedSymbols(source: string): Set<string> {
  const names = new Set<string>();
  const add = (n?: string) => {
    if (n && n !== "default") names.add(n);
  };
  for (const m of source.matchAll(
    /export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g,
  )) add(m[1]);
  for (const m of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of (m[1] ?? "").split(",")) {
      const piece = part.trim();
      if (!piece) continue;
      const asMatch = /as\s+([A-Za-z_$][\w$]*)/.exec(piece);
      add(asMatch ? asMatch[1] : piece.split(/\s+/)[0]);
    }
  }
  for (const m of source.matchAll(
    /(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/g,
  )) add(m[1]);
  for (const m of source.matchAll(/module\.exports\s*=\s*\{([^}]*)\}/g)) {
    for (const part of (m[1] ?? "").split(",")) {
      const key = part.split(":")[0]?.trim();
      if (key && /^[A-Za-z_$][\w$]*$/.test(key)) add(key);
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

  // 1. Lockfiles: derived artifacts, never hand-written.
  if (isTracked && LOCKFILE_NAMES.has(base)) {
    return {
      refused: true,
      reason:
        "lockfiles are derived artifacts of the host repo — mutate them via the " +
        "package manager, never by generated write",
    };
  }

  // 2. package.json: refuse DESTRUCTIVE replacement (a from-scratch stub).
  if (isTracked && base === "package.json") {
    let currentSize = 0;
    try {
      currentSize = statSync(join(workspacePath, norm)).size;
    } catch {
      /* deleted on disk — treat as replaceable */
    }
    if (currentSize > 0 && newContents.length < currentSize * 0.8) {
      return {
        refused: true,
        reason:
          `replacement (${newContents.length} B) would collapse the host manifest ` +
          `(${currentSize} B) — additive edits are fine, from-scratch stubs are not`,
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
      current = readFileSync(join(workspacePath, norm), "utf8");
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

  // Root-level tool configs only from here on.
  if (norm.includes("/")) return { refused: false };

  // 3. Tracked root build/test config: replacement refused.
  if (isTracked && (ROOT_CONFIG_RX.test(base) || OTHER_ROOT_CONFIGS_RX.test(base))) {
    return {
      refused: true,
      reason: "the host repo's root tooling config governs its own suites/builds",
    };
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
