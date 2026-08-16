import { useState } from "react";
import type { ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AuroraBackground } from "./AuroraBackground.js";
import { PlantBackground } from "../foundry/PlantBackground.js";
import { Sidebar, type NavKey } from "./Sidebar.js";
import { TopBar } from "./TopBar.js";
import { cn } from "../../lib/cn.js";
import type { Health } from "../../../shared/schemas.js";
import type { Theme } from "../../lib/useTheme.js";

/**
 * AppShell — full-screen responsive layout: fixed glass sidebar (overlay on
 * mobile), sticky top bar, and a main content area. Children are keyed by the
 * parent so page changes animate via AnimatePresence.
 *
 * `variant` swaps the ambient identity. Factory Deck keeps the aurora backdrop
 * and glass chrome; Purpose Foundry gets the Lorain Assembly plant floor —
 * sodium high bays over concrete, with the chrome dropped to bare steel.
 */
export function AppShell({
  active,
  onNavigate,
  health,
  theme,
  onToggleTheme,
  variant = "deck",
  children,
}: {
  active: NavKey | "run";
  onNavigate: (key: NavKey) => void;
  health: Health | null;
  theme: Theme;
  onToggleTheme: () => void;
  variant?: "deck" | "foundry";
  children: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const foundry = variant === "foundry";

  const nav = (key: NavKey) => {
    onNavigate(key);
    setMenuOpen(false);
  };

  return (
    <div className="relative min-h-screen text-slate-100">
      {foundry ? <PlantBackground /> : <AuroraBackground />}

      <div className="flex min-h-screen">
        {/* Desktop sidebar */}
        <aside
          className={cn(
            "sticky top-0 hidden h-screen w-64 shrink-0 border-r lg:block",
            foundry
              ? "border-plant-edge/70 bg-plant-slab/80 backdrop-blur-sm"
              : "border-white/[0.06] bg-white/[0.02] backdrop-blur-xl",
          )}
        >
          <Sidebar active={active} onNavigate={onNavigate} />
        </aside>

        {/* Mobile sidebar overlay */}
        <AnimatePresence>
          {menuOpen && (
            <>
              <motion.div
                className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setMenuOpen(false)}
              />
              <motion.aside
                className={cn(
                  "fixed inset-y-0 left-0 z-50 w-72 border-r lg:hidden",
                  foundry
                    ? "border-plant-edge bg-plant-slab/95 backdrop-blur-sm"
                    : "border-white/10 bg-deck-surface/95 backdrop-blur-2xl",
                )}
                initial={{ x: "-100%" }}
                animate={{ x: 0 }}
                exit={{ x: "-100%" }}
                transition={{ type: "spring", stiffness: 320, damping: 34 }}
              >
                <Sidebar
                  active={active}
                  onNavigate={nav}
                  onClose={() => setMenuOpen(false)}
                />
              </motion.aside>
            </>
          )}
        </AnimatePresence>

        {/* Main column */}
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar
            health={health}
            theme={theme}
            onToggleTheme={onToggleTheme}
            onOpenMenu={() => setMenuOpen(true)}
          />
          <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
            <div className="mx-auto max-w-6xl">{children}</div>
          </main>
        </div>
      </div>
    </div>
  );
}
