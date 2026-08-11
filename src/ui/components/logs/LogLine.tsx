import { motion } from "framer-motion";
import {
  Info,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Sparkles,
  FilePlus,
  Terminal,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { formatTime } from "../../lib/format.js";
import { usePrefersReducedMotion } from "../../lib/motion.js";
import type { LogLine as LogLineType, LogKind } from "../../../shared/schemas.js";

/**
 * Per-kind presentation: which lucide glyph to show, the icon tint, and a
 * subtle message tint. Colors are kept muted so a wall of logs stays readable.
 */
const KIND_STYLE: Record<LogKind, { Icon: LucideIcon; icon: string; text: string }> = {
  info: { Icon: Info, icon: "text-slate-400", text: "text-slate-300" },
  success: {
    Icon: CheckCircle2,
    icon: "text-emerald-400",
    text: "text-emerald-200/90",
  },
  warning: {
    Icon: AlertTriangle,
    icon: "text-amber-400",
    text: "text-amber-200/90",
  },
  error: { Icon: XCircle, icon: "text-rose-400", text: "text-rose-200/90" },
  model_call: {
    Icon: Sparkles,
    icon: "text-violet-400",
    text: "text-violet-200/90",
  },
  file_write: {
    Icon: FilePlus,
    icon: "text-cyan-400",
    text: "text-cyan-200/90",
  },
  command_run: {
    Icon: Terminal,
    icon: "text-slate-400",
    text: "text-slate-300",
  },
};

/**
 * LogLine — a single terminal row: `timestamp | icon | message`.
 *
 * The newest line (`isNew`) gets a quick typewriter/fade feel on mount so the
 * eye catches incoming output; this is skipped under reduced-motion.
 */
export function LogLine({ log, isNew }: { log: LogLineType; isNew?: boolean }) {
  const reduced = usePrefersReducedMotion();
  const { Icon, icon, text } = KIND_STYLE[log.kind];

  // Only the freshest line animates, and only when motion is allowed.
  const animate = Boolean(isNew) && !reduced;

  return (
    <motion.div
      initial={animate ? { opacity: 0, x: -6 } : false}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      className="group flex items-start gap-2.5 px-3 py-1 font-mono text-xs leading-relaxed"
    >
      {/* Timestamp — dim, fixed-width so messages stay aligned. */}
      <span className="select-none whitespace-nowrap pt-px text-[10px] tabular-nums text-slate-600">
        {formatTime(log.ts)}
      </span>

      {/* Kind glyph. */}
      <Icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", icon)} aria-hidden />

      {/* Message — wraps on long output, subtly tinted per kind. */}
      <span className={cn("min-w-0 flex-1 whitespace-pre-wrap break-words", text)}>
        {log.message}
      </span>
    </motion.div>
  );
}
