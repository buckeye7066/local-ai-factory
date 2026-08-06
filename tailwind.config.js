/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/ui/index.html", "./src/ui/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        mono: [
          "JetBrains Mono",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "monospace",
        ],
      },
      colors: {
        // Factory Deck identity — deep space slate with electric aurora accents.
        deck: {
          bg: "#070b14",
          surface: "#0c1322",
          panel: "#111a2e",
          border: "#1e2a44",
          muted: "#64748b",
        },
        aurora: {
          cyan: "#22d3ee",
          blue: "#3b82f6",
          violet: "#8b5cf6",
          magenta: "#d946ef",
          emerald: "#34d399",
        },
      },
      boxShadow: {
        glow: "0 0 0 1px rgba(59,130,246,0.18), 0 8px 40px -8px rgba(59,130,246,0.35)",
        "glow-emerald":
          "0 0 0 1px rgba(52,211,153,0.18), 0 8px 40px -8px rgba(52,211,153,0.35)",
        "glow-amber":
          "0 0 0 1px rgba(251,191,36,0.18), 0 8px 40px -8px rgba(251,191,36,0.35)",
        "glow-rose":
          "0 0 0 1px rgba(244,63,94,0.18), 0 8px 40px -8px rgba(244,63,94,0.35)",
        panel: "0 1px 0 0 rgba(255,255,255,0.04) inset, 0 20px 50px -20px rgba(0,0,0,0.7)",
      },
      backdropBlur: {
        xs: "2px",
      },
      keyframes: {
        "aurora-drift": {
          "0%, 100%": { transform: "translate3d(0,0,0) scale(1)" },
          "50%": { transform: "translate3d(3%,-4%,0) scale(1.08)" },
        },
        "pulse-glow": {
          "0%, 100%": { opacity: "0.55", filter: "brightness(1)" },
          "50%": { opacity: "1", filter: "brightness(1.25)" },
        },
        "packet-flow": {
          "0%": { offsetDistance: "0%", opacity: "0" },
          "10%": { opacity: "1" },
          "90%": { opacity: "1" },
          "100%": { offsetDistance: "100%", opacity: "0" },
        },
        shimmer: {
          "100%": { transform: "translateX(100%)" },
        },
      },
      animation: {
        "aurora-drift": "aurora-drift 18s ease-in-out infinite",
        "pulse-glow": "pulse-glow 2.4s ease-in-out infinite",
        shimmer: "shimmer 1.6s infinite",
      },
    },
  },
  plugins: [],
};
