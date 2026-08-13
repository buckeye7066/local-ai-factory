import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * projectRoster.ts — the resolver agent's "real local filesystem access" tool
 * for turning a project NAME mentioned in free text ("improve error handling
 * in GrantFlow") into a canonical path, without requiring the owner to fill in
 * a separate structured field.
 *
 * Two tiers, cheapest first:
 *  1. Parse the owner's own hand-maintained roster at `~/CLAUDE.md` (a
 *     markdown table of `| Repo | Canonical local path | ... |` rows) — this
 *     is already the documented source of truth for "where does project X
 *     live," so reading it is far more accurate than guessing.
 *  2. Fall back to scanning common project roots for a directory whose name
 *     fuzzy-matches the query and which is actually a git repo.
 */

export interface RosterEntry {
  name: string;
  path: string;
}

function expandHome(p: string): string {
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

/** Parse the `| Repo | Canonical local path | ... |` table rows out of CLAUDE.md. */
export async function readProjectRoster(
  claudeMdPath: string = join(homedir(), "CLAUDE.md"),
): Promise<RosterEntry[]> {
  let raw: string;
  try {
    raw = await readFile(claudeMdPath, "utf8");
  } catch {
    return [];
  }
  const entries: RosterEntry[] = [];
  const rowRe = /^\|\s*([^|]+?)\s*\|\s*`([^`]+)`\s*\|/gm;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(raw))) {
    const name = m[1].trim();
    const path = m[2].trim();
    if (!name || name.toLowerCase().includes("repo") || /^-+$/.test(name)) continue;
    if (!path) continue;
    entries.push({ name, path: expandHome(path) });
  }
  return entries;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Best fuzzy match by normalized substring containment either direction. */
export function matchRoster(query: string, roster: RosterEntry[]): RosterEntry | null {
  const q = normalize(query);
  if (!q) return null;
  let best: RosterEntry | null = null;
  let bestScore = 0;
  for (const entry of roster) {
    const n = normalize(entry.name);
    if (!n) continue;
    let score = 0;
    if (n === q) score = 100;
    else if (q.includes(n)) score = 80 + n.length;
    else if (n.includes(q)) score = 60 + q.length;
    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }
  return bestScore >= 40 ? best : null;
}

const DEFAULT_SEARCH_ROOTS = [
  homedir(),
  join(homedir(), "source"),
  join(homedir(), "Documents", "Projects"),
];

/** Scan common project roots for a directory whose name matches `query` and is a git repo. */
export async function searchFilesystemForProject(
  query: string,
  roots: string[] = DEFAULT_SEARCH_ROOTS,
): Promise<RosterEntry[]> {
  const q = normalize(query);
  if (!q) return [];
  const found: RosterEntry[] = [];
  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const n = normalize(e.name);
      if (!n.includes(q) && !q.includes(n)) continue;
      const candidate = resolve(join(root, e.name));
      if (existsSync(join(candidate, ".git"))) {
        found.push({ name: e.name, path: candidate });
      }
    }
  }
  return found;
}

/** True when `p` resolves to a real, statable directory. */
export async function isRealDirectory(p: string): Promise<boolean> {
  try {
    const st = await stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}
