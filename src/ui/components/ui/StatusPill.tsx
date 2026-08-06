import { motion } from "framer-motion";
import { cn } from "../../lib/cn.js";
import type { RunStatus, StageStatus } from "../../../shared/schemas.js";

type AnyStatus = RunStatus | StageStatus;

const map: Record<
  AnyStatus,
  { label: string; dot: string; text: string; pulse: boolean }
> = {
  queued: {
    label: "Queued",
    dot: "bg-slate-400",
    text: "text-slate-300",
    pulse: false,
  },
  running: {
    label: "Running",
    dot: "bg-aurora-cyan",
    text: "text-aurora-cyan",
    pulse: true,
  },
  active: {
    label: "Active",
    dot: "bg-aurora-cyan",
    text: "text-aurora-cyan",
    pulse: true,
  },
  completed: {
    label: "Completed",
    dot: "bg-aurora-emerald",
    text: "text-aurora-emerald",
    pulse: false,
  },
  failed: { label: "Failed", dot: "bg-rose-400", text: "text-rose-300", pulse: false },
  cancelled: {
    label: "Cancelled",
    dot: "bg-amber-400",
    text: "text-amber-300",
    pulse: false,
  },
  pending: {
    label: "Pending",
    dot: "bg-slate-500",
    text: "text-slate-400",
    pulse: false,
  },
  skipped: {
    label: "Skipped",
    dot: "bg-slate-500",
    text: "text-slate-400",
    pulse: false,
  },
};

/** StatusPill — animated dot + label that reflects run/stage state. */
export function StatusPill({
  status,
  label,
  className,
}: {
  status: AnyStatus;
  label?: string;
  className?: string;
}) {
  const s = map[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] font-medium",
        s.text,
        className,
      )}
    >
      <span className="relative flex h-2 w-2">
        {s.pulse && (
          <motion.span
            className={cn("absolute inline-flex h-full w-full rounded-full", s.dot)}
            animate={{ scale: [1, 2.2], opacity: [0.6, 0] }}
            transition={{ duration: 1.4, repeat: Infinity, ease: "easeOut" }}
          />
        )}
        <span className={cn("relative inline-flex h-2 w-2 rounded-full", s.dot)} />
      </span>
      {label ?? s.label}
    </span>
  );
}
