import { cn } from "../../lib/cn.js";

/** Skeleton — shimmering placeholder for loading states. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "skeleton-shimmer relative overflow-hidden rounded-lg bg-white/[0.05]",
        className,
      )}
    />
  );
}

export function SkeletonStack({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className={cn("h-4", i % 2 ? "w-2/3" : "w-full")} />
      ))}
    </div>
  );
}
