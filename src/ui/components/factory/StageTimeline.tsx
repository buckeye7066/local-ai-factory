import { motion } from "framer-motion";
import {
  Inbox,
  FileText,
  Boxes,
  ListChecks,
  Hammer,
  FlaskConical,
  ShieldCheck,
  Wrench,
  BadgeCheck,
  Check,
  AlertTriangle,
  Loader2,
} from "lucide-react";
import type { ComponentType } from "react";
import { cn } from "../../lib/cn.js";
import { formatDuration } from "../../lib/format.js";
import { Skeleton } from "../ui/Skeleton.js";
import type { StageState, StageId } from "../../../shared/schemas.js";

/**
 * StageTimeline — vertical on desktop, horizontal/compact on mobile. Each stage
 * shows an icon, name, status, duration, and short description. Uses Framer
 * layout animations so updates feel smooth.
 */

const ICONS: Record<StageId, ComponentType<{ className?: string }>> = {
  intake: Inbox,
  product_spec: FileText,
  architect: Boxes,
  task_planner: ListChecks,
  builder: Hammer,
  test_writer: FlaskConical,
  qa_critic: ShieldCheck,
  repair: Wrench,
  final_review: BadgeCheck,
};

function statusStyles(status: StageState["status"]) {
  switch (status) {
    case "completed":
      return {
        ring: "border-aurora-emerald/40 bg-aurora-emerald/10 text-aurora-emerald",
        dot: "bg-aurora-emerald",
      };
    case "active":
      return {
        ring: "border-aurora-cyan/50 bg-aurora-cyan/10 text-aurora-cyan",
        dot: "bg-aurora-cyan",
      };
    case "failed":
      return {
        ring: "border-rose-500/40 bg-rose-500/10 text-rose-300",
        dot: "bg-rose-400",
      };
    case "skipped":
      return {
        ring: "border-white/10 bg-white/[0.03] text-slate-500",
        dot: "bg-slate-600",
      };
    default:
      return {
        ring: "border-white/10 bg-white/[0.02] text-slate-500",
        dot: "bg-slate-700",
      };
  }
}

function StageNode({ stage }: { stage: StageState }) {
  const Icon = ICONS[stage.id];
  const s = statusStyles(stage.status);
  return (
    <div
      className={cn(
        "grid h-10 w-10 shrink-0 place-items-center rounded-xl border transition-colors",
        s.ring,
      )}
    >
      {stage.status === "active" ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : stage.status === "completed" ? (
        <Check className="h-4 w-4" />
      ) : stage.status === "failed" ? (
        <AlertTriangle className="h-4 w-4" />
      ) : (
        <Icon className="h-4 w-4" />
      )}
    </div>
  );
}

export function StageTimeline({
  stages,
  loading,
}: {
  stages: StageState[];
  loading?: boolean;
}) {
  if (loading) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="h-10 w-10 rounded-xl" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3 w-1/3" />
              <Skeleton className="h-2.5 w-2/3" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <>
      {/* Desktop: vertical timeline */}
      <ol className="hidden sm:block">
        {stages.map((stage, i) => {
          const s = statusStyles(stage.status);
          const last = i === stages.length - 1;
          return (
            <motion.li
              key={stage.id}
              layout
              className="relative flex gap-4 pb-5 last:pb-0"
            >
              {!last && (
                <span
                  className={cn(
                    "absolute left-5 top-10 h-[calc(100%-1rem)] w-px -translate-x-1/2",
                    stage.status === "completed"
                      ? "bg-aurora-emerald/30"
                      : "bg-white/10",
                  )}
                />
              )}
              <StageNode stage={stage} />
              <div className="min-w-0 flex-1 pt-0.5">
                <div className="flex items-center justify-between gap-2">
                  <p
                    className={cn(
                      "text-sm font-medium",
                      stage.status === "pending" ? "text-slate-500" : "text-white",
                    )}
                  >
                    {stage.name}
                  </p>
                  <span className="flex items-center gap-2 text-[11px]">
                    {stage.durationMs != null && (
                      <span className="text-slate-500">
                        {formatDuration(stage.durationMs)}
                      </span>
                    )}
                    <span className={cn("h-1.5 w-1.5 rounded-full", s.dot)} />
                  </span>
                </div>
                <p className="mt-0.5 truncate text-xs text-slate-400">
                  {stage.description}
                </p>
              </div>
            </motion.li>
          );
        })}
      </ol>

      {/* Mobile: horizontal compact timeline */}
      <div className="sm:hidden">
        <div className="flex gap-3 overflow-x-auto pb-2">
          {stages.map((stage) => (
            <motion.div
              key={stage.id}
              layout
              className="flex w-20 shrink-0 flex-col items-center gap-1.5 text-center"
            >
              <StageNode stage={stage} />
              <p
                className={cn(
                  "text-[11px] leading-tight",
                  stage.status === "pending" ? "text-slate-500" : "text-slate-200",
                )}
              >
                {stage.name}
              </p>
            </motion.div>
          ))}
        </div>
      </div>
    </>
  );
}
