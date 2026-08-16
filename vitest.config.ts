import { defineConfig } from "vitest/config";

export default defineConfig({
  // UI tests are .tsx. vitest.config.ts does not inherit vite.config.ts's
  // react plugin, so the automatic JSX runtime is enabled here explicitly
  // (matching "jsx": "react-jsx" in tsconfig.ui.json).
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["src/server/**/*.test.ts", "src/ui/**/*.test.tsx"],
    // UI tests need a DOM; they opt in per-file with a
    // `@vitest-environment happy-dom` docblock, so server tests keep the
    // faster node environment and no deprecated config option is needed.
    //
    // happy-dom, NOT jsdom: jsdom@30 pulls undici@8, which calls
    // `webidl.util.markAsUncloneable` - absent on Node 20, the version CI
    // runs and the floor this package declares in `engines`. That combination
    // made the UI test FILE fail to load in CI (66/67 files ran) while
    // passing on a Node 24 dev machine. happy-dom has no undici dependency.
    // Isolate the run-history store so end-to-end (stub) run tests never write
    // into the user's real .factory/ history. runsStore reads FACTORY_DATA_DIR
    // at import time; vitest applies `env` before test modules load. The global
    // setup file removes this throwaway dir before and after the suite.
    // Research does real, keyless internet calls (DuckDuckGo Lite search +
    // arbitrary fetch) when enabled — off by default for the suite so
    // `npm test` never depends on real network access; dedicated research
    // tests stub `fetch` instead of relying on this flag.
    env: { FACTORY_DATA_DIR: ".vitest-factory-data", FACTORY_RESEARCH_ENABLED: "0" },
    globalSetup: ["./vitest.globalSetup.ts"],
    // Load-proof timeouts. The end-to-end suites drive real git and real file
    // I/O; on a machine that is also running a live factory build they blew
    // the 5s default and "failed" in different files every run while passing
    // in isolation (2026-08-16). Timing headroom is the honest fix - a longer
    // ceiling never hides a real failure, it only stops load from inventing
    // one. (Forks-per-file was tried first and made it worse: more processes,
    // more contention.)
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
