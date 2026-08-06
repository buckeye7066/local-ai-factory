import { motion, AnimatePresence } from "framer-motion";
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
  CheckCircle2,
  AlertTriangle,
  type LucideIcon,
} from "lucide-react";
import { cn } from "../../lib/cn.js";
import { usePrefersReducedMotion } from "../../lib/motion.js";
import type { StageState, StageId } from "../../../shared/schemas.js";

/* ------------------------------------------------------------------ *
 * Static configuration
 * ------------------------------------------------------------------ */

/** Canonical ordering of the 9 factory stations, left -> right. */
const STAGE_ORDER: StageId[] = [
  "intake",
  "product_spec",
  "architect",
  "task_planner",
  "builder",
  "test_writer",
  "qa_critic",
  "repair",
  "final_review",
];

/** Icon for each station. */
const STAGE_ICON: Record<StageId, LucideIcon> = {
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

/** Aurora palette tokens (kept inline so the component is self-describing). */
const AURORA = {
  cyan: "#22d3ee",
  blue: "#3b82f6",
  violet: "#8b5cf6",
  emerald: "#34d399",
  amber: "#fbbf24",
  rose: "#fb7185",
} as const;

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Find the live StageState for a given id (falls back to a synthetic pending). */
function useStageLookup(stages: StageState[]) {
  const map = new Map<StageId, StageState>();
  for (const s of stages) map.set(s.id, s);
  return (id: StageId): StageState =>
    map.get(id) ?? {
      id,
      name: id,
      description: "",
      status: "pending",
      startedAt: null,
      endedAt: null,
      durationMs: null,
    };
}

/* ------------------------------------------------------------------ *
 * Single station node
 * ------------------------------------------------------------------ */

interface StationNodeProps {
  stage: StageState;
  reduced: boolean;
}

function StationNode({ stage, reduced }: StationNodeProps) {
  const Icon = STAGE_ICON[stage.id];
  const isActive = stage.status === "active";
  const isCompleted = stage.status === "completed";
  const isFailed = stage.status === "failed";
  const isSkipped = stage.status === "skipped";

  // Status-derived visual tint.
  const tint = cn(
    "glass-soft relative flex h-[88px] w-[104px] shrink-0 flex-col items-center justify-center gap-1.5 rounded-2xl border px-2 py-3 text-center transition-colors",
    isCompleted && "border-emerald-400/40 bg-emerald-400/5",
    isFailed && "border-rose-400/50 bg-rose-400/5",
    isActive && "border-cyan-300/50",
    isSkipped && "border-white/5 opacity-40",
    !isActive &&
      !isCompleted &&
      !isFailed &&
      !isSkipped &&
      "border-white/10 opacity-50",
  );

  // Active glow: pulsing boxShadow; static ring when reduced motion.
  const activeAnimation =
    isActive && !reduced
      ? {
          boxShadow: [
            `0 0 0px 0px ${AURORA.cyan}00`,
            `0 0 22px 2px ${AURORA.cyan}66`,
            `0 0 0px 0px ${AURORA.cyan}00`,
          ],
          opacity: [0.92, 1, 0.92],
        }
      : undefined;

  return (
    <div className="flex flex-col items-center gap-1.5">
      <motion.div
        className={cn(tint, isActive && reduced && "ring-2 ring-cyan-300/60")}
        animate={activeAnimation}
        transition={
          activeAnimation
            ? { duration: 2.2, ease: "easeInOut", repeat: Infinity }
            : undefined
        }
      >
        {/* Status badge (top-right corner) */}
        {isCompleted && (
          <CheckCircle2
            className="absolute -right-1.5 -top-1.5 h-4 w-4 text-emerald-400 drop-shadow"
            aria-hidden
          />
        )}
        {isFailed && (
          <AlertTriangle
            className="absolute -right-1.5 -top-1.5 h-4 w-4 text-rose-400 drop-shadow"
            aria-hidden
          />
        )}

        <Icon
          className={cn(
            "h-5 w-5",
            isCompleted && "text-emerald-300",
            isFailed && "text-rose-300",
            isActive && "text-cyan-200",
            (isSkipped || stage.status === "pending") && "text-white/60",
          )}
          aria-hidden
        />

        <span className="line-clamp-2 text-[10px] font-medium leading-tight text-white/80">
          {stage.name}
        </span>

        {/* Tiny status dot indicator */}
        <span
          className={cn(
            "h-1 w-1 rounded-full",
            isActive && "bg-cyan-300",
            isCompleted && "bg-emerald-400",
            isFailed && "bg-rose-400",
            isSkipped && "bg-white/20",
            stage.status === "pending" && "bg-white/15",
          )}
          aria-hidden
        />
      </motion.div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Connector between two consecutive nodes (with optional flowing packet)
 * ------------------------------------------------------------------ */

interface ConnectorProps {
  /** Whether the left node is completed (enables the flowing packet). */
  flowing: boolean;
  reduced: boolean;
}

function Connector({ flowing, reduced }: ConnectorProps) {
  return (
    <div className="relative hidden h-[2px] w-8 self-center md:block">
      {/* Base line */}
      <div
        className={cn(
          "absolute inset-0 rounded-full",
          flowing ? "bg-cyan-400/40" : "bg-white/10",
        )}
      />
      {/* Glowing packet travelling left -> right */}
      {flowing && !reduced && (
        <motion.span
          className="absolute top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full"
          style={{ background: AURORA.cyan, boxShadow: `0 0 8px 2px ${AURORA.cyan}` }}
          initial={{ left: "0%", opacity: 0 }}
          animate={{ left: ["0%", "100%"], opacity: [0, 1, 0] }}
          transition={{
            duration: 1.6,
            ease: "easeInOut",
            repeat: Infinity,
            repeatDelay: 0.4,
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Repair loop arc (qa_critic -> builder), drawn as an SVG overlay
 * ------------------------------------------------------------------ */

interface RepairArcProps {
  active: boolean;
  reduced: boolean;
}

function RepairArc({ active, reduced }: RepairArcProps) {
  // The arc spans from the QA Critic node (index 6) back to Builder (index 4).
  // We render it as a decorative SVG layered under the row on desktop. Because
  // exact node pixel positions are layout-dependent, we use a viewBox-relative
  // curve anchored to roughly those columns (5/9 .. 7/9 of the width) and arc
  // below the row. transform/opacity only -> performant.
  const stroke = active ? AURORA.amber : "#ffffff";

  return (
    <svg
      className="pointer-events-none absolute inset-x-0 bottom-0 hidden h-16 w-full md:block"
      viewBox="0 0 100 30"
      preserveAspectRatio="none"
      aria-hidden
    >
      <defs>
        <linearGradient id="repairGrad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor={AURORA.violet} />
          <stop offset="100%" stopColor={AURORA.amber} />
        </linearGradient>
        <marker
          id="repairHead"
          markerWidth="6"
          markerHeight="6"
          refX="4"
          refY="3"
          orient="auto"
        >
          <path d="M0,0 L6,3 L0,6 Z" fill={active ? "url(#repairGrad)" : "#ffffff"} />
        </marker>
      </defs>

      {/* Curve from QA Critic (~x=72) arcing down and back to Builder (~x=50). */}
      <motion.path
        d="M 72 4 C 72 26, 50 26, 50 6"
        fill="none"
        stroke={active ? "url(#repairGrad)" : stroke}
        strokeWidth={active ? 1.1 : 0.6}
        strokeOpacity={active ? 0.95 : 0.18}
        strokeLinecap="round"
        markerEnd="url(#repairHead)"
        strokeDasharray={active && !reduced ? "4 3" : undefined}
        animate={active && !reduced ? { strokeDashoffset: [0, -14] } : undefined}
        transition={
          active && !reduced
            ? { duration: 1, ease: "linear", repeat: Infinity }
            : undefined
        }
      />
    </svg>
  );
}

/* ------------------------------------------------------------------ *
 * Legend
 * ------------------------------------------------------------------ */

function Legend() {
  const items: { label: string; color: string }[] = [
    { label: "active", color: AURORA.cyan },
    { label: "done", color: AURORA.emerald },
    { label: "repair", color: AURORA.amber },
  ];
  return (
    <div className="mt-4 flex items-center justify-center gap-4 text-[10px] text-white/50">
      {items.map((it) => (
        <span key={it.label} className="flex items-center gap-1.5">
          <span
            className="h-2 w-2 rounded-full"
            style={{ background: it.color, boxShadow: `0 0 6px ${it.color}` }}
          />
          {it.label}
        </span>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Main component
 * ------------------------------------------------------------------ */

export function AgentAssemblyLine({
  stages,
  repairActive,
}: {
  stages: StageState[];
  repairActive: boolean;
}) {
  const reduced = usePrefersReducedMotion();
  const lookup = useStageLookup(stages);

  // Resolve every station in canonical order.
  const resolved = STAGE_ORDER.map((id) => lookup(id));

  return (
    <div className="relative w-full">
      {/* Scroll horizontally on overflow; wrap into a compact grid on mobile. */}
      <div className="relative overflow-x-auto pb-6">
        {/* Desktop: horizontal flowing line. Mobile: wrapped compact grid. */}
        <div className="flex flex-wrap items-stretch justify-center gap-3 md:flex-nowrap md:items-center md:gap-0">
          <AnimatePresence initial={false}>
            {resolved.map((stage, i) => {
              const isLast = i === resolved.length - 1;
              // Packet flows out of a completed node toward its right neighbour.
              const flowing = stage.status === "completed";
              return (
                <motion.div
                  key={stage.id}
                  className="flex items-center"
                  initial={reduced ? false : { opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3, delay: reduced ? 0 : i * 0.03 }}
                >
                  <StationNode stage={stage} reduced={reduced} />
                  {!isLast && <Connector flowing={flowing} reduced={reduced} />}
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>

        {/* Repair loop overlay (desktop only). */}
        <RepairArc active={repairActive} reduced={reduced} />
      </div>

      <Legend />
    </div>
  );
}

export default AgentAssemblyLine;
