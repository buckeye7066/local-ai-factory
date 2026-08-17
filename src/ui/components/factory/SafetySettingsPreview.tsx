import {
  RefreshCw,
  Gauge,
  TerminalSquare,
  ShieldCheck,
  CreditCard,
} from "lucide-react";
import { cn } from "../../lib/cn.js";
import { Tooltip } from "../ui/Tooltip.js";
import type { Health } from "../../../shared/schemas.js";

/**
 * SafetySettingsPreview — a compact, reassuring strip of the safety knobs in
 * effect for a run: max repair loops, max model calls, and live execution.
 */
export function SafetySettingsPreview({ health }: { health: Health | null }) {
  const items = [
    {
      icon: RefreshCw,
      label: "Max repair loops",
      value: health ? String(health.maxRepairLoops) : "—",
      hint: "The repair loop is bounded; it stops as soon as QA passes or this cap is hit.",
      tone: "neutral" as const,
    },
    {
      icon: Gauge,
      label: "Max model calls",
      value: health ? String(health.maxModelCallsPerRun) : "—",
      hint: "Hard ceiling on LLM calls per run — a cost guardrail.",
      tone: "neutral" as const,
    },
    {
      icon: TerminalSquare,
      label: "Command mode",
      value: health ? "Live" : "—",
      hint: "Allowlisted commands actually run inside the workspace — every run is real work.",
      tone: "safe" as const,
    },
    {
      icon: CreditCard,
      label: "Paid daily cap",
      value: health?.route
        ? `${health.route.paidBudget.limits.perDay} calls · $${health.route.paidBudget.limits.usdPerDay.toFixed(2)}`
        : "—",
      hint: "Finite server-enforced ceiling. Paid calls also need explicit per-run authorization and a durable reservation before they start.",
      tone: "neutral" as const,
    },
  ];

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-500">
        <ShieldCheck className="h-3.5 w-3.5 text-aurora-emerald" />
        Safety
      </span>
      {items.map((it) => {
        const Icon = it.icon;
        return (
          <Tooltip key={it.label} content={it.hint}>
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px]",
                it.tone === "safe"
                  ? "border-aurora-emerald/25 bg-aurora-emerald/10 text-aurora-emerald"
                  : "border-white/10 bg-white/[0.04] text-slate-300",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              <span className="text-slate-400">{it.label}:</span>
              <span className="font-semibold">{it.value}</span>
            </span>
          </Tooltip>
        );
      })}
    </div>
  );
}
