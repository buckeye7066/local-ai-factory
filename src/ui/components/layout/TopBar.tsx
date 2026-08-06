import { Menu, Sun, Moon, KeyRound, ShieldCheck, Wifi, WifiOff } from "lucide-react";
import { Badge } from "../ui/Badge.js";
import { Tooltip } from "../ui/Tooltip.js";
import { cn } from "../../lib/cn.js";
import type { Health } from "../../../shared/schemas.js";
import type { Theme } from "../../lib/useTheme.js";

/**
 * TopBar — provider/key status, dry-run badge, theme toggle, and the mobile
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

        {/* Dry-run mode badge */}
        {health && (
          <Tooltip
            content={
              health.dryRunCommands
                ? "Commands previewed, not executed"
                : "Allowlisted commands will execute"
            }
          >
            <span>
              <Badge
                tone={health.dryRunCommands ? "cyan" : "rose"}
                icon={<ShieldCheck className="h-3 w-3" />}
              >
                {health.dryRunCommands ? "Dry run" : "Live"}
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
