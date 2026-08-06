import type { HTMLAttributes, ReactNode } from "react";
import { motion } from "framer-motion";
import { cn } from "../../lib/cn.js";

// Omit the handlers Framer Motion redefines so `rest` spreads onto motion.div.
type NativeDivProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  "onAnimationStart" | "onDrag" | "onDragStart" | "onDragEnd" | "onDragOver"
>;

interface CardProps extends NativeDivProps {
  /** Adds a subtle lift + glow on hover. */
  interactive?: boolean;
  glow?: boolean;
}

/** Card — the glass surface primitive. */
export function Card({ className, interactive, glow, children, ...rest }: CardProps) {
  const Comp = interactive ? motion.div : "div";
  const motionProps = interactive
    ? {
        whileHover: { y: -3 },
        transition: { type: "spring" as const, stiffness: 300, damping: 24 },
      }
    : {};
  return (
    <Comp
      className={cn(
        "glass p-5",
        interactive && "cursor-pointer hover:border-white/20",
        glow && "shadow-glow",
        className,
      )}
      {...motionProps}
      {...rest}
    >
      {children}
    </Comp>
  );
}

export function CardHeader({
  title,
  subtitle,
  icon,
  action,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-start justify-between gap-3">
      <div className="flex items-start gap-3">
        {icon && (
          <div className="mt-0.5 grid h-9 w-9 place-items-center rounded-xl bg-white/5 text-aurora-cyan">
            {icon}
          </div>
        )}
        <div>
          <h3 className="text-sm font-semibold text-white">{title}</h3>
          {subtitle && <p className="mt-0.5 text-xs text-slate-400">{subtitle}</p>}
        </div>
      </div>
      {action}
    </div>
  );
}
