import { usePrefersReducedMotion } from "../../lib/motion.js";

/**
 * AuroraBackground — the signature ambient backdrop: faint grid + three
 * soft, slowly drifting radial glows. Pure CSS (opacity/transform only) so it
 * stays cheap on laptops; motion is disabled under prefers-reduced-motion.
 */
export function AuroraBackground() {
  const reduced = usePrefersReducedMotion();
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
    >
      {/* Base wash */}
      <div className="absolute inset-0 bg-gradient-to-b from-deck-bg via-deck-bg to-[#05080f]" />
      {/* Faint grid */}
      <div className="absolute inset-0 bg-grid opacity-[0.5] mask-fade-b" />
      {/* Aurora glows */}
      <div
        className="aurora-blob h-[42rem] w-[42rem] -left-40 -top-40 bg-aurora-blue/30"
        style={reduced ? { animation: "none" } : undefined}
      />
      <div
        className="aurora-blob h-[36rem] w-[36rem] right-[-10rem] top-10 bg-aurora-violet/25"
        style={
          reduced
            ? { animation: "none", animationDelay: "0s" }
            : { animationDelay: "-6s" }
        }
      />
      <div
        className="aurora-blob h-[30rem] w-[30rem] bottom-[-8rem] left-1/3 bg-aurora-cyan/20"
        style={reduced ? { animation: "none" } : { animationDelay: "-12s" }}
      />
      {/* Vignette */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_55%,rgba(0,0,0,0.55)_100%)]" />
    </div>
  );
}
