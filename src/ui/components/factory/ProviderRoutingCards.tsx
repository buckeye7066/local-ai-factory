import { motion } from "framer-motion";
import { Sparkles, Cpu, FlaskConical, Check, AlertTriangle, Gift } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { Badge } from "../ui/Badge.js";
import { staggerContainer, staggerItem } from "../../lib/motion.js";
import type { Health } from "../../../shared/schemas.js";

/**
 * ProviderRoutingCards — how work actually flows across providers.
 *
 * The FREE local route is the primary and is shown first; Claude and OpenAI
 * are labelled as what they now are, a rescue tier that only runs when the
 * free route is proven wedged. The card for whoever is serving right now
 * carries a live marker, so the routing shown here can never disagree with
 * what the deck is doing.
 */
export function ProviderRoutingCards({
  health,
  demo,
  onToggleDemo,
}: {
  health: Health | null;
  demo: boolean;
  onToggleDemo: (demo: boolean) => void;
}) {
  const freeReady = health?.freeConfigured ?? false;
  const anthropicReady = health?.anthropicConfigured ?? false;
  const openaiReady = health?.openaiConfigured ?? false;
  const serving = health?.route?.serving ?? null;
  const counts = health?.route?.counts;

  const cards = [
    {
      key: "free",
      title: "Free (Ollama / FCC)",
      role: "Primary — zero cost",
      icon: Gift,
      ready: freeReady,
      live: !demo,
      accent: "emerald" as const,
      serving: serving === "free",
      calls: counts?.free,
      onClick: () => freeReady && onToggleDemo(false),
    },
    {
      key: "code",
      title: "Claude",
      role: "Paid rescue only",
      icon: Sparkles,
      ready: anthropicReady,
      live: !demo,
      accent: "violet" as const,
      serving: serving === "anthropic",
      calls: counts?.anthropic,
      onClick: () => anthropicReady && onToggleDemo(false),
    },
    {
      key: "review",
      title: "OpenAI",
      role: "Paid rescue only",
      icon: Cpu,
      ready: openaiReady,
      live: !demo,
      accent: "cyan" as const,
      serving: serving === "openai",
      calls: counts?.openai,
      onClick: () => openaiReady && onToggleDemo(false),
    },
    {
      key: "mock",
      title: "Mock Demo",
      role: "Offline, deterministic",
      icon: FlaskConical,
      ready: true,
      live: demo,
      accent: "emerald" as const,
      serving: false,
      calls: undefined,
      onClick: () => onToggleDemo(true),
    },
  ];

  return (
    <motion.div
      variants={staggerContainer}
      initial="hidden"
      animate="show"
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
    >
      {cards.map((c) => {
        const Icon = c.icon;
        const selected = c.key === "mock" ? demo : !demo;
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
              {c.key === "mock" ? (
                <Badge tone="emerald">Always available</Badge>
              ) : c.key === "free" ? (
                c.ready ? (
                  <Badge tone="emerald" icon={<Check className="h-3 w-3" />}>
                    Free route ready
                  </Badge>
                ) : (
                  <Badge tone="amber" icon={<AlertTriangle className="h-3 w-3" />}>
                    Free route off
                  </Badge>
                )
              ) : c.ready ? (
                <Badge tone="emerald" icon={<Check className="h-3 w-3" />}>
                  Rescue key set
                </Badge>
              ) : (
                <Badge tone="neutral" icon={<AlertTriangle className="h-3 w-3" />}>
                  No rescue key
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
