import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn.js";

/**
 * plant.tsx — the Purpose Foundry material vocabulary, drawn from Ford Lorain
 * Assembly: stamped steel panels on rivets, stenciled bay numbers, andon lamp
 * stacks, safety chevrons, and the overhead power-and-free conveyor.
 *
 * These are foundry-mode primitives. Factory Deck keeps ui/Card.tsx and the
 * glass surfaces — nothing here is imported outside components/foundry.
 */

/* ------------------------------------------------------------------ */
/* Steel                                                               */
/* ------------------------------------------------------------------ */

/** Four corner rivets. Purely material — hidden from assistive tech. */
export function Rivets({ inset = "0.5rem" }: { inset?: string }) {
  const dot =
    "absolute h-1.5 w-1.5 rounded-full bg-plant-edge shadow-[inset_0_1px_0_rgba(255,255,255,0.35),0_1px_1px_rgba(0,0,0,0.6)]";
  return (
    <span aria-hidden>
      <span className={dot} style={{ top: inset, left: inset }} />
      <span className={dot} style={{ top: inset, right: inset }} />
      <span className={dot} style={{ bottom: inset, left: inset }} />
      <span className={dot} style={{ bottom: inset, right: inset }} />
    </span>
  );
}

/** SteelPanel — the foundry surface primitive. Sheet metal, not glass. */
export function SteelPanel({
  className,
  rivets,
  children,
}: {
  className?: string;
  rivets?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "plant-steel relative rounded-sm border border-plant-edge/70",
        className,
      )}
    >
      {rivets && <Rivets />}
      {children}
    </div>
  );
}

/** Stenciled plant lettering — department names, bay labels, sign copy. */
export function Stencil({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <span className={cn("plant-stencil", className)}>{children}</span>;
}

/** Safety chevrons. Signage, not decoration — used only on the sign base and
 *  the receiving dock edge. */
export function HazardBar({ className }: { className?: string }) {
  return <div aria-hidden className={cn("plant-hazard h-1.5 w-full", className)} />;
}

/* ------------------------------------------------------------------ */
/* Andon                                                               */
/* ------------------------------------------------------------------ */

export type AndonStatus =
  | "not_selected"
  | "queued"
  | "active"
  | "needs_attention"
  | "completed"
  | "failed";

/** How the plant reads each station state: which lamp is lit, and the words
 *  written on the board. Line workers get a verb, not a status enum. */
export const ANDON: Record<
  AndonStatus,
  { lamp: "red" | "amber" | "green" | null; pulse: boolean; label: string }
> = {
  not_selected: { lamp: null, pulse: false, label: "Off this build" },
  queued: { lamp: null, pulse: false, label: "Staged" },
  active: { lamp: "green", pulse: true, label: "Running" },
  needs_attention: { lamp: "amber", pulse: true, label: "Line call" },
  completed: { lamp: "green", pulse: false, label: "Passed" },
  failed: { lamp: "red", pulse: true, label: "Line down" },
};

const LAMP_ON: Record<"red" | "amber" | "green", string> = {
  red: "bg-plant-stop shadow-[0_0_12px_2px_rgba(217,58,43,0.55)]",
  amber: "bg-plant-safety shadow-[0_0_12px_2px_rgba(242,195,0,0.5)]",
  green: "bg-plant-go shadow-[0_0_12px_2px_rgba(47,191,91,0.5)]",
};

/**
 * AndonStack — the three-lamp tower over every station. Red over amber over
 * green, exactly one lit, mounted on a steel bracket. This is the primary
 * status carrier on the floor; the text underneath only names what the lamp
 * already said.
 */
export function AndonStack({
  status,
  size = "sm",
  className,
}: {
  status: AndonStatus;
  /** `lg` is the master tower on the plant's andon board. */
  size?: "sm" | "lg";
  className?: string;
}) {
  const { lamp, pulse, label } = ANDON[status];
  const order: Array<"red" | "amber" | "green"> = ["red", "amber", "green"];
  return (
    <div
      className={cn(
        "flex flex-col items-center rounded-[3px] border border-plant-edge/80 bg-plant-night/80",
        size === "lg" ? "gap-1.5 p-1.5" : "gap-[3px] p-[3px]",
        className,
      )}
      role="img"
      aria-label={`Andon: ${label}`}
    >
      {order.map((color) => {
        const lit = lamp === color;
        return (
          <span
            key={color}
            className={cn(
              "rounded-full transition-colors",
              size === "lg" ? "h-3.5 w-3.5" : "h-2 w-2",
              lit ? LAMP_ON[color] : "bg-white/[0.07]",
              lit && pulse && "animate-andon",
            )}
          />
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Overhead conveyor                                                   */
/* ------------------------------------------------------------------ */

/**
 * ConveyorRail — the power-and-free line running over the bays. Carriers
 * travel the rail whenever work is moving; when the line is idle they stop,
 * because a plant with nothing on the line has an empty rail.
 */
export function ConveyorRail({ moving }: { moving: boolean }) {
  return (
    <div
      aria-hidden
      className="pointer-events-none relative h-8 w-full overflow-hidden"
    >
      {/* Hanger drops from the roof steel */}
      <div
        className="absolute inset-x-0 top-0 h-3"
        style={{
          backgroundImage:
            "repeating-linear-gradient(90deg, rgba(138,147,155,0.55) 0 2px, transparent 2px 88px)",
        }}
      />
      {/* The rail itself */}
      <div className="absolute inset-x-0 top-3 h-[3px] bg-gradient-to-b from-plant-paint/70 via-plant-edge to-black/80" />

      {/* One full-width wrapper per carrier. The transform MUST live on the
          full-width element: translateX percentages resolve against the
          transformed element's own width, so animating the 28px carrier
          directly would move it 28px, not across the rail. */}
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className={cn("absolute inset-x-0 top-1", moving && "animate-carrier")}
          style={
            moving
              ? { animationDelay: `${i * -5.33}s` }
              : { transform: `translateX(${16 + i * 27}%)` }
          }
        >
          <div className="absolute left-0 w-7">
            {/* trolley on the rail */}
            <div className="mx-auto h-1.5 w-5 rounded-[1px] bg-plant-paint/80" />
            {/* drop hook */}
            <div className="mx-auto h-2 w-[2px] bg-plant-paint/50" />
            {/* the unit in process */}
            <div className="mx-auto h-3 w-6 rounded-[1px] border border-plant-edge bg-plant-steel shadow-[0_2px_6px_rgba(0,0,0,0.6)]" />
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Controls                                                            */
/* ------------------------------------------------------------------ */

/**
 * PlantButton — a machine control, not a web button. Ford blue enamel for the
 * one action that moves metal ("line"), bare steel for everything else.
 *
 * Deliberately separate from ui/Button.tsx: that component hardcodes the
 * aurora blue→violet gradient in its variant map, and `cn()` here is a plain
 * join (no tailwind-merge), so appending classes would not reliably override
 * it. A distinct control is honest and keeps Factory Deck's button untouched.
 */
export function PlantButton({
  variant = "steel",
  size = "md",
  icon,
  loading,
  disabled,
  className,
  children,
  ...rest
}: {
  variant?: "line" | "steel";
  size?: "sm" | "md";
  icon?: ReactNode;
  loading?: boolean;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cn(
        "inline-flex select-none items-center justify-center gap-2 rounded-[3px] border font-semibold uppercase tracking-[0.14em] transition",
        "focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40",
        size === "sm" ? "h-8 px-3 text-[10px]" : "h-11 px-5 text-[11px]",
        variant === "line"
          ? "border-plant-arc/70 bg-plant-ford text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_2px_0_rgba(0,0,0,0.55)] hover:bg-plant-arc active:translate-y-px"
          : "border-plant-edge bg-plant-steel text-plant-paint shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_2px_0_rgba(0,0,0,0.5)] hover:border-plant-paint/50 hover:text-white active:translate-y-px",
        className,
      )}
    >
      {loading ? (
        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-transparent border-t-current" />
      ) : (
        icon
      )}
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Signage                                                             */
/* ------------------------------------------------------------------ */

/** Bay number — sprayed on the column at every station. */
export function BayNumber({ n }: { n: number }) {
  return (
    <span className="font-mono text-[11px] font-bold tabular-nums tracking-[0.2em] text-plant-safety/80">
      BAY {String(n).padStart(2, "0")}
    </span>
  );
}

/**
 * BoardReadout — one figure on the plant's andon board. Big tabular digits,
 * stenciled caption, hairline rule. The board reports the floor, so the
 * numbers lead and the words follow.
 */
export function BoardReadout({
  value,
  caption,
  tone = "steel",
}: {
  value: ReactNode;
  caption: string;
  tone?: "steel" | "go" | "amber" | "stop";
}) {
  const toneClass = {
    steel: "text-plant-paint",
    go: "text-plant-go",
    amber: "text-plant-safety",
    stop: "text-plant-stop",
  }[tone];
  return (
    <div className="min-w-0">
      <p
        className={cn(
          "font-mono text-2xl font-bold leading-none tabular-nums",
          toneClass,
        )}
      >
        {value}
      </p>
      <Stencil className="mt-1.5 block truncate text-[9px] text-plant-paint/55">
        {caption}
      </Stencil>
    </div>
  );
}
