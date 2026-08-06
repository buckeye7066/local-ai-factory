import { useMemo } from "react";
import { Copy, Check, FileText } from "lucide-react";
import { formatBytes } from "../../lib/format.js";
import { useClipboard } from "../../lib/useClipboard.js";
import { Button } from "../ui/Button.js";
import { Badge } from "../ui/Badge.js";
import { EmptyState } from "../ui/EmptyState.js";
import type { FileContent } from "../../../shared/schemas.js";

/* ------------------------------------------------------------------ */
/* Lightweight, dependency-free, XSS-safe token highlighter            */
/* ------------------------------------------------------------------ */

const KEYWORDS = [
  "const",
  "let",
  "var",
  "function",
  "return",
  "import",
  "export",
  "from",
  "interface",
  "type",
  "if",
  "else",
  "for",
  "while",
  "await",
  "async",
  "class",
  "new",
  "extends",
  "implements",
  "default",
  "switch",
  "case",
  "break",
  "continue",
  "throw",
  "try",
  "catch",
  "finally",
];

/** Escape HTML special chars FIRST so injected spans are the only markup. */
function escapeHtml(input: string): string {
  return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const KEYWORD_RE = new RegExp(`\\b(${KEYWORDS.join("|")})\\b`, "g");

/**
 * Highlight one already-escaped line. We run a single tokenizing regex over the
 * escaped text so strings/comments win over keywords and nothing nests badly.
 * Because the input is escaped up front and we only emit our own <span> tags,
 * the result is safe to pass to dangerouslySetInnerHTML.
 */
function highlightLine(escaped: string): string {
  // Order matters: comments and strings are matched as whole tokens first.
  const TOKEN_RE =
    /(\/\/[^\n]*)|(\/\*[\s\S]*?\*\/)|(&quot;[^&]*?&quot;|&#39;[^&]*?&#39;|"[^"]*"|'[^']*'|`[^`]*`)/g;

  let out = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  const colorKeywords = (segment: string) =>
    segment.replace(
      KEYWORD_RE,
      (kw) => `<span class="text-aurora-violet">${kw}</span>`,
    );

  while ((match = TOKEN_RE.exec(escaped)) !== null) {
    // Plain text before this token gets keyword coloring only.
    out += colorKeywords(escaped.slice(lastIndex, match.index));

    const [token, lineComment, blockComment, str] = match;
    if (lineComment || blockComment) {
      out += `<span class="text-slate-500 italic">${token}</span>`;
    } else if (str) {
      out += `<span class="text-aurora-emerald">${token}</span>`;
    }
    lastIndex = TOKEN_RE.lastIndex;
  }

  out += colorKeywords(escaped.slice(lastIndex));
  return out;
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

/** CodePreview — read-only viewer with gutter line numbers + light coloring. */
export function CodePreview({ file }: { file: FileContent | null }) {
  const { copied, copy } = useClipboard();

  // Pre-compute escaped + highlighted lines (memoized on the raw contents).
  const lines = useMemo(() => {
    if (!file) return [];
    return file.contents.split("\n").map((line) => highlightLine(escapeHtml(line)));
  }, [file]);

  if (!file) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          icon={<FileText className="h-6 w-6" />}
          title="Select a file to preview"
          description="Pick a file from the tree to view its contents here."
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
        <span className="truncate font-mono text-xs text-slate-300" title={file.path}>
          {file.path}
        </span>
        <Badge tone="cyan">{file.language || "text"}</Badge>
        <Badge tone={file.status === "modified" ? "amber" : "neutral"}>
          {file.status}
        </Badge>
        <span className="ml-auto text-[11px] tabular-nums text-slate-500">
          {formatBytes(file.size)}
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
          onClick={() => void copy(file.contents)}
        >
          {copied ? "Copied!" : "Copy"}
        </Button>
      </div>

      {/* Body — horizontal scroll, no wrap, gutter line numbers */}
      <div className="min-h-0 flex-1 overflow-auto bg-black/40">
        <pre className="flex min-w-full font-mono text-xs leading-relaxed">
          {/* Gutter */}
          <code
            aria-hidden
            className="sticky left-0 select-none border-r border-white/5 bg-black/40 px-3 py-3 text-right text-slate-600"
          >
            {lines.map((_, i) => (
              <div key={i}>{i + 1}</div>
            ))}
          </code>

          {/* Code — pre-escaped, only our spans injected */}
          <code className="block flex-1 px-4 py-3 text-slate-200">
            {lines.map((html, i) => (
              <div
                key={i}
                className="whitespace-pre"
                // Safe: contents were HTML-escaped before any span was added.
                dangerouslySetInnerHTML={{ __html: html || "&nbsp;" }}
              />
            ))}
          </code>
        </pre>
      </div>
    </div>
  );
}
