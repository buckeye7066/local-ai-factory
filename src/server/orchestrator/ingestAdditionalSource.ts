import type { AppConfig } from "../config.js";
import type { RepoSource } from "../../shared/schemas.js";
import type { AdditionalSourceContext } from "../agents/fileBuilderAgent.js";
import { ingestExistingRepo, IngestError } from "../workspace/ingestRepo.js";
import { analyzeExistingCodebase } from "../workspace/analyzeExistingCodebase.js";
import { webFetchTool, looksLikeRepoUrl } from "../tools/webFetch.js";
import { isRealDirectory } from "../tools/projectRoster.js";

/**
 * ingestAdditionalSource.ts — a SECONDARY reference the owner wants to glean
 * from or port functionality out of, alongside the primary target repo.
 *
 * NOT JUST REPOS: the owner may point at a clonable git repo (their own or
 * someone else's — public/third-party is explicitly fine, read-only), OR at
 * a plain URL that isn't a repository at all — a docs page, an API
 * reference, a blog post, a live site whose design/approach is worth
 * learning from. Both are legitimate "combine/glean from" sources, so this
 * picks the right handling per source rather than assuming everything is
 * clonable:
 *
 *  - A known git-host URL, or a local directory (repo or not) → full
 *    ingestion + stack analysis, exactly like the primary target, but always
 *    read-only (never `inPlace`, regardless of what was requested — nothing
 *    is ever written back into a secondary source).
 *  - Any other URL (can't be cloned as a repo) → fetched directly and its
 *    readable content becomes the reference material instead.
 */
export async function ingestAdditionalSource(
  config: AppConfig,
  source: RepoSource,
  runId: string,
  index: number,
): Promise<AdditionalSourceContext> {
  const isCloneableRepo =
    source.type === "path"
      ? await isRealDirectory(source.location)
      : looksLikeRepoUrl(source.location);

  if (isCloneableRepo) {
    try {
      const ingested = await ingestExistingRepo(
        config.workspaceRoot,
        { ...source, inPlace: false }, // secondary sources are ALWAYS read-only
        `${runId}-src${index}`,
      );
      const analysis = await analyzeExistingCodebase(ingested.path);
      return {
        label: analysis.appNameGuess || source.location,
        fileTreeExcerpt: analysis.fileTree.slice(0, 200).join("\n"),
        manifestExcerpt: analysis.manifestExcerpts
          .map((m) => `--- ${m.path} ---\n${m.excerpt}`)
          .join("\n\n")
          .slice(0, 6000),
        readmeExcerpt: analysis.readmeExcerpt,
      };
    } catch (err) {
      // Fall through to a plain fetch — e.g. a "git"-shaped URL that turned
      // out not to be an actual repo (git clone failed).
      if (!(err instanceof IngestError)) throw err;
    }
  }

  // Plain URL reference: fetch it directly, no clone attempted.
  const fetched = await webFetchTool(source.location);
  return {
    label: source.location,
    fileTreeExcerpt: "",
    manifestExcerpt: "",
    readmeExcerpt: fetched.ok
      ? `(fetched web page, not a repo)\n${fetched.textExcerpt}`
      : `(fetch failed: ${fetched.error ?? fetched.status})`,
  };
}
