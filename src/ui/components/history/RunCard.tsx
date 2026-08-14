import { useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import { motion } from "framer-motion";
import {
  ChevronRight,
  Cpu,
  Play,
  Sparkles,
  Wrench,
  FolderGit2,
  Trash2,
  GitBranch,
  CircleCheck,
  CircleAlert,
} from "lucide-react";
import { cn } from "../../lib/cn.js";
import { formatRelative, formatDateTime } from "../../lib/format.js";
import { Card } from "../ui/Card.js";
import { Badge } from "../ui/Badge.js";
import { Button } from "../ui/Button.js";
import { StatusPill } from "../ui/StatusPill.js";
import { staggerItem } from "../../lib/motion.js";
import type { RunSummary } from "../../../shared/schemas.js";

/** Human-friendly labels for the provider routing chip. */
const PROVIDER_LABELS: Record<RunSummary["codeProvider"], string> = {
  free: "Free (Ollama)",
  anthropic: "Claude",
  openai: "OpenAI",
  stub: "Stub",
  mock: "Mock",
};

/**
 * RunCard — a single run rendered as a polished, clickable glass card.
 *
 * The whole surface is a button: click or Enter/Space opens the run. A staggered
 * entrance is provided via the shared `staggerItem` variant (the parent supplies
 * the `staggerContainer`).
 */
export function RunCard({
  run,
  onOpen,
  onContinue,
  onDelete,
}: {
  run: RunSummary;
  onOpen: (id: string) => void;
  /** Resume a stopped run straight from the list (shown when `resumable`). */
  onContinue?: (id: string) => Promise<void> | void;
  /** Delete a stopped run and its workspace. Hidden while a run is in flight. */
  onDelete?: (id: string) => Promise<void> | void;
}) {
  const title = run.appName ?? "Untitled app";
  const codeLabel = PROVIDER_LABELS[run.codeProvider];
  const reviewLabel = PROVIDER_LABELS[run.reviewProvider];
  const [continuing, setContinuing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // A run that is still working cannot be deleted — the server refuses it too.
  // Every stopped run deletes on ONE click, with no confirmation dialog.
  const stopped =
    run.status === "completed" || run.status === "failed" || run.status === "cancelled";

  const open = () => onOpen(run.id);

  const handleDelete = async (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (!onDelete || deleting) return;
    setDeleting(true);
    try {
      await onDelete(run.id);
    } finally {
      setDeleting(false);
    }
  };

  // One click = work: call resume immediately, no confirmation step. Stop the
  // event so the card's own click-to-open doesn't also fire.
  const handleContinue = async (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (!onContinue || continuing) return;
    setContinuing(true);
    try {
      await onContinue(run.id);
    } finally {
      setContinuing(false);
    }
  };

  // Treat Enter/Space like a click so the card is fully keyboard accessible.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    }
  };

  return (
    <motion.div variants={staggerItem}>
      <Card
        interactive
        role="button"
        tabIndex={0}
        aria-label={`Open run: ${title}`}
        onClick={open}
        onKeyDown={onKeyDown}
        className="group flex flex-col gap-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-aurora-cyan/50"
      >
        {/* Top row: app name + status, with an optional Demo badge. */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-white">{title}</h3>
            {run.demo && (
              <Badge tone="violet" icon={<Sparkles className="h-3 w-3" />}>
                Demo
              </Badge>
            )}
          </div>
          <StatusPill status={run.status} className="shrink-0" />
        </div>

        {/* The originating idea, clamped to two lines so cards stay uniform. */}
        <p className="line-clamp-2 text-xs leading-relaxed text-slate-400">
          {run.idea}
        </p>

        {/* Meta row: provider routing, repair loops, and relative time. */}
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2 py-0.5 font-medium">
            <Cpu className="h-3 w-3 text-aurora-cyan" />
            <span className="text-slate-200">{codeLabel}</span>
            <ChevronRight className="h-3 w-3 text-slate-500" />
            <span className="text-slate-200">{reviewLabel}</span>
          </span>

          {run.repairLoops > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/25 bg-amber-400/10 px-2 py-0.5 font-medium text-amber-300">
              <Wrench className="h-3 w-3" />
              {run.repairLoops} {run.repairLoops === 1 ? "repair" : "repairs"}
            </span>
          )}

          {/* Relative time with an absolute timestamp on hover (native title). */}
          <span
            className="ml-auto text-slate-500"
            title={formatDateTime(run.createdAt)}
          >
            {formatRelative(run.createdAt)}
          </span>
        </div>

        {/* Where the work is saved — visible before the run finishes, so the
            owner can see the destination rather than discover it afterwards. */}
        {run.destination && <DestinationLine destination={run.destination} />}

        {/* Workspace path footer + a chevron that nudges right on hover. */}
        <div className="flex items-center justify-between gap-3 pt-1">
          {run.workspacePath ? (
            <span className="inline-flex min-w-0 items-center gap-1.5 text-[10px] text-slate-500">
              <FolderGit2 className="h-3 w-3 shrink-0" />
              <span className="truncate font-mono">{run.workspacePath}</span>
            </span>
          ) : (
            <span />
          )}
          <span className="flex shrink-0 items-center gap-2">
            {stopped && onDelete && (
              <Button
                size="sm"
                variant="ghost"
                icon={<Trash2 className="h-3.5 w-3.5" />}
                onClick={handleDelete}
                onKeyDown={(e) => e.stopPropagation()}
                disabled={deleting}
                aria-label={`Delete run: ${title}`}
                className="text-slate-400 hover:text-red-300"
              >
                {deleting ? "Deleting…" : "Delete"}
              </Button>
            )}
            {run.resumable && onContinue && (
              <Button
                size="sm"
                variant="ghost"
                icon={<Play className="h-3.5 w-3.5" />}
                onClick={handleContinue}
                onKeyDown={(e) => e.stopPropagation()}
                disabled={continuing}
                aria-label={`Continue run: ${title}`}
                className="text-aurora-cyan hover:text-white"
              >
                {continuing ? "Continuing…" : "Continue"}
              </Button>
            )}
            <ChevronRight
              className={cn(
                "h-4 w-4 shrink-0 text-slate-500 transition-transform duration-200",
                "group-hover:translate-x-0.5 group-hover:text-aurora-cyan",
              )}
            />
          </span>
        </div>
      </Card>
    </motion.div>
  );
}

/**
 * The destination strip: WHERE this run's work is saved.
 *
 * Shown from the moment the run knows its target (before any code is written),
 * and it reports the honest delivery outcome afterwards — a push that was
 * rejected reads as a failure with the git error, never as a quiet success.
 */
function DestinationLine({
  destination,
}: {
  destination: NonNullable<RunSummary["destination"]>;
}) {
  const { kind, target, branch, status, detail, url } = destination;
  const tone =
    status === "delivered"
      ? "border-emerald-400/25 bg-emerald-400/[0.06] text-emerald-200"
      : status === "failed"
        ? "border-red-400/25 bg-red-400/[0.06] text-red-200"
        : "border-white/10 bg-white/[0.03] text-slate-300";
  const label =
    kind === "workspace-only"
      ? "Saved in its workspace folder"
      : kind === "new-repo"
        ? `New repo ${target}`
        : `${target}${branch ? ` · ${branch}` : ""}`;

  return (
    <div className={cn("rounded-lg border px-2.5 py-1.5 text-[11px]", tone)}>
      <div className="flex items-center gap-1.5">
        {status === "delivered" ? (
          <CircleCheck className="h-3 w-3 shrink-0" />
        ) : status === "failed" ? (
          <CircleAlert className="h-3 w-3 shrink-0" />
        ) : (
          <GitBranch className="h-3 w-3 shrink-0" />
        )}
        <span className="truncate font-medium">{label}</span>
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="ml-auto shrink-0 underline underline-offset-2 hover:text-white"
          >
            open
          </a>
        )}
      </div>
      {detail && <p className="mt-0.5 line-clamp-2 text-slate-400">{detail}</p>}
    </div>
  );
}
