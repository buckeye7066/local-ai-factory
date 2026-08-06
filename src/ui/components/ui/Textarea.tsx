import { forwardRef } from "react";
import type { TextareaHTMLAttributes } from "react";
import { cn } from "../../lib/cn.js";

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...rest }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      "w-full resize-none rounded-2xl border border-white/10 bg-white/5 p-4 text-sm leading-relaxed text-white",
      "placeholder:text-slate-500 transition-colors",
      "focus:border-aurora-cyan/50 focus:bg-white/[0.07] focus-visible:outline-none",
      className,
    )}
    {...rest}
  />
));
Textarea.displayName = "Textarea";
