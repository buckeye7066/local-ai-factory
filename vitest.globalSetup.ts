import { rm } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Global test isolation for the run-history store.
 *
 * `runsStore.ts` resolves its data root from FACTORY_DATA_DIR at import time and
 * writes run records to disk. Several tests drive a full (stub) run, so without
 * isolation `pnpm test` would pollute the user's real `.factory/` history. We
 * point every test worker at a throwaway dir (set in vitest.config.ts `env`)
 * and delete it before and after the suite.
 */
const TEST_DATA_DIR = resolve(process.cwd(), ".vitest-factory-data");

export async function setup(): Promise<void> {
  await rm(TEST_DATA_DIR, { recursive: true, force: true });
}

export async function teardown(): Promise<void> {
  await rm(TEST_DATA_DIR, { recursive: true, force: true });
}
