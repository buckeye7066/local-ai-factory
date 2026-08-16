import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FileEdit } from "../../shared/schemas.js";

/**
 * applyEdits.ts — turn anchored edits into new file contents, or refuse.
 *
 * THE ROOT FIX. Factory Deck's builder was handed a list of file PATHS and
 * asked to output whole files, so every "modification" of an existing file was
 * a reconstruction from the filename — the model had literally never seen the
 * code it was replacing. Measured consequences, all in one week: an API auth
 * module rewritten ESM→CommonJS with every export gone, a React App shell that
 * lost its auth route gating, imports of a package the repo does not depend on,
 * and 62 previously-passing tests broken by a slice that was only supposed to
 * add navigation.
 *
 * An anchored edit can only change text it can quote. Everything the model did
 * not think about is preserved because it is never regenerated.
 */

export interface EditOutcome {
  ok: boolean;
  contents?: string;
  /** Why the edit set was refused — always specific enough to act on. */
  reason?: string;
}

/** Apply edits in order; each anchor must match exactly once at its turn. */
export function applyEdits(original: string, edits: FileEdit[]): EditOutcome {
  if (edits.length === 0) {
    return { ok: false, reason: "no edits supplied for an existing file" };
  }
  let out = original;
  for (const [i, edit] of edits.entries()) {
    const first = out.indexOf(edit.find);
    if (first === -1) {
      return {
        ok: false,
        reason:
          `edit ${i + 1}: the quoted text was not found in the file — quote the ` +
          `current text exactly (whitespace included)`,
      };
    }
    const second = out.indexOf(edit.find, first + edit.find.length);
    if (second !== -1) {
      return {
        ok: false,
        reason:
          `edit ${i + 1}: the quoted text appears more than once — include ` +
          `surrounding lines so the anchor is unique`,
      };
    }
    out = out.slice(0, first) + edit.replace + out.slice(first + edit.find.length);
  }
  return { ok: true, contents: out };
}

export interface ResolvedWrite {
  /** Final contents to write, or null when the write must be refused. */
  contents: string | null;
  reason?: string;
  /** True when this file already existed and was edited rather than replaced. */
  edited: boolean;
}

/**
 * Decide what actually gets written for one generated file.
 *
 * - File does not exist → full `contents` (a genuinely new file).
 * - File exists + `edits` → apply them to the REAL current contents.
 * - File exists + only `contents` → refused for source files (that is the
 *   blind-rewrite path). Non-source files (docs, JSON, config data) may still
 *   be replaced wholesale, since they carry no importable surface and the
 *   protected-file rules already cover manifests and tool configs.
 */
export function resolveGeneratedWrite(
  workspacePath: string,
  relPath: string,
  file: { contents: string; edits: FileEdit[] },
  readFile: (p: string) => string = (p) => readFileSync(p, "utf8"),
): ResolvedWrite {
  let current: string | null = null;
  try {
    current = readFile(join(workspacePath, relPath));
  } catch {
    current = null;
  }

  if (current === null) {
    if (file.edits.length > 0 && !file.contents) {
      return {
        contents: null,
        edited: false,
        reason: "edits were supplied for a file that does not exist yet — send full contents",
      };
    }
    return { contents: file.contents, edited: false };
  }

  if (file.edits.length > 0) {
    const outcome = applyEdits(current, file.edits);
    return outcome.ok
      ? { contents: outcome.contents!, edited: true }
      : { contents: null, edited: true, reason: outcome.reason };
  }

  // FIX, DON'T BLOCK (owner rule 2026-08-16). The builder is now GIVEN the
  // file's real contents, so a whole-file answer is an informed rewrite rather
  // than a reconstruction from the filename. Accept it and let the export guard
  // catch any actual destruction — refusing outright would stall real work over
  // a formatting preference. An EMPTY body is still refused: that deletes a file
  // by accident, never on purpose.
  if (!file.contents.trim()) {
    return {
      contents: null,
      edited: true,
      reason: "empty replacement for an existing file — nothing to write",
    };
  }
  return { contents: file.contents, edited: true };
}
