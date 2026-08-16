import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TaskPlan } from "../../shared/schemas.js";

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

const MAX_FILES = 12;
const MAX_BYTES_PER_FILE = 24_000;
const MAX_TOTAL_BYTES = 120_000;

/** Path-shaped tokens mentioned anywhere in the plan's tasks. */
export function mentionedPaths(plan: TaskPlan, ideaText = ""): string[] {
  const text = [
    ideaText,
    ...plan.tasks.map((t) => `${t.title} ${t.detail ?? ""}`),
  ].join("\n");
  const found = new Set<string>();
  for (const m of text.matchAll(
    /\b((?:[\w.@-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,6})\b/g,
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
export function readTargetFiles(
  workspacePath: string,
  plan: TaskPlan,
  ideaText = "",
  fileTree: string[] = [],
): { path: string; contents: string }[] {
  const out: { path: string; contents: string }[] = [];
  let budget = MAX_TOTAL_BYTES;

  const candidates = mentionedPaths(plan, ideaText);
  // A bare filename in the plan ("App.jsx") resolves through the real tree.
  const resolved = new Set<string>();
  for (const c of candidates) {
    if (existsSync(join(workspacePath, c))) {
      resolved.add(c);
      continue;
    }
    const base = c.split("/").pop()!;
    const hit = fileTree.find((p) => p.endsWith(`/${base}`) || p === base);
    if (hit) resolved.add(hit);
  }

  for (const rel of [...resolved].slice(0, MAX_FILES)) {
    const abs = join(workspacePath, rel);
    try {
      const size = statSync(abs).size;
      if (size > MAX_BYTES_PER_FILE || size > budget) continue;
      const contents = readFileSync(abs, "utf8");
      budget -= contents.length;
      out.push({ path: rel, contents });
    } catch {
      /* unreadable — skip, the builder simply won't be shown it */
    }
  }
  return out;
}
