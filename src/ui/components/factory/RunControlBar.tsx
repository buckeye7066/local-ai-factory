import { motion } from "framer-motion";
import {
  Plus,
  Sparkles,
  Cpu,
  FlaskConical,
  Wrench,
  FolderOpen,
  Square,
  RotateCcw,
} from "lucide-react";
import { Button } from "../ui/Button.js";
import { Badge } from "../ui/Badge.js";
import { StatusPill } from "../ui/StatusPill.js";
import { Progress } from "../ui/Progress.js";
import { useClipboard } from "../../lib/useClipboard.js";
import type { RunRecord, ProviderName } from "../../../shared/schemas.js";

const PROVIDER_LABEL: Record<ProviderName, string> = {
  free: "Free (Ollama)",
  anthropic: "Claude",
  openai: "OpenAI",
  stub: "Stub",
  mock: "Mock",
};

/** RunControlBar — sticky header for an in-progress or finished run. */
export function RunControlBar({
  run,
  onNewRun,
  onCancel,
  onResume,
  cancelling = false,
  resuming = false,
}: {
  run: RunRecord;
  onNewRun: () => void;
  onCancel?: () => void;
  onResume?: () => void;
  cancelling?: boolean;
  resuming?: boolean;
}) {
  const running = run.status === "running" || run.status === "queued";
  const done = run.stages.filter(
    (s) => s.status === "completed" || s.status === "skipped",
  ).length;
  const progress = done / run.stages.length;
  const { copied, copy } = useClipboard();

  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      className="glass p-4 sm:p-5"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-lg font-semibold text-white">
              {run.appName ?? "Factory run"}
            </h2>
            <StatusPill status={run.status} />
            {run.demo && (
              <Badge tone="violet" icon={<FlaskConical className="h-3 w-3" />}>
                Demo
              </Badge>
            )}
          </div>
          <p className="mt-1 truncate text-xs text-slate-400">{run.idea}</p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Badge tone="neutral" icon={<Sparkles className="h-3 w-3" />}>
            {PROVIDER_LABEL[run.codeProvider]}
          </Badge>
          <span className="text-slate-600">→</span>
          <Badge tone="neutral" icon={<Cpu className="h-3 w-3" />}>
            {PROVIDER_LABEL[run.reviewProvider]}
          </Badge>
          {run.repairLoops > 0 && (
            <Badge tone="amber" icon={<Wrench className="h-3 w-3" />}>
              {run.repairLoops} repair
            </Badge>
          )}
          {(run.status === "failed" || run.status === "cancelled") &&
            run.resumable &&
            onResume && (
            <Button
              size="sm"
              variant="ghost"
              icon={<RotateCcw className="h-3.5 w-3.5" />}
              onClick={onResume}
              disabled={resuming}
              className="text-aurora-cyan hover:text-white"
            >
              {resuming ? "Resuming…" : "Resume"}
            </Button>
          )}
          {running && onCancel && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Square className="h-3.5 w-3.5" />}
              onClick={onCancel}
              disabled={cancelling}
              className="text-rose-300 hover:text-rose-200"
            >
              {cancelling ? "Stopping…" : "Stop"}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            icon={<Plus className="h-3.5 w-3.5" />}
            onClick={onNewRun}
          >
            New run
          </Button>
        </div>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <Progress value={progress} className="flex-1" />
        <span className="shrink-0 text-[11px] text-slate-400">
          {done}/{run.stages.length} stages
        </span>
      </div>

      {run.workspacePath && (
        <button
          type="button"
          onClick={() => copy(run.workspacePath ?? "")}
          className="mt-3 inline-flex items-center gap-1.5 truncate font-mono text-[11px] text-slate-500 transition-colors hover:text-aurora-cyan"
          title="Copy workspace path"
        >
          <FolderOpen className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{run.workspacePath}</span>
          {copied && <span className="text-aurora-emerald">copied!</span>}
        </button>
      )}
    </motion.div>
  );
}
