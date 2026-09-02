import { describe, expect, it } from "vitest";
import { isForbiddenRepairPath } from "../orchestrator/repairScope.js";

describe("product repair scope", () => {
  it("keeps product source writable", () => {
    expect(isForbiddenRepairPath("src/commands.ts")).toBe(false);
    expect(isForbiddenRepairPath("server/routes/tasks.py")).toBe(false);
  });

  it.each([
    "tests/tasktick.test.ts",
    "src/__tests__/taskStore.spec.ts",
    "test_tasks.py",
    "pkg/store_test.py",
    "package.json",
    "pnpm-lock.yaml",
    "requirements.txt",
    "vitest.config.ts",
    "nested/playwright.e2e.config.mts",
    "tsconfig.build.json",
    "eslint.config.mjs",
  ])("keeps %s immutable", (path) => {
    expect(isForbiddenRepairPath(path)).toBe(true);
  });

  it("normalizes Windows separators before classification", () => {
    expect(isForbiddenRepairPath("src\\__tests__\\task.test.ts")).toBe(true);
  });
});
