import type { ReactNode } from "react";
import { cn } from "../../lib/cn.js";

type Tone = "neutral" | "cyan" | "blue" | "violet" | "emerald" | "amber" | "rose";

const tones: Record<Tone, string> = {
  neutral: "bg-white/5 text-slate-300 border-white/10",
  cyan: "bg-aurora-cyan/10 text-aurora-cyan border-aurora-cyan/25",
  blue: "bg-aurora-blue/10 text-aurora-blue border-aurora-blue/25",
  violet: "bg-aurora-violet/10 text-aurora-violet border-aurora-violet/25",
  emerald: "bg-aurora-emerald/10 text-aurora-emerald border-aurora-emerald/25",
  amber: "bg-amber-400/10 text-amber-300 border-amber-400/25",
  rose: "bg-rose-500/10 text-rose-300 border-rose-500/25",
};

export function Badge({
  children,
  tone = "neutral",
  className,
  icon,
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
  icon?: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        tones[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}
