import { describe, expect, it } from "vitest";
import { assessGeneratedTests } from "../orchestrator/acceptanceGate.js";
import type {
  FileBuild,
  ProductSpec,
  TestPlan,
} from "../../shared/schemas.js";

const spec: ProductSpec = {
  appName: "GrantFlow",
  tagline: "",
  targetUser: "grant seeker",
  coreFeatures: ["Organization profile"],
  dataModel: [],
  userFlows: ["Fill the organization form, save it, reload, and edit it"],
  acceptanceCriteria: [
    "Saved profile persists after reload",
    "Optional fields may remain blank",
  ],
};

const uiBuild: FileBuild = {
  files: [
    {
      path: "src/App.tsx",
      purpose: "profile UI",
      contents: "export default function App(){ return <Profile />; }",
      edits: [],
    },
  ],
};

function plan(contents: string, path = "tests/profile.spec.ts"): TestPlan {
  return {
    testPlan: "Exercise the saved profile journey.",
    files: [{ path, purpose: "acceptance", contents }],
  };
}

describe("assessGeneratedTests", () => {
  it("rejects vacuous, skipped, and assertion-free tests", () => {
    for (const source of [
      "test('reload',()=>{})",
      "test.skip('reload',()=>{ expect(true).toBe(true); })",
      "test('reload',()=>{ doSomething(); })",
    ]) {
      const result = assessGeneratedTests(spec, uiBuild, plan(source));
      expect(result.ok, source).toBe(false);
    }
  });

  it("requires a browser journey for interactive UI acceptance", () => {
    const unitOnly = plan(
      "import { test, expect } from 'vitest'; test('reload',()=>{ expect(true).toBe(true); });",
      "src/App.test.tsx",
    );
    const result = assessGeneratedTests(spec, uiBuild, unitOnly);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/Playwright browser test/i);
  });

  it("requires navigation, interaction, assertion, and reload for persistence", () => {
    const missingReload = plan(
      [
        "import { test, expect } from '@playwright/test';",
        "test('profile persists', async ({ page }) => {",
        "  await page.goto('/');",
        "  await page.getByLabel('Name').fill('Acme');",
        "  await expect(page.getByText('Acme')).toBeVisible();",
        "});",
      ].join("\n"),
    );
    const result = assessGeneratedTests(spec, uiBuild, missingReload);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/page\.reload/);
  });

  it("accepts a shaped Playwright save/reload journey", () => {
    const valid = plan(
      [
        "import { test, expect } from '@playwright/test';",
        "test('profile persists after reload', async ({ page }) => {",
        "  await page.goto('/');",
        "  await page.getByLabel('Name').fill('Acme');",
        "  await page.getByRole('button', { name: 'Save' }).click();",
        "  await page.reload();",
        "  await expect(page.getByDisplayValue('Acme')).toBeVisible();",
        "});",
      ].join("\n"),
    );
    expect(assessGeneratedTests(spec, uiBuild, valid)).toMatchObject({
      ok: true,
      uiAcceptanceRequired: true,
      browserTestPaths: ["tests/profile.spec.ts"],
    });
  });
});
