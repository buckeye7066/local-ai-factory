import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/server/**/*.test.ts"],
    // Isolate the run-history store so end-to-end (stub) run tests never write
    // into the user's real .factory/ history. runsStore reads FACTORY_DATA_DIR
    // at import time; vitest applies `env` before test modules load. The global
    // setup file removes this throwaway dir before and after the suite.
    env: { FACTORY_DATA_DIR: ".vitest-factory-data" },
    globalSetup: ["./vitest.globalSetup.ts"],
  },
});
