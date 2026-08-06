import { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Folder,
  FolderOpen,
  FileCode,
  FileJson,
  FileText,
  FileCog,
  Hash,
  File as FileIcon,
} from "lucide-react";
import { cn } from "../../lib/cn.js";
import { Badge } from "../ui/Badge.js";
import type { FileSummary } from "../../../shared/schemas.js";

/* ------------------------------------------------------------------ */
/* Tree model                                                          */
/* ------------------------------------------------------------------ */

interface FolderNode {
  kind: "folder";
  name: string;
  /** Full path of this folder relative to the root (e.g. "src/lib"). */
  path: string;
  children: TreeNode[];
}

interface FileNode {
  kind: "file";
  name: string;
  /** Full file path (matches FileSummary.path). */
  path: string;
  file: FileSummary;
}

type TreeNode = FolderNode | FileNode;

/**
 * Build a nested folder/file tree from a flat list of "/"-separated paths.
 * Folders are sorted before files, both alphabetically, at every level.
 */
function buildTree(files: FileSummary[]): TreeNode[] {
  const root: FolderNode = { kind: "folder", name: "", path: "", children: [] };

  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    let cursor = root;

    parts.forEach((part, idx) => {
      const isLeaf = idx === parts.length - 1;
      const fullPath = parts.slice(0, idx + 1).join("/");

      if (isLeaf) {
        cursor.children.push({ kind: "file", name: part, path: file.path, file });
        return;
      }

      // Find or create the intermediate folder node.
      let next = cursor.children.find(
        (c): c is FolderNode => c.kind === "folder" && c.name === part,
      );
      if (!next) {
        next = { kind: "folder", name: part, path: fullPath, children: [] };
        cursor.children.push(next);
      }
      cursor = next;
    });
  }

  const sortNodes = (nodes: TreeNode[]): TreeNode[] => {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const node of nodes) {
      if (node.kind === "folder") sortNodes(node.children);
    }
    return nodes;
  };

  return sortNodes(root.children);
}

/** Pick a lucide file-type icon from the extension / language. */
function fileIconFor(file: FileSummary) {
  const ext = file.path.split(".").pop()?.toLowerCase() ?? "";
  const lang = file.language.toLowerCase();

  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext)) return FileCode;
  if (ext === "json" || lang === "json") return FileJson;
  if (["md", "markdown", "txt"].includes(ext)) return FileText;
  if (["css", "scss", "sass", "less"].includes(ext)) return Hash;
  if (
    ["yml", "yaml", "toml", "ini", "env", "conf"].includes(ext) ||
    /config|rc$/.test(file.path)
  ) {
    return FileCog;
  }
  return FileIcon;
}

/* ------------------------------------------------------------------ */
/* Rows                                                                */
/* ------------------------------------------------------------------ */

const ROW_BASE =
  "group flex w-full items-center gap-1.5 rounded-lg py-1 pr-2 text-left text-[13px] transition-colors";

const rowAnim = {
  initial: { opacity: 0, x: -6 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -6 },
  transition: { duration: 0.16 },
};

function FolderRow({
  node,
  depth,
  expanded,
  onToggle,
  selected,
  onSelect,
}: {
  node: FolderNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const isOpen = expanded.has(node.path);
  const Icon = isOpen ? FolderOpen : Folder;

  return (
    <motion.div layout {...rowAnim}>
      <button
        type="button"
        onClick={() => onToggle(node.path)}
        className={cn(
          ROW_BASE,
          "text-slate-300 hover:bg-white/[0.06] hover:text-white",
        )}
        style={{ paddingLeft: depth * 14 + 6 }}
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-aurora-blue" />
        <span className="truncate font-medium">{node.name}</span>
      </button>

      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            layout
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden"
          >
            <NodeList
              nodes={node.children}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              selected={selected}
              onSelect={onSelect}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function FileRow({
  node,
  depth,
  selected,
  onSelect,
}: {
  node: FileNode;
  depth: number;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const isSelected = selected === node.path;
  const isModified = node.file.status === "modified";
  const Icon = fileIconFor(node.file);

  return (
    <motion.div layout {...rowAnim} className="relative">
      <button
        type="button"
        onClick={() => onSelect(node.path)}
        className={cn(
          ROW_BASE,
          isSelected
            ? "bg-white/10 text-white"
            : "text-slate-400 hover:bg-white/[0.05] hover:text-slate-200",
        )}
        style={{ paddingLeft: depth * 14 + 6 }}
        title={node.path}
      >
        {/* Left aurora accent border for the selected row */}
        {isSelected && (
          <span className="absolute inset-y-0.5 left-0 w-0.5 rounded-full bg-aurora-cyan" />
        )}
        <Icon
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            isSelected ? "text-aurora-cyan" : "text-slate-500",
          )}
        />
        <span className="truncate">{node.name}</span>
        {isModified && (
          <Badge tone="amber" className="ml-auto px-1 py-0 text-[9px] leading-none">
            M
          </Badge>
        )}
      </button>
    </motion.div>
  );
}

function NodeList({
  nodes,
  depth,
  expanded,
  onToggle,
  selected,
  onSelect,
}: {
  nodes: TreeNode[];
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  return (
    <div className="flex flex-col">
      <AnimatePresence initial={false}>
        {nodes.map((node) =>
          node.kind === "folder" ? (
            <FolderRow
              key={`d:${node.path}`}
              node={node}
              depth={depth}
              expanded={expanded}
              onToggle={onToggle}
              selected={selected}
              onSelect={onSelect}
            />
          ) : (
            <FileRow
              key={`f:${node.path}`}
              node={node}
              depth={depth}
              selected={selected}
              onSelect={onSelect}
            />
          ),
        )}
      </AnimatePresence>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Public component                                                    */
/* ------------------------------------------------------------------ */

/**
 * FileTree — collapsible tree built from a flat list of file paths.
 * Top-level folders are expanded by default; expansion state is local.
 */
export function FileTree({
  files,
  selected,
  onSelect,
}: {
  files: FileSummary[];
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const tree = useMemo(() => buildTree(files), [files]);

  // Default-expand every top-level folder so files are visible immediately.
  const defaultExpanded = useMemo(
    () =>
      new Set(
        tree.filter((n): n is FolderNode => n.kind === "folder").map((n) => n.path),
      ),
    [tree],
  );

  const [expanded, setExpanded] = useState<Set<string>>(defaultExpanded);

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <NodeList
      nodes={tree}
      depth={0}
      expanded={expanded}
      onToggle={toggle}
      selected={selected}
      onSelect={onSelect}
    />
  );
}
