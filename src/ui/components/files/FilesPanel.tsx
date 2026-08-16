import { useEffect, useMemo, useState } from "react";
import { Search, FolderTree, Copy, Check } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { useClipboard } from "../../lib/useClipboard.js";
import { Input } from "../ui/Input.js";
import { Button } from "../ui/Button.js";
import { EmptyState } from "../ui/EmptyState.js";
import { Skeleton } from "../ui/Skeleton.js";
import type { FileContent, FileSummary } from "../../../shared/schemas.js";
import { FileTree } from "./FileTree.js";
import { CodePreview } from "./CodePreview.js";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Resolve the FileContent to hand to the preview. If real contents aren't
 * available yet, synthesize a metadata-only record with an explanatory note so
 * the preview can still show language/size/status.
 */
function resolveContent(
  summary: FileSummary | undefined,
  fileContents: FileContent[] | undefined,
): FileContent | null {
  if (!summary) return null;

  // `contents` is defensively optional-chained: a record that predates the
  // FileContent contract (or any future shape drift) must degrade to the
  // placeholder below, never throw mid-render and blank the whole app.
  const match = fileContents?.find((f) => f.path === summary.path);
  if (match && (match.contents?.length ?? 0) > 0) return match;

  return {
    ...summary,
    contents: "// Contents available after generation",
  };
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

/**
 * FilesPanel — split view: filterable file tree (left) + code preview (right).
 * Defaults the selection to the first file once files load, and keeps the
 * selection valid as the file list grows/filters.
 */
export function FilesPanel({
  files,
  fileContents,
  workspacePath,
  loading,
}: {
  files: FileSummary[];
  fileContents?: FileContent[];
  workspacePath?: string | null;
  loading?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const { copied, copy } = useClipboard();

  // Case-insensitive substring filter over the full path.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return files;
    return files.filter((f) => f.path.toLowerCase().includes(q));
  }, [files, query]);

  // Keep the selection valid: default to the first file, and if the current
  // selection drops out of the (filtered) list, fall back to the first one.
  useEffect(() => {
    if (filtered.length === 0) {
      setSelected(null);
      return;
    }
    setSelected((prev) => {
      if (prev && filtered.some((f) => f.path === prev)) return prev;
      return filtered[0]!.path;
    });
  }, [filtered]);

  const selectedSummary = useMemo(
    () => files.find((f) => f.path === selected),
    [files, selected],
  );
  const previewFile = useMemo(
    () => resolveContent(selectedSummary, fileContents),
    [selectedSummary, fileContents],
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02] backdrop-blur-xl">
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* ---------------- Left: tree ---------------- */}
        <div className="flex min-h-0 flex-col border-b border-white/10 md:w-72 md:shrink-0 md:border-b-0 md:border-r">
          {/* Search / filter */}
          <div className="relative border-b border-white/10 p-2.5">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter files…"
              className="h-9 pl-8 text-xs"
            />
          </div>

          {/* Tree body */}
          <div className="min-h-0 flex-1 overflow-auto p-2">
            {loading ? (
              <div className="space-y-2 p-1">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton
                    key={i}
                    className={cn("h-5", i % 3 === 0 ? "w-3/4" : "w-5/6")}
                  />
                ))}
              </div>
            ) : files.length === 0 ? (
              <EmptyState
                className="border-none bg-transparent py-10"
                icon={<FolderTree className="h-6 w-6" />}
                title="No files yet"
                description="Generated files will appear here as the Builder runs."
              />
            ) : filtered.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-slate-500">
                No files match “{query}”.
              </p>
            ) : (
              <FileTree files={filtered} selected={selected} onSelect={setSelected} />
            )}
          </div>
        </div>

        {/* ---------------- Right: preview ---------------- */}
        <div className="min-h-0 flex-1">
          {loading ? (
            <div className="flex h-full flex-col gap-3 p-4">
              <Skeleton className="h-8 w-1/2" />
              <Skeleton className="h-full w-full" />
            </div>
          ) : (
            <CodePreview file={previewFile} />
          )}
        </div>
      </div>

      {/* ---------------- Footer: workspace path ---------------- */}
      {workspacePath && (
        <div className="flex items-center gap-2 border-t border-white/10 bg-black/20 px-3 py-2">
          <span className="shrink-0 text-[11px] font-medium text-slate-500">
            Workspace
          </span>
          <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-aurora-cyan/90">
            {workspacePath}
          </code>
          <span className="hidden text-[11px] text-slate-600 lg:inline">
            Open this folder in your editor / file manager.
          </span>
          <Button
            size="sm"
            variant="ghost"
            icon={
              copied ? (
                <Check className="h-3.5 w-3.5 text-aurora-emerald" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )
            }
            onClick={() => void copy(workspacePath)}
          >
            {copied ? "Copied!" : "Copy"}
          </Button>
        </div>
      )}
    </div>
  );
}
