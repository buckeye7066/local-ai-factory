import { useEffect, useRef, useState, Fragment } from "react";
import { AnimatePresence } from "framer-motion";
import { Terminal, Copy, Check, ArrowDownToLine } from "lucide-react";
import { formatTime } from "../../lib/format.js";
import { useClipboard } from "../../lib/useClipboard.js";
import { Button } from "../ui/Button.js";
import { Badge } from "../ui/Badge.js";
import { EmptyState } from "../ui/EmptyState.js";
import { LogLine } from "./LogLine.js";
import type { LogLine as LogLineType, StageId } from "../../../shared/schemas.js";

/** Pretty-print a stage id for the transition divider (e.g. `product_spec`). */
function stageLabel(stage: StageId | null): string {
  return stage ?? "general";
}

/** Serialize all log lines into a copy-paste-friendly transcript. */
function logsToText(logs: LogLineType[]): string {
  return logs.map((l) => `${formatTime(l.ts)}  [${l.kind}]  ${l.message}`).join("\n");
}

/**
 * LogsPanel — a premium, terminal-style console card.
 *
 * Renders a server-driven stream of {@link LogLineType}s with a macOS-style
 * header (traffic lights, title, live indicator, line count), an auto-scroll
 * toggle, and a copy-all control. Consecutive logs from different stages are
 * separated by a faint divider so the run reads as distinct phases.
 */
export function LogsPanel({
  logs,
  running,
}: {
  logs: LogLineType[];
  running: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const { copied, copy } = useClipboard();

  // When auto-scroll is on, keep the newest line pinned to the bottom as logs
  // stream in. Toggling auto-scroll off freezes the viewport where it is.
  useEffect(() => {
    if (!autoScroll) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs.length, autoScroll]);

  return (
    <div className="overflow-hidden rounded-2xl border border-white/10 bg-black/40 shadow-glow backdrop-blur-sm">
      {/* ---- Header bar ---- */}
      <div className="flex items-center gap-3 border-b border-white/10 bg-white/[0.02] px-4 py-2.5">
        {/* Traffic-light dots. */}
        <div className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-full bg-rose-500/80" />
          <span className="h-3 w-3 rounded-full bg-amber-400/80" />
          <span className="h-3 w-3 rounded-full bg-emerald-500/80" />
        </div>

        <span className="ml-1 font-mono text-xs font-semibold tracking-wide text-slate-200">
          Factory Console
        </span>

        {/* Live indicator — only while a run is active. */}
        {running && (
          <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-emerald-300">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/70" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
            </span>
            live
          </span>
        )}

        {/* Line count. */}
        <Badge tone="neutral" className="ml-auto font-mono tabular-nums">
          {logs.length} {logs.length === 1 ? "line" : "lines"}
        </Badge>

        {/* Auto-scroll toggle. */}
        <Button
          size="sm"
          variant={autoScroll ? "ghost" : "subtle"}
          icon={<ArrowDownToLine className="h-3.5 w-3.5" />}
          onClick={() => setAutoScroll((v) => !v)}
          aria-pressed={autoScroll}
          title={autoScroll ? "Auto-scroll: on" : "Auto-scroll: off"}
        >
          Auto-scroll
        </Button>

        {/* Copy-all logs. */}
        <Button
          size="sm"
          variant="subtle"
          icon={
            copied ? (
              <Check className="h-3.5 w-3.5 text-emerald-400" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )
          }
          onClick={() => void copy(logsToText(logs))}
          disabled={logs.length === 0}
          title="Copy all logs"
        >
          {copied ? "Copied!" : "Copy logs"}
        </Button>
      </div>

      {/* ---- Body ---- */}
      {logs.length === 0 ? (
        <div className="p-4">
          <EmptyState
            icon={<Terminal className="h-6 w-6" />}
            title="Console is quiet"
            description="Start a run to watch the factory work — model calls, file writes, and commands stream here in real time."
          />
        </div>
      ) : (
        <div
          ref={scrollRef}
          className="max-h-[22rem] overflow-y-auto py-1.5 font-mono text-xs"
        >
          <AnimatePresence initial={false}>
            {logs.map((log, i) => {
              const last = i === logs.length - 1;
              // Show a faint divider whenever the stage changes between rows.
              const prevStage = i > 0 ? logs[i - 1]!.stage : undefined;
              const showDivider = i === 0 || log.stage !== prevStage;

              return (
                <Fragment key={log.id}>
                  {showDivider && (
                    <div className="flex select-none items-center gap-2 px-3 pb-0.5 pt-2 text-[10px] uppercase tracking-widest text-slate-600">
                      <span className="h-px flex-1 bg-white/5" />
                      <span>{stageLabel(log.stage)}</span>
                      <span className="h-px flex-1 bg-white/5" />
                    </div>
                  )}
                  {/* Mark the last line as new so it animates in on arrival. */}
                  <LogLine log={log} isNew={last} />
                </Fragment>
              );
            })}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
