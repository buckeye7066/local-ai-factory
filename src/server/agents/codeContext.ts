import type { FileBuild } from "../../shared/schemas.js";

const MAX_FILE_CHARS = 24_000;
const MAX_TOTAL_CHARS = 120_000;

/**
 * Render the exact code the run has on disk, bounded for provider context.
 * Truncation is explicit; truncated code is never suitable for replacement.
 */
export function renderBuildCode(build: FileBuild): string {
  let remaining = MAX_TOTAL_CHARS;
  const blocks: string[] = [];

  for (const file of build.files) {
    if (remaining <= 0) break;
    const raw = file.contents ?? "";
    const take = Math.min(raw.length, MAX_FILE_CHARS, remaining);
    const shown = raw.slice(0, take);
    remaining -= take;
    blocks.push(
      `----- ${file.path} -----\n` +
        (shown || "(no current contents supplied)") +
        (take < raw.length
          ? "\n…(truncated; do not replace this file wholesale)"
          : ""),
    );
  }

  return blocks.join("\n\n") || "(no files supplied)";
}
