import { useEffect, useState } from "react";
import type { Variants } from "framer-motion";

/**
 * lib/motion.ts — the reusable animation system.
 *
 * All variants are tasteful (short, eased, no bouncing). Components should
 * gate non-essential motion behind `usePrefersReducedMotion()` so the app
 * honors the OS "reduce motion" setting.
 */

const ease = [0.22, 1, 0.36, 1] as [number, number, number, number];

export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.35, ease } },
};

export const slideUp: Variants = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease } },
};

export const scaleIn: Variants = {
  hidden: { opacity: 0, scale: 0.96 },
  show: { opacity: 1, scale: 1, transition: { duration: 0.32, ease } },
};

export const staggerContainer: Variants = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.06, delayChildren: 0.04 },
  },
};

export const staggerItem: Variants = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: { duration: 0.34, ease } },
};

export const pulseGlow: Variants = {
  rest: { opacity: 0.6 },
  active: {
    opacity: [0.55, 1, 0.55],
    transition: { duration: 2.2, repeat: Infinity, ease: "easeInOut" },
  },
};

export const routeTransition: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease } },
  exit: { opacity: 0, y: -8, transition: { duration: 0.2, ease } },
};

export const listItemEnter: Variants = {
  hidden: { opacity: 0, x: -8 },
  show: { opacity: 1, x: 0, transition: { duration: 0.28, ease } },
};

/** Subscribe to the OS "reduce motion" preference. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return reduced;
}
