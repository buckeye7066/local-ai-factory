import { describe, expect, it } from "vitest";
import {
  assessGeneratedTests,
  assessExecutedCoverage,
} from "../orchestrator/acceptanceGate.js";
import type {
  FileBuild,
  ProductSpec,
  TestCoverage,
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

function coverage(
  path: string,
  testName: string,
  kind: TestCoverage["kind"] = "browser",
): TestCoverage[] {
  return ["UF-1", "AC-1", "AC-2"].map((requirementId) => ({
    requirementId,
    testPath: path,
    testName,
    kind,
  }));
}

function plan(
  contents: string,
  path = "tests/profile.spec.ts",
  testName = "profile persists after reload",
  items: TestCoverage[] = coverage(path, testName),
): TestPlan {
  return {
    testPlan: "Exercise the saved profile journey.",
    coverage: items,
    files: [{ path, purpose: "acceptance", contents }],
  };
}

const validJourney = [
  "import { test, expect } from '@playwright/test';",
  "test('profile persists after reload', async ({ page }) => {",
  "  await page.goto('/');",
  "  await page.getByLabel('Name').fill('Acme');",
  "  await page.getByRole('button', { name: 'Save' }).click();",
  "  await page.reload();",
  "  await expect(page.getByDisplayValue('Acme')).toBeVisible();",
  "});",
].join("\n");

describe("assessGeneratedTests", () => {
  it("rejects vacuous, skipped, and assertion-free tests", () => {
    for (const source of [
      "test('reload',()=>{})",
      "test.skip('reload',()=>{ expect(value).toBe(true); })",
      "test('reload',()=>{ doSomething(); })",
      "test('reload',()=>{ expect(true).toBe(true); })",
    ]) {
      const result = assessGeneratedTests(
        spec,
        uiBuild,
        plan(source, "tests/profile.spec.ts", "reload",
          coverage("tests/profile.spec.ts", "reload")),
      );
      expect(result.ok, source).toBe(false);
    }
  });

  it("ignores comments, dead false branches, and code after an unconditional return", () => {
    const fake = [
      "import { test, expect } from '@playwright/test';",
      "test('profile persists after reload', async ({ page }) => {",
      "  return;",
      "  // page.goto('/'); page.click('button'); page.reload();",
      "  if (false) await expect(page.getByText('Acme')).toBeVisible();",
      "});",
    ].join("\n");
    const result = assessGeneratedTests(spec, uiBuild, plan(fake));
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/assertion|navigate/i);
  });

  it("requires a browser journey for interactive UI acceptance", () => {
    const path = "src/App.test.tsx";
    const unitOnly = plan(
      "import { test, expect } from 'vitest'; test('reload',()=>{ expect(profile.name).toBe('Acme'); });",
      path,
      "reload",
      coverage(path, "reload", "unit"),
    );
    const result = assessGeneratedTests(spec, uiBuild, unitOnly);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/browser coverage|Playwright/i);
  });

  it("requires navigation, interaction, assertion, and reload for persistence", () => {
    const missingReload = plan(
      [
        "import { test, expect } from '@playwright/test';",
        "test('profile persists after reload', async ({ page }) => {",
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

  it("rejects missing, unknown, and mismatched machine-readable coverage", () => {
    expect(
      assessGeneratedTests(spec, uiBuild, { ...plan(validJourney), coverage: [] }).ok,
    ).toBe(false);
    const bad = plan(validJourney, undefined, undefined, [
      {
        requirementId: "AC-99",
        testPath: "tests/profile.spec.ts",
        testName: "not a real test",
        kind: "browser",
      },
    ]);
    const result = assessGeneratedTests(spec, uiBuild, bad);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/unknown coverage|no mapped test/i);
  });

  it("accepts a mapped Playwright save/reload journey", () => {
    expect(assessGeneratedTests(spec, uiBuild, plan(validJourney))).toMatchObject({
      ok: true,
      uiAcceptanceRequired: true,
      browserTestPaths: ["tests/profile.spec.ts"],
    });
  });

  it("requires the exact mapped title to appear in valid direct runner evidence", () => {
    const testPlan = plan(validJourney);
    expect(
      assessExecutedCoverage(testPlan, [
        {
          directTestPath: "tests/profile.spec.ts",
          directEvidenceValid: true,
          passedTestNames: ["different test"],
        },
      ]),
    ).toHaveLength(3);
    expect(
      assessExecutedCoverage(testPlan, [
        {
          directTestPath: "tests/profile.spec.ts",
          directEvidenceValid: true,
          passedTestNames: ["profile persists after reload"],
        },
      ]),
    ).toEqual([]);
  });

  it("recognizes real Python tests and rejects assert True", () => {
    const pythonSpec: ProductSpec = {
      ...spec,
      userFlows: [],
      acceptanceCriteria: ["Calculator adds two values"],
    };
    const pythonBuild: FileBuild = {
      files: [{
        path: "calculator.py",
        purpose: "calculator",
        contents: "def add(a,b): return a+b\n",
        edits: [],
      }],
    };
    const good: TestPlan = {
      testPlan: "calculator",
      coverage: [{
        requirementId: "AC-1",
        testPath: "tests/calculator_test.py",
        testName: "test_add",
        kind: "unit",
      }],
      files: [{
        path: "tests/calculator_test.py",
        purpose: "unit",
        contents: "def test_add():\n    result = add(1, 2)\n    assert result == 3\n",
      }],
    };
    expect(assessGeneratedTests(pythonSpec, pythonBuild, good).ok).toBe(true);
    good.files[0]!.contents = "def test_add():\n    assert True\n";
    expect(assessGeneratedTests(pythonSpec, pythonBuild, good).ok).toBe(false);
  });
});
