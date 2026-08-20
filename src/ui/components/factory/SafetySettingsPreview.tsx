import { RefreshCw, Gauge, TerminalSquare, ShieldCheck } from "lucide-react";
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
      // NOT a constant. commandRunner's SCRIPT GATE refuses every allowlisted
      // command — installs included — unless ALLOW_UNTRUSTED_SCRIPTS is on,
      // and the server default is OFF. Rendering "Live" regardless told the
      // owner the build really executes while nothing could run. Tri-state,
      // because the field is optional on the wire: an older server that does
      // not report it is UNKNOWN, never quietly rendered as either answer.
      value:
        !health || health.allowUntrustedScripts === undefined
          ? "—"
          : health.allowUntrustedScripts
            ? "Live"
            : "Blocked",
      hint:
        !health || health.allowUntrustedScripts === undefined
          ? "The server did not report whether command execution is enabled."
          : health.allowUntrustedScripts
            ? "Allowlisted commands actually run inside the workspace — every run is real work."
            : "Command execution is DISABLED (ALLOW_UNTRUSTED_SCRIPTS=0): installs, builds and tests are refused, so a run cannot execute what it writes. Set ALLOW_UNTRUSTED_SCRIPTS=1 to let them run.",
      tone: (health?.allowUntrustedScripts === false
        ? "warn"
        : health?.allowUntrustedScripts === true
          ? "safe"
          : "neutral") as "safe" | "warn" | "neutral",
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
                  : it.tone === "warn"
                    ? "border-amber-400/30 bg-amber-400/10 text-amber-200"
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
