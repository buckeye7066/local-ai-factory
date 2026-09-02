import { motion } from "framer-motion";
import { AlertTriangle, Check, Sparkles } from "lucide-react";
import type { Health, ProviderName } from "../../../shared/schemas.js";
import { staggerItem } from "../../lib/motion.js";
import { Badge } from "../ui/Badge.js";

const LABELS: Record<ProviderName, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  free: "Free / local",
  mock: "Mock",
  stub: "Stub",
};

/**
 * One owner-facing route. Vendor order stays inside the orchestrator; quota,
 * capacity, or model exhaustion advances a sticky run-scoped cursor.
 */
export function ProviderRoutingCards({ health }: { health: Health | null }) {
  const inferred: ProviderName[] = [
    ...(health?.anthropicConfigured ? (["anthropic"] as const) : []),
    ...(health?.openaiConfigured ? (["openai"] as const) : []),
    ...(health?.freeConfigured ? (["free"] as const) : []),
  ];
  const ladder = (health?.modelLadder ?? inferred).filter(
    (name) => name !== "mock" && name !== "stub",
  );
  const ready = ladder.length > 0;
  const serving = health?.route?.serving ?? null;
  const counts = health?.route?.counts;
  const calls =
    (counts?.anthropic ?? 0) + (counts?.openai ?? 0) + (counts?.free ?? 0);

  return (
    <motion.div
      variants={staggerItem}
      initial="hidden"
      animate="show"
      className="glass-soft relative overflow-hidden border-aurora-cyan/35 p-4 ring-1 ring-aurora-cyan/20"
      aria-label="Automatic model ladder"
    >
      <div className="flex items-start justify-between gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-aurora-violet/15 text-aurora-violet">
          <Sparkles className="h-4.5 w-4.5" />
        </span>
        {ready ? (
          <Badge tone="emerald" icon={<Check className="h-3 w-3" />}>
            Ladder ready
          </Badge>
        ) : (
          <Badge tone="amber" icon={<AlertTriangle className="h-3 w-3" />}>
            No live model
          </Badge>
        )}
      </div>

      <p className="mt-3 text-sm font-semibold text-white">
        Automatic model ladder
      </p>
      <p className="mt-0.5 text-xs leading-relaxed text-slate-400">
        Strongest configured paid model first. Quota or capacity exhaustion
        moves the whole run down the ladder; free/local capacity is last.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {ladder.map((name, index) => (
          <span key={name} className="inline-flex items-center gap-1.5">
            {index > 0 && <span className="text-xs text-slate-600">→</span>}
            <Badge
              tone={
                name === serving
                  ? "cyan"
                  : name === "free"
                    ? "emerald"
                    : "violet"
              }
            >
              {LABELS[name]}
              {name === serving ? " · serving" : ""}
            </Badge>
          </span>
        ))}
        {calls > 0 && (
          <Badge tone="neutral">
            {calls} call{calls === 1 ? "" : "s"}
          </Badge>
        )}
      </div>
    </motion.div>
  );
}
