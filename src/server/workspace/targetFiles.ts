import { existsSync, readFileSync, statSync } from "node:fs";
import type { TaskPlan } from "../../shared/schemas.js";
import { safeResolve } from "./fileWriter.js";

/**
 * targetFiles.ts — find the real files a build is about to change, and read
 * them, so the builder edits code it has actually seen.
 *
 * The builder used to receive only a list of PATHS. Every "modification" was
 * therefore a reconstruction from the filename, which is how an ESM auth
 * module came back as CommonJS with its exports gone. Reading the files is the
 * other half of the fix: refusing blind rewrites stops the damage, supplying
 * the real text is what lets the work actually happen.
 */

const MAX_BYTES_PER_FILE = 24_000;
const MAX_TOTAL_BYTES = 120_000;
const JS_TS_EXT_RX = /\.[cm]?[jt]sx?$/i;

function jsTsStem(path: string): string | null {
  return JS_TS_EXT_RX.test(path) ? path.replace(JS_TS_EXT_RX, "") : null;
}

export interface TargetFileInspection {
  files: { path: string; contents: string }[];
  omitted: Array<{ path: string; reason: string }>;
}

/** Path-shaped tokens mentioned anywhere in the plan's tasks. */
export function mentionedPaths(plan: TaskPlan, ideaText = ""): string[] {
  const text = [
    ideaText,
    ...plan.tasks.map((t) => `${t.title} ${t.detail ?? ""}`),
  ].join("\n");
  const found = new Set<string>();
  for (const m of text.matchAll(
    /\b((?:(?:[\w.@-]+\/)+)?[\w.-]+\.[A-Za-z0-9]{1,6})\b/g,
  )) {
    const raw = m[1]!.replace(/^\.\//, "");
    if (raw.includes("node_modules")) continue;
    found.add(raw);
  }
  return [...found];
}

/**
 * Resolve mentioned paths against the workspace and read them. A path the plan
 * names but that does not exist is simply skipped — it is a file the build will
 * CREATE, and creation legitimately supplies full contents.
 */
export function inspectTargetFiles(
  workspacePath: string,
  plan: TaskPlan,
  ideaText = "",
  fileTree: string[] = [],
): TargetFileInspection {
  const out: { path: string; contents: string }[] = [];
  const omitted: Array<{ path: string; reason: string }> = [];
  let budget = MAX_TOTAL_BYTES;

  const candidates = mentionedPaths(plan, ideaText);
  // A bare filename in the plan ("App.jsx") resolves through the real tree.
  const resolved = new Set<string>();
  for (const c of candidates) {
    let candidatePath: string;
    try {
      candidatePath = safeResolve(workspacePath, c);
    } catch {
      continue;
    }
    if (existsSync(candidatePath)) {
      resolved.add(c);
      continue;
    }

    // Prompts often name a TypeScript convention while the host uses JSX
    // (GrantFlow: src/App.tsx vs its real src/App.jsx). A unique same-path,
    // same-stem JS/TS file is the actual integration point.
    const requestedStem = jsTsStem(c);
    const siblingHits = requestedStem
      ? fileTree.filter((p) => jsTsStem(p) === requestedStem)
      : [];
    if (siblingHits.length === 1) {
      resolved.add(siblingHits[0]!);
      continue;
    }

    // A filename-only fallback is safe only when it is unique.
    const base = c.split("/").pop()!;
    const basenameHits = fileTree.filter(
      (p) => p.endsWith(`/${base}`) || p === base,
    );
    if (basenameHits.length === 1) resolved.add(basenameHits[0]!);
  }

  for (const rel of resolved) {
    try {
      const abs = safeResolve(workspacePath, rel);
      const size = statSync(abs).size;
      if (size > MAX_BYTES_PER_FILE) {
        omitted.push({ path: rel, reason: "file exceeds the per-file context limit" });
        continue;
      }
      if (size > budget) {
        omitted.push({ path: rel, reason: "total target-file context budget exhausted" });
        continue;
      }
      const contents = readFileSync(abs, "utf8");
      budget -= contents.length;
      out.push({ path: rel, contents });
    } catch {
      omitted.push({ path: rel, reason: "file could not be read safely" });
    }
  }
  return { files: out, omitted };
}

export function readTargetFiles(
  workspacePath: string,
  plan: TaskPlan,
  ideaText = "",
  fileTree: string[] = [],
): { path: string; contents: string }[] {
  return inspectTargetFiles(workspacePath, plan, ideaText, fileTree).files;
}
