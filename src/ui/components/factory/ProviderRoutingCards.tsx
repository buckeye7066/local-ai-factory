import { motion } from "framer-motion";
import { Sparkles, Cpu, FlaskConical, Check, AlertTriangle } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { Badge } from "../ui/Badge.js";
import { staggerContainer, staggerItem } from "../../lib/motion.js";
import type { Health } from "../../../shared/schemas.js";

/**
 * ProviderRoutingCards — three routing cards describing how work flows across
 * providers. Selecting the Stub card switches the run into offline demo mode;
 * selecting a live card switches back (only if a key is configured).
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
  const anthropicReady = health?.anthropicConfigured ?? false;
  const openaiReady = health?.openaiConfigured ?? false;

  const cards = [
    {
      key: "code",
      title: "Claude",
      role: "Planning & code",
      icon: Sparkles,
      ready: anthropicReady,
      live: !demo,
      accent: "violet" as const,
      onClick: () => anthropicReady && onToggleDemo(false),
    },
    {
      key: "review",
      title: "OpenAI",
      role: "Review & testing",
      icon: Cpu,
      ready: openaiReady,
      live: !demo,
      accent: "cyan" as const,
      onClick: () => openaiReady && onToggleDemo(false),
    },
    {
      key: "stub",
      title: "Stub Demo",
      role: "Offline showcase",
      icon: FlaskConical,
      ready: true,
      live: demo,
      accent: "emerald" as const,
      onClick: () => onToggleDemo(true),
    },
  ];

  return (
    <motion.div
      variants={staggerContainer}
      initial="hidden"
      animate="show"
      className="grid grid-cols-1 gap-3 sm:grid-cols-3"
    >
      {cards.map((c) => {
        const Icon = c.icon;
        const selected = c.key === "stub" ? demo : !demo;
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
            <div className="mt-2.5">
              {c.key === "stub" ? (
                <Badge tone="emerald">Always available</Badge>
              ) : c.ready ? (
                <Badge tone="emerald" icon={<Check className="h-3 w-3" />}>
                  Key configured
                </Badge>
              ) : (
                <Badge tone="amber" icon={<AlertTriangle className="h-3 w-3" />}>
                  Key missing
                </Badge>
              )}
            </div>
          </motion.button>
        );
      })}
    </motion.div>
  );
}
