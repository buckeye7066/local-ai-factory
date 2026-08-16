import { usePrefersReducedMotion } from "../../lib/motion.js";

/**
 * PlantBackground — the Purpose Foundry backdrop: Ford Lorain Assembly on
 * third shift. Cold concrete slab, painted aisle lines, a steel roof truss
 * overhead, and four sodium-vapor high bays throwing amber pools down the
 * length of the line.
 *
 * This REPLACES AuroraBackground in foundry mode only. Factory Deck keeps its
 * aurora backdrop — the two products stay visually distinct on purpose.
 *
 * Pure CSS/SVG, opacity-only motion, disabled under prefers-reduced-motion.
 */
export function PlantBackground() {
  const reduced = usePrefersReducedMotion();
  const still = reduced ? { animation: "none" } : undefined;

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
    >
      {/* Slab — warm at the roofline where the lamps hang, cold on the floor */}
      <div className="absolute inset-0 bg-gradient-to-b from-[#15110a] via-[#0b0d11] to-[#07090c]" />
      <div className="plant-concrete absolute inset-0" />

      {/* Painted aisle lines, fading out toward the back of the bay */}
      <div className="plant-aisle mask-fade-b absolute inset-0" />

      {/* Roof truss overhead — steel silhouette, heaviest at the ceiling line */}
      <svg
        className="absolute inset-x-0 top-0 h-44 w-full text-plant-paint opacity-[0.22]"
        preserveAspectRatio="none"
        viewBox="0 0 1200 160"
      >
        <defs>
          <pattern id="truss" width="120" height="64" patternUnits="userSpaceOnUse">
            <path
              d="M0 6 H120 M0 58 H120 M0 6 L60 58 L120 6"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
            />
          </pattern>
          <linearGradient id="trussFade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="white" stopOpacity="1" />
            <stop offset="100%" stopColor="white" stopOpacity="0" />
          </linearGradient>
          <mask id="trussMask">
            <rect width="1200" height="160" fill="url(#trussFade)" />
          </mask>
        </defs>
        <rect width="1200" height="64" fill="url(#truss)" mask="url(#trussMask)" />
        {/* Column tops carrying the truss down into the frame */}
        <g stroke="currentColor" strokeWidth="5" mask="url(#trussMask)">
          <path d="M150 6 V160 M450 6 V160 M750 6 V160 M1050 6 V160" />
        </g>
      </svg>

      {/* Sodium-vapor high bays. Warm, wide, and strong enough to actually
          light the floor — the lighting IS the identity here, so it is the
          loudest thing in this layer. */}
      <div
        className="absolute -top-32 left-[4%] h-[42rem] w-[42rem] animate-high-bay rounded-full bg-plant-sodium/[0.16] blur-[130px]"
        style={still}
      />
      <div
        className="absolute -top-24 left-[36%] h-[38rem] w-[38rem] animate-high-bay rounded-full bg-plant-sodium/[0.13] blur-[130px]"
        style={reduced ? still : { animationDelay: "-3s" }}
      />
      <div
        className="absolute -top-28 right-[2%] h-[40rem] w-[40rem] animate-high-bay rounded-full bg-plant-sodium/[0.15] blur-[130px]"
        style={reduced ? still : { animationDelay: "-6s" }}
      />
      {/* Second row, deeper into the plant — keeps the floor lit below the fold */}
      <div
        className="absolute top-[52%] left-[14%] h-[36rem] w-[36rem] animate-high-bay rounded-full bg-plant-sodium/[0.10] blur-[140px]"
        style={reduced ? still : { animationDelay: "-8s" }}
      />
      {/* One cold mercury lamp at the far end, for the color break */}
      <div
        className="absolute bottom-[-12rem] right-[18%] h-[32rem] w-[32rem] animate-high-bay rounded-full bg-plant-arc/[0.16] blur-[140px]"
        style={reduced ? still : { animationDelay: "-4.5s" }}
      />

      {/* Vignette — the plant is bigger than the lit part of it */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_20%,transparent_45%,rgba(0,0,0,0.6)_100%)]" />
    </div>
  );
}
