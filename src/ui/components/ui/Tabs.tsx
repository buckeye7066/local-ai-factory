import type { ReactNode } from "react";
import { motion } from "framer-motion";
import { cn } from "../../lib/cn.js";

export interface TabItem {
  id: string;
  label: string;
  icon?: ReactNode;
  badge?: ReactNode;
}

/**
 * Tabs — segmented control with a shared layout-animated active pill
 * (Framer's `layoutId` slides the highlight smoothly between tabs).
 */
export function Tabs({
  items,
  active,
  onChange,
  className,
}: {
  items: TabItem[];
  active: string;
  onChange: (id: string) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={cn(
        "inline-flex items-center gap-1 rounded-xl border border-white/10 bg-white/[0.03] p-1",
        className,
      )}
    >
      {items.map((item) => {
        const isActive = item.id === active;
        return (
          <button
            key={item.id}
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(item.id)}
            className={cn(
              "relative inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
              isActive ? "text-white" : "text-slate-400 hover:text-slate-200",
            )}
          >
            {isActive && (
              <motion.span
                layoutId="tab-active-pill"
                className="absolute inset-0 rounded-lg bg-white/10 shadow-glow"
                transition={{ type: "spring", stiffness: 380, damping: 30 }}
              />
            )}
            <span className="relative flex items-center gap-1.5">
              {item.icon}
              {item.label}
              {item.badge}
            </span>
          </button>
        );
      })}
    </div>
  );
}
