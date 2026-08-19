import { readFileSync } from "node:fs";
import type { FileEdit } from "../../shared/schemas.js";
import { safeResolveExistingPath } from "./fileWriter.js";

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
  let quotedCharacters = 0;
  let replacementCharacters = 0;
  for (const [i, edit] of edits.entries()) {
    quotedCharacters += edit.find.length;
    replacementCharacters += edit.replace.length;
    if (quotedCharacters > original.length * 0.5) {
      return {
        ok: false,
        reason:
          `edit ${i + 1}: the edit set quotes more than half of the existing file — ` +
          "split the work into a smaller local change instead of disguising a whole-file rewrite",
      };
    }
    const replacementLimit = Math.max(200, original.length * 0.5);
    if (replacementCharacters > replacementLimit) {
      return {
        ok: false,
        reason:
          `edit ${i + 1}: replacement text exceeds the local-change budget — ` +
          "split the work into smaller behavior-preserving edits",
      };
    }
    const addedOpenComments =
      (edit.replace.match(/\/\*/g)?.length ?? 0) -
      (edit.find.match(/\/\*/g)?.length ?? 0);
    const addedCloseComments =
      (edit.replace.match(/\*\//g)?.length ?? 0) -
      (edit.find.match(/\*\//g)?.length ?? 0);
    if (addedOpenComments !== addedCloseComments) {
      return {
        ok: false,
        reason:
          `edit ${i + 1}: unbalanced block-comment delimiters can disable unrelated code`,
      };
    }

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
    current = readFile(safeResolveExistingPath(workspacePath, relPath));
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";
    if (code === "ENOENT") {
      current = null;
    } else {
      return {
        contents: null,
        edited: false,
        reason:
          "existing-path state could not be read safely; only ENOENT is treated as a new file",
      };
    }
  }

  if (current === null) {
    if (file.edits.length > 0 && !file.contents) {
      return {
        contents: null,
        edited: false,
        reason: "edits were supplied for a file that does not exist yet — send full contents",
      };
    }
    // An EMPTY new file is refused for the same reason an empty replacement
    // is: it is never what the model meant. Creating a 0-byte source file is
    // strictly worse than refusing — the refusal is logged and counted, while
    // the empty file silently ships, imports as `{}`, and turns into a
    // confusing runtime failure far from the build that caused it.
    if (!file.contents.trim()) {
      return {
        contents: null,
        edited: false,
        reason: "empty contents for a new file — nothing to write",
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

  // A zero-byte existing file has no behavior or text to preserve, and the
  // edit schema cannot express an anchor into it. Treat nonempty contents as
  // explicit initialization rather than a replacement.
  if (current.length === 0 && file.contents.trim()) {
    return { contents: file.contents, edited: true };
  }

  // Every nonempty existing text file is edit-only, regardless of language or extension.
  // An allowlist inevitably leaves a destructive path for the next stack
  // (.cpp, .swift, .kt, templates, configs, and so on).
  return {
    contents: null,
    edited: true,
    reason:
      "whole-file replacement of an existing file is refused — return anchored " +
      "edits that quote the current file exactly",
  };
}
