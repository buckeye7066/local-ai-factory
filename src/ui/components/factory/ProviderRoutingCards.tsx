import { motion } from "framer-motion";
import { Sparkles, Cpu, Check, AlertTriangle, Gift } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { Badge } from "../ui/Badge.js";
import { staggerContainer, staggerItem } from "../../lib/motion.js";
import type { Health } from "../../../shared/schemas.js";

/** Which provider a NEW run pins as its primary. "auto" = free-first. */
export type PaidRouting = "auto" | "anthropic" | "openai";

/**
 * ProviderRoutingCards — how work actually flows across providers, and the
 * owner's control over it.
 *
 * The FREE local route is the default and is an explicit FREE-ONLY choice.
 * Clicking Claude or OpenAI both pins that provider and authorizes billable
 * calls for the run. Merely configuring a key never authorizes spend.
 * The card for whoever is serving right now carries a live marker, so the
 * routing shown here can never disagree with what the deck is doing.
 */
export function ProviderRoutingCards({
  health,
  routing,
  onRoutingChange,
}: {
  health: Health | null;
  routing: PaidRouting;
  onRoutingChange: (routing: PaidRouting) => void;
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
      role:
        routing === "auto"
          ? "FREE-ONLY — no paid calls authorized"
          : "Click to revoke paid authorization",
      icon: Gift,
      ready: freeReady,
      selected: routing === "auto",
      accent: "emerald" as const,
      serving: serving === "free",
      calls: counts?.free,
      onClick: () => {
        if (!freeReady) return;
        onRoutingChange("auto");
      },
    },
    {
      key: "code",
      title: "Claude",
      role:
        routing === "anthropic"
          ? "PAID AUTHORIZED — pinned primary"
          : "Click to authorize and pin Claude",
      icon: Sparkles,
      ready: anthropicReady,
      selected: routing === "anthropic",
      accent: "violet" as const,
      serving: serving === "anthropic",
      calls: counts?.anthropic,
      onClick: () => {
        if (!anthropicReady) return;
        onRoutingChange("anthropic");
      },
    },
    {
      key: "review",
      title: "OpenAI",
      role:
        routing === "openai"
          ? "PAID AUTHORIZED — pinned primary"
          : "Click to authorize and pin OpenAI",
      icon: Cpu,
      ready: openaiReady,
      selected: routing === "openai",
      accent: "cyan" as const,
      serving: serving === "openai",
      calls: counts?.openai,
      onClick: () => {
        if (!openaiReady) return;
        onRoutingChange("openai");
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
        cards.length === 4 ? "lg:grid-cols-4" : "lg:grid-cols-3",
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
              {c.key === "free" ? (
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
                  Paid key configured
                </Badge>
              ) : (
                <Badge tone="neutral" icon={<AlertTriangle className="h-3 w-3" />}>
                  No paid key
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
