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
const TEST_DATA_DIRS = [
  resolve(process.cwd(), ".vitest-factory-data"),
  // paidBudgetGate.test.ts uses its own dir so its ledger assertions never
  // race another test file's paid-rescue ledger writes.
  resolve(process.cwd(), ".vitest-factory-data-paid-budget-gate"),
];

export async function setup(): Promise<void> {
  await Promise.all(TEST_DATA_DIRS.map((d) => rm(d, { recursive: true, force: true })));
}

export async function teardown(): Promise<void> {
  await Promise.all(TEST_DATA_DIRS.map((d) => rm(d, { recursive: true, force: true })));
}
