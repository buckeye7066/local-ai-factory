import { forwardRef } from "react";
import type { InputHTMLAttributes } from "react";
import { cn } from "../../lib/cn.js";

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(({ className, ...rest }, ref) => (
  <input
    ref={ref}
    className={cn(
      "h-10 w-full rounded-xl border border-white/10 bg-white/5 px-3.5 text-sm text-white",
      "placeholder:text-slate-500 transition-colors",
      "focus:border-aurora-cyan/50 focus:bg-white/[0.07] focus-visible:outline-none",
      className,
    )}
    {...rest}
  />
));
Input.displayName = "Input";
