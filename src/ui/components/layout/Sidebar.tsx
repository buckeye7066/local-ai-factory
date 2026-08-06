import { motion } from "framer-motion";
import {
  Factory,
  Plus,
  History,
  FolderGit2,
  Settings as SettingsIcon,
  FlaskConical,
  X,
} from "lucide-react";
import type { ComponentType } from "react";
import { cn } from "../../lib/cn.js";

export type NavKey = "new" | "history" | "workspaces" | "settings";

const NAV: {
  key: NavKey;
  label: string;
  icon: ComponentType<{ className?: string }>;
}[] = [
  { key: "new", label: "New Run", icon: Plus },
  { key: "history", label: "Runs", icon: History },
  { key: "workspaces", label: "Workspaces", icon: FolderGit2 },
  { key: "settings", label: "Settings", icon: SettingsIcon },
];

/**
 * Sidebar — brand + primary navigation + a Demo Mode shortcut. On mobile it
 * slides in as an overlay (controlled by the parent via `open`/`onClose`).
 */
export function Sidebar({
  active,
  onNavigate,
  onDemo,
  onClose,
}: {
  active: NavKey | "run";
  onNavigate: (key: NavKey) => void;
  onDemo: () => void;
  onClose?: () => void;
}) {
  return (
    <div className="flex h-full flex-col gap-6 p-4">
      {/* Brand */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="relative grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-aurora-blue to-aurora-violet shadow-glow">
            <Factory className="h-5 w-5 text-white" />
            <motion.span
              className="absolute inset-0 rounded-xl ring-1 ring-white/20"
              animate={{ opacity: [0.3, 0.7, 0.3] }}
              transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
            />
          </div>
          <div>
            <p className="text-sm font-semibold leading-tight text-white">
              Factory Deck
            </p>
            <p className="text-[10px] uppercase tracking-wider text-slate-500">
              Local AI Factory
            </p>
          </div>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            aria-label="Close menu"
            className="rounded-lg p-1.5 text-slate-400 hover:bg-white/5 hover:text-white lg:hidden"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Nav */}
      <nav className="flex flex-col gap-1" aria-label="Primary">
        {NAV.map((item) => {
          const Icon = item.icon;
          const isActive = active === item.key;
          return (
            <button
              key={item.key}
              onClick={() => onNavigate(item.key)}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors",
                isActive ? "text-white" : "text-slate-400 hover:text-white",
              )}
            >
              {isActive && (
                <motion.span
                  layoutId="nav-active"
                  className="absolute inset-0 rounded-xl border border-white/10 bg-white/[0.06] shadow-glow"
                  transition={{ type: "spring", stiffness: 380, damping: 30 }}
                />
              )}
              <Icon className="relative h-4.5 w-4.5" />
              <span className="relative">{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="mt-auto">
        {/* Demo Mode CTA */}
        <button
          onClick={onDemo}
          className="group flex w-full items-center gap-3 rounded-xl border border-aurora-violet/25 bg-aurora-violet/[0.08] px-3 py-2.5 text-sm font-medium text-violet-200 transition-colors hover:bg-aurora-violet/15"
        >
          <FlaskConical className="h-4.5 w-4.5" />
          Demo Mode
          <span className="ml-auto text-[10px] text-violet-300/70 group-hover:text-violet-200">
            no keys
          </span>
        </button>
        <p className="mt-3 px-1 text-[10px] leading-relaxed text-slate-600">
          Runs locally. Keys stay in <code className="text-slate-500">.env</code>, never
          in the browser.
        </p>
      </div>
    </div>
  );
}
