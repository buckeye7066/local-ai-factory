import type { FileBuild } from "../../shared/schemas.js";

const MAX_FILE_CHARS = 24_000;
const MAX_TOTAL_CHARS = 120_000;

export interface BuildCodeContext {
  text: string;
  complete: boolean;
  fullyShownPaths: string[];
  omittedPaths: string[];
}

/**
 * Render the exact code the run has on disk, bounded for provider context.
 * Every truncation or omission is explicit and machine-visible to callers.
 */
export function renderBuildCodeContext(build: FileBuild): BuildCodeContext {
  let remaining = MAX_TOTAL_CHARS;
  const blocks: string[] = [];
  const fullyShownPaths: string[] = [];
  const omittedPaths: string[] = [];

  for (const file of build.files) {
    const raw = file.contents ?? "";
    if (remaining <= 0) {
      omittedPaths.push(file.path);
      blocks.push(
        `----- ${file.path} -----\n(omitted: total code-context budget exhausted)`,
      );
      continue;
    }

    const take = Math.min(raw.length, MAX_FILE_CHARS, remaining);
    const shown = raw.slice(0, take);
    remaining -= take;
    const truncated = take < raw.length;
    if (truncated) omittedPaths.push(file.path);
    else fullyShownPaths.push(file.path);
    blocks.push(
      `----- ${file.path} -----\n` +
        (shown || "(empty file)") +
        (truncated
          ? "\n…(truncated; this file is not safe to repair or approve)"
          : ""),
    );
  }

  const complete = omittedPaths.length === 0;
  const status = complete
    ? "CONTEXT COMPLETE: every supplied file is shown in full."
    : `CONTEXT INCOMPLETE: ${omittedPaths.length} file(s) were truncated or omitted.`;
  return {
    text: `${status}\n\n${blocks.join("\n\n") || "(no files supplied)"}`,
    complete,
    fullyShownPaths,
    omittedPaths,
  };
}

export function renderBuildCode(build: FileBuild): string {
  return renderBuildCodeContext(build).text;
}
