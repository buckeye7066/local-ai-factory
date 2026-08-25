import { motion } from "framer-motion";
import { Sparkles, Check, AlertTriangle, Gift } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { Badge } from "../ui/Badge.js";
import { staggerContainer, staggerItem } from "../../lib/motion.js";
import type { Health } from "../../../shared/schemas.js";

/** Provider-neutral owner control: spend no money, or use paid rotation. */
export type ProviderTier = "free" | "paid";

/**
 * ProviderRoutingCards exposes exactly the economic choice the owner asked
 * for. Vendor choice stays inside the server's rotator and quota failover.
 * Selecting Free is a hard boundary: paid rescue is disabled for that run.
 */
export function ProviderRoutingCards({
  health,
  routing,
  onRoutingChange,
}: {
  health: Health | null;
  routing: ProviderTier;
  onRoutingChange: (routing: ProviderTier) => void;
}) {
  const freeReady = health?.freeConfigured ?? false;
  const anthropicReady = health?.anthropicConfigured ?? false;
  const openaiReady = health?.openaiConfigured ?? false;
  const paidReady = anthropicReady || openaiReady;
  const serving = health?.route?.serving ?? null;
  const counts = health?.route?.counts;

  const cards = [
    {
      key: "free",
      title: "Free",
      role: routing === "free" ? "$0 rotation only" : "Click to disable paid routes",
      icon: Gift,
      ready: freeReady,
      selected: routing === "free",
      accent: "emerald" as const,
      serving: serving === "free",
      calls: counts?.free,
      onClick: () => {
        if (freeReady) onRoutingChange("free");
      },
    },
    {
      key: "paid",
      title: "Paid rotation",
      role:
        routing === "paid"
          ? "Paid tier — budget gated"
          : "Click to use configured paid routes",
      icon: Sparkles,
      ready: paidReady,
      selected: routing === "paid",
      accent: "violet" as const,
      serving: serving === "anthropic" || serving === "openai",
      calls: (counts?.anthropic ?? 0) + (counts?.openai ?? 0),
      onClick: () => {
        if (paidReady) onRoutingChange("paid");
      },
    },
  ];
  // There is no "Mock Demo" card and no demo prop: no test-run or simulate
  // modes exist in owner tooling. The mock/stub providers remain an internal
  // unit-test substrate only, never an owner surface.

  return (
    <motion.div
      variants={staggerContainer}
      initial="hidden"
      animate="show"
      className={cn(
        "grid grid-cols-1 gap-3 sm:grid-cols-2",
        "sm:grid-cols-2",
      )}
    >
      {cards.map((c) => {
        const Icon = c.icon;
        const selected = c.selected;
        const disabled = !c.ready;
        return (
          <motion.button
            key={c.key}
            variants={staggerItem}
            type="button"
            onClick={c.onClick}
            disabled={disabled}
            whileHover={disabled ? undefined : { y: -3 }}
            className={cn(
              "glass-soft relative overflow-hidden p-4 text-left transition-colors",
              selected
                ? "border-aurora-cyan/40 ring-1 ring-aurora-cyan/30"
                : "hover:border-white/20",
              disabled && "cursor-not-allowed opacity-55",
            )}
            aria-pressed={selected}
          >
            <div className="flex items-center justify-between">
              <span
                className={cn(
                  "grid h-9 w-9 place-items-center rounded-lg",
                  c.accent === "violet" && "bg-aurora-violet/15 text-aurora-violet",
                  c.accent === "cyan" && "bg-aurora-cyan/15 text-aurora-cyan",
                  c.accent === "emerald" && "bg-aurora-emerald/15 text-aurora-emerald",
                )}
              >
                <Icon className="h-4.5 w-4.5" />
              </span>
              {selected && (
                <span className="grid h-5 w-5 place-items-center rounded-full bg-aurora-cyan text-deck-bg">
                  <Check className="h-3 w-3" strokeWidth={3} />
                </span>
              )}
            </div>
            <p className="mt-3 text-sm font-semibold text-white">{c.title}</p>
            <p className="text-xs text-slate-400">{c.role}</p>
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              {c.ready ? (
                <Badge tone="emerald" icon={<Check className="h-3 w-3" />}>
                  {c.key === "free" ? "Free route ready" : "Paid route ready"}
                </Badge>
              ) : (
                <Badge tone={c.key === "free" ? "amber" : "neutral"} icon={<AlertTriangle className="h-3 w-3" />}>
                  {c.key === "free" ? "Free route off" : "No paid key"}
                </Badge>
              )}
              {c.serving && <Badge tone="cyan">serving now</Badge>}
              {typeof c.calls === "number" && c.calls > 0 && (
                <Badge tone={c.key === "free" ? "emerald" : "amber"}>
                  {c.calls} call{c.calls === 1 ? "" : "s"}
                </Badge>
              )}
            </div>
          </motion.button>
        );
      })}
    </motion.div>
  );
}
