import { useMemo } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { usePrefersReducedMotion } from "../../lib/motion.js";

/**
 * CompletionCelebration — a subtle, dependency-free confetti burst.
 *
 * When `show` flips true we render ~40 tiny aurora-colored shards from the
 * center of the screen, each flung outward on a deterministic-ish trajectory
 * and faded out over ~1.4s. It's a one-shot: the AnimatePresence + keyed wrapper
 * means it plays through once and tidies itself up. No confetti library, no
 * canvas — just framer-motion on a handful of absolutely-positioned divs.
 *
 * Honors the OS "reduce motion" setting: when reduced we render a single,
 * static sparkle instead of a moving burst (or nothing if not shown).
 */

/** Aurora palette — kept in sync with the app's gradient vocabulary. */
const COLORS = ["#22d3ee", "#3b82f6", "#8b5cf6", "#34d399", "#fbbf24", "#f43f5e"];

const PIECE_COUNT = 40;
const BURST_MS = 1400;

interface Piece {
  /** Final horizontal offset from center, in px. */
  x: number;
  /** Final vertical offset from center, in px. */
  y: number;
  rotate: number;
  color: string;
  size: number;
  /** Tiny per-piece delay so the burst doesn't fire in lockstep. */
  delay: number;
  radius: string;
}

/**
 * Build the confetti pieces once. We spread evenly around a circle by index so
 * coverage is reliable, then add a touch of `Math.random()` jitter for organic
 * variety. (This is browser render code, not a deterministic workflow script,
 * so non-determinism here is fine and desirable.)
 */
function buildPieces(): Piece[] {
  return Array.from({ length: PIECE_COUNT }, (_, i) => {
    const angle = (i / PIECE_COUNT) * Math.PI * 2 + Math.random() * 0.4;
    const distance = 120 + Math.random() * 180; // px from center
    return {
      x: Math.cos(angle) * distance,
      y: Math.sin(angle) * distance,
      rotate: (Math.random() - 0.5) * 540,
      color: COLORS[i % COLORS.length],
      size: 6 + Math.random() * 6,
      delay: Math.random() * 0.12,
      radius: Math.random() > 0.5 ? "9999px" : "2px",
    };
  });
}

export function CompletionCelebration({ show }: { show: boolean }) {
  const prefersReducedMotion = usePrefersReducedMotion();

  // Recompute the burst whenever `show` becomes true so repeated runs replay.
  // `useMemo` keyed on `show` keeps the same pieces stable for a single burst.
  const pieces = useMemo<Piece[]>(
    () => (show && !prefersReducedMotion ? buildPieces() : []),
    [show, prefersReducedMotion],
  );

  // Reduced motion: a tiny static sparkle, nothing animated.
  if (prefersReducedMotion) {
    return (
      <AnimatePresence>
        {show && (
          <motion.div
            key="reduced-sparkle"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="pointer-events-none fixed left-1/2 top-24 z-50 -translate-x-1/2 text-2xl"
            aria-hidden="true"
          >
            ✨
          </motion.div>
        )}
      </AnimatePresence>
    );
  }

  return (
    <AnimatePresence>
      {show && (
        <div
          key="confetti-burst"
          className="pointer-events-none fixed inset-0 z-50 overflow-hidden"
          aria-hidden="true"
        >
          {/* Anchor the burst to the upper-center of the viewport. */}
          <div className="absolute left-1/2 top-1/3 h-0 w-0">
            {pieces.map((p, i) => (
              <motion.div
                key={i}
                className="absolute"
                style={{
                  width: p.size,
                  height: p.size,
                  backgroundColor: p.color,
                  borderRadius: p.radius,
                }}
                initial={{ x: 0, y: 0, opacity: 1, rotate: 0, scale: 1 }}
                animate={{
                  x: p.x,
                  y: p.y,
                  rotate: p.rotate,
                  opacity: 0,
                  scale: 0.6,
                }}
                transition={{
                  duration: BURST_MS / 1000,
                  delay: p.delay,
                  ease: [0.16, 1, 0.3, 1],
                }}
              />
            ))}
          </div>
        </div>
      )}
    </AnimatePresence>
  );
}
