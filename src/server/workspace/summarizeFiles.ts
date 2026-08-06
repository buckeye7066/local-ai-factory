import type { FileSummary, FileContent } from "../../shared/schemas.js";

/**
 * summarizeFiles.ts — derive the secret-free file metadata the UI consumes.
 * Only metadata (path/language/size/status/purpose) crosses to the browser by
 * default; full contents are served lazily through a separate endpoint.
 */
export function summarize(files: FileContent[]): FileSummary[] {
  return files
    .map((f) => ({
      path: f.path,
      language: f.language,
      size: f.size,
      status: f.status,
      purpose: f.purpose,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}
