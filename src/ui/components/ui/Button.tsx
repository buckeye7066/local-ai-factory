import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { motion } from "framer-motion";
import { cn } from "../../lib/cn.js";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "subtle";
type Size = "sm" | "md" | "lg";

// Omit the handful of handlers Framer Motion redefines with its own signatures.
type NativeButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "onAnimationStart" | "onDrag" | "onDragStart" | "onDragEnd" | "onDragOver"
>;

interface ButtonProps extends NativeButtonProps {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  loading?: boolean;
}

const variants: Record<Variant, string> = {
  primary:
    "text-white bg-gradient-to-r from-aurora-blue to-aurora-violet shadow-glow hover:shadow-[0_8px_50px_-6px_rgba(99,102,241,0.6)] hover:brightness-110",
  secondary: "text-deck-bg bg-aurora-cyan/90 hover:bg-aurora-cyan shadow-glow",
  ghost: "text-slate-200 bg-white/5 hover:bg-white/10 border border-white/10",
  subtle: "text-slate-300 hover:text-white hover:bg-white/5",
  danger:
    "text-white bg-gradient-to-r from-rose-500 to-red-600 shadow-glow-rose hover:brightness-110",
};

const sizes: Record<Size, string> = {
  sm: "h-8 px-3 text-xs gap-1.5 rounded-lg",
  md: "h-10 px-4 text-sm gap-2 rounded-xl",
  lg: "h-12 px-6 text-base gap-2.5 rounded-xl",
};

/**
 * Button — press/tap spring + hover glow. Wraps a motion.button so every CTA
 * has the same delightful micro-interaction. `loading` shows a spinner and
 * disables interaction.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant = "primary",
      size = "md",
      icon,
      loading,
      children,
      disabled,
      ...rest
    },
    ref,
  ) => {
    return (
      <motion.button
        ref={ref}
        whileTap={{ scale: 0.97 }}
        whileHover={{ y: -1 }}
        transition={{ type: "spring", stiffness: 400, damping: 26 }}
        className={cn(
          "inline-flex select-none items-center justify-center font-medium transition-colors",
          "focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
          sizes[size],
          variants[variant],
          className,
        )}
        disabled={disabled || loading}
        {...rest}
      >
        {loading ? (
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
        ) : (
          icon
        )}
        {children}
      </motion.button>
    );
  },
);
Button.displayName = "Button";
