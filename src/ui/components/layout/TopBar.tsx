import {
  Menu,
  Sun,
  Moon,
  KeyRound,
  ShieldCheck,
  Wifi,
  WifiOff,
  Gift,
  CreditCard,
  PauseCircle,
} from "lucide-react";
import { Badge } from "../ui/Badge.js";
import { Tooltip } from "../ui/Tooltip.js";
import { cn } from "../../lib/cn.js";
import type { Health } from "../../../shared/schemas.js";
import type { Theme } from "../../lib/useTheme.js";

/**
 * LiveRouteBadge — who is serving RIGHT NOW, always on screen.
 *
 * Paid service can never happen quietly. Green means a $0 route is serving;
 * amber means a paid route is serving (whether explicitly selected or reached
 * by a legacy compatibility path); slate means nothing has run yet.
 */
function LiveRouteBadge({ health }: { health: Health | null }) {
  const route = health?.route;
  if (!route) return null;

  const serving = route.serving;
  const onPaid = serving === "anthropic" || serving === "openai";
  const spend = route.paidBudget.usdLastDay;

  const label = onPaid
    ? `PAID: ${serving}`
    : serving === "free"
      ? "FREE (Ollama/FCC)"
      : route.holdActive
        ? "free on hold"
        : "FREE — idle";

  const tip = onPaid
    ? `A paid provider is serving this call. Strict Free runs never attach a paid fallback. ` +
      `${route.lastFailoverReason ? `Recorded failover reason: ${route.lastFailoverReason}. ` : ""}` +
      `Local estimated paid usage in the last 24h: $${spend.toFixed(4)} of ` +
      `$${route.paidBudget.limits.usdPerDay.toFixed(2)} admission guard. ` +
      `Use provider-native account caps for a hard actual-spend limit.`
    : `Running on the FREE local route at zero cost. ` +
      `Free calls: ${route.counts.free}, paid rescues: ` +
      `${route.counts.anthropic + route.counts.openai}. ` +
      `Nearly failed over ${route.wouldHaveFailedOver} time(s) and waited instead.`;

  return (
    <Tooltip content={tip}>
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium",
          onPaid
            ? "border-amber-400/40 bg-amber-400/10 text-amber-300"
            : route.holdActive
              ? "border-amber-400/25 bg-amber-400/5 text-amber-200/80"
              : "border-aurora-emerald/25 bg-aurora-emerald/10 text-aurora-emerald",
        )}
      >
        {onPaid ? (
          <CreditCard className="h-3.5 w-3.5" />
        ) : route.holdActive ? (
          <PauseCircle className="h-3.5 w-3.5" />
        ) : (
          <Gift className="h-3.5 w-3.5" />
        )}
        {label}
      </span>
    </Tooltip>
  );
}

/**
 * TopBar — provider/key status, live-execution badge, theme toggle, and the mobile
 * menu button. Key indicators show ONLY configured/missing, never values.
 */
export function TopBar({
  health,
  theme,
  onToggleTheme,
  onOpenMenu,
}: {
  health: Health | null;
  theme: Theme;
  onToggleTheme: () => void;
  onOpenMenu: () => void;
}) {
  const online = health !== null;
  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-white/[0.06] bg-deck-bg/70 px-4 backdrop-blur-xl sm:px-6">
      <button
        onClick={onOpenMenu}
        aria-label="Open menu"
        className="rounded-lg p-2 text-slate-300 hover:bg-white/5 lg:hidden"
      >
        <Menu className="h-5 w-5" />
      </button>

      {/* Backend / provider status */}
      <div className="flex items-center gap-2">
        <Tooltip content={online ? "Local backend connected" : "Backend not reachable"}>
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium",
              online
                ? "border-aurora-emerald/25 bg-aurora-emerald/10 text-aurora-emerald"
                : "border-rose-500/25 bg-rose-500/10 text-rose-300",
            )}
          >
            {online ? (
              <Wifi className="h-3.5 w-3.5" />
            ) : (
              <WifiOff className="h-3.5 w-3.5" />
            )}
            {online ? "Connected" : "Offline"}
          </span>
        </Tooltip>

        {/* ALWAYS-ON routing indicator. A paid call can never be silent:
            this turns amber the moment a call is served by a paid tier. */}
        <LiveRouteBadge health={health} />
      </div>

      <div className="ml-auto flex items-center gap-2">
        {/* API key indicators — booleans only, never values */}
        <Tooltip content="Anthropic / Claude API key">
          <span>
            <Badge
              tone={health?.anthropicConfigured ? "emerald" : "neutral"}
              icon={<KeyRound className="h-3 w-3" />}
            >
              Claude {health?.anthropicConfigured ? "✓" : "—"}
            </Badge>
          </span>
        </Tooltip>
        <Tooltip content="OpenAI API key">
          <span>
            <Badge
              tone={health?.openaiConfigured ? "emerald" : "neutral"}
              icon={<KeyRound className="h-3 w-3" />}
            >
              OpenAI {health?.openaiConfigured ? "✓" : "—"}
            </Badge>
          </span>
        </Tooltip>

        {/* Execution badge. There is no dry-run mode, but commandRunner's SCRIPT
            GATE refuses every allowlisted command unless ALLOW_UNTRUSTED_SCRIPTS
            is on (server default: OFF), so "Live" is a fact to read, never a
            constant to print. */}
        {health && health.allowUntrustedScripts !== undefined && (
          <Tooltip
            content={
              health.allowUntrustedScripts
                ? "Allowlisted commands execute for real inside workspaces"
                : "Command execution is disabled (ALLOW_UNTRUSTED_SCRIPTS=0): installs, builds and tests are refused, so a run cannot execute what it writes"
            }
          >
            <span>
              <Badge
                tone={health.allowUntrustedScripts ? "emerald" : "amber"}
                icon={<ShieldCheck className="h-3 w-3" />}
              >
                {health.allowUntrustedScripts ? "Live" : "Cmds blocked"}
              </Badge>
            </span>
          </Tooltip>
        )}

        {/* Theme toggle */}
        <button
          onClick={onToggleTheme}
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          className="rounded-lg border border-white/10 bg-white/5 p-2 text-slate-300 transition-colors hover:bg-white/10 hover:text-white"
        >
          {theme === "dark" ? (
            <Sun className="h-4 w-4" />
          ) : (
            <Moon className="h-4 w-4" />
          )}
        </button>
      </div>
    </header>
  );
}
