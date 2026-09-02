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
        plan(
          source,
          "tests/profile.spec.ts",
          "reload",
          coverage("tests/profile.spec.ts", "reload"),
        ),
      );
      expect(result.ok, source).toBe(false);
    }
  });

  it("rejects ambiguous negative substrings and short unbounded regex alternatives", () => {
    const cliSpec: ProductSpec = {
      ...spec,
      userFlows: [],
      acceptanceCriteria: ["CLI errors are friendly and contain no stack trace"],
    };
    const cliBuild: FileBuild = {
      files: [
        {
          path: "src/cli.ts",
          purpose: "CLI",
          contents: "export const run = () => 'friendly error';",
          edits: [],
        },
      ],
    };
    const testPath = "tests/cli.test.ts";
    const testName = "reports a friendly error without implementation leakage";
    const withAssertion = (assertion: string): TestPlan => ({
      testPlan: "CLI failure behavior",
      coverage: [{ requirementId: "AC-1", testPath, testName, kind: "unit" }],
      files: [
        {
          path: testPath,
          purpose: "CLI acceptance",
          contents: [
            'import assert from "node:assert/strict";',
            'import { expect, it } from "vitest";',
            `it(${JSON.stringify(testName)}, () => {`,
            "  const output = run();",
            `  ${assertion}`,
            '  expect(output).toContain("friendly");',
            "});",
          ].join("\n"),
        },
      ],
    });

    const substring = assessGeneratedTests(
      cliSpec,
      cliBuild,
      withAssertion('expect(output).not.toContain("at ");'),
    );
    expect(substring.ok).toBe(false);
    expect(substring.errors.join("\n")).toMatch(/brittle negated substring/i);

    const overlappingSubstring = assessGeneratedTests(
      cliSpec,
      cliBuild,
      withAssertion('expect(output).not.toContain("vite");'),
    );
    expect(overlappingSubstring.ok).toBe(false);
    expect(overlappingSubstring.errors.join("\n")).toMatch(
      /brittle negated substring/i,
    );

    const regex = assessGeneratedTests(
      cliSpec,
      cliBuild,
      withAssertion("expect(output).not.toMatch(/vite|next|http-server/i);"),
    );
    expect(regex.ok).toBe(false);
    expect(regex.errors.join("\n")).toMatch(/unbounded negated regex/i);

    const groupedRegex = assessGeneratedTests(
      cliSpec,
      cliBuild,
      withAssertion("expect(output).not.toMatch(/(vite|next)/i);"),
    );
    expect(groupedRegex.ok).toBe(false);
    expect(groupedRegex.errors.join("\n")).toMatch(/unbounded negated regex/i);

    const nodeAssertRegex = assessGeneratedTests(
      cliSpec,
      cliBuild,
      withAssertion("assert.doesNotMatch(output, /(vite|next)/i);"),
    );
    expect(nodeAssertRegex.ok).toBe(false);
    expect(nodeAssertRegex.errors.join("\n")).toMatch(/unbounded negated regex/i);

    expect(
      assessGeneratedTests(
        cliSpec,
        cliBuild,
        withAssertion(
          "expect(output).not.toMatch(/^\\s*at\\s+/m); expect(output).not.toMatch(/\\bvite\\b|\\bnext\\b/i);",
        ),
      ).ok,
    ).toBe(true);
    expect(
      assessGeneratedTests(
        cliSpec,
        cliBuild,
        withAssertion("assert.doesNotMatch(output, /\\bvite\\b|\\bnext\\b/i);"),
      ).ok,
    ).toBe(true);
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
      assessGeneratedTests(spec, uiBuild, {
        ...plan(validJourney),
        coverage: [],
      }).ok,
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

  it("recognizes standard node:assert calls without accepting literal tautologies", () => {
    const cliSpec: ProductSpec = {
      ...spec,
      userFlows: [],
      acceptanceCriteria: ["The CLI reports the saved task"],
    };
    const cliBuild: FileBuild = {
      files: [
        {
          path: "src/cli.ts",
          purpose: "CLI",
          contents: "export const list = () => ['saved task'];",
          edits: [],
        },
      ],
    };
    const path = "tests/cli.test.ts";
    const mapped = [
      {
        requirementId: "AC-1",
        testPath: path,
        testName: "reports the saved task",
        kind: "unit" as const,
      },
    ];
    const withSource = (assertion: string): TestPlan => ({
      testPlan: "CLI acceptance",
      coverage: mapped,
      files: [
        {
          path,
          purpose: "acceptance",
          contents: [
            "import assert from 'node:assert/strict';",
            "import { test } from 'node:test';",
            "test('reports the saved task', () => {",
            "  const output = list();",
            `  ${assertion}`,
            "});",
          ].join("\n"),
        },
      ],
    });

    expect(
      assessGeneratedTests(
        cliSpec,
        cliBuild,
        withSource("assert.deepEqual(output, ['saved task']);"),
      ).ok,
    ).toBe(true);
    expect(
      assessGeneratedTests(
        cliSpec,
        cliBuild,
        withSource("assert.equal('saved task', 'saved task');"),
      ).ok,
    ).toBe(false);
  });

  it("recognizes assertions in awaited inline helper callbacks only", () => {
    const cliSpec: ProductSpec = {
      ...spec,
      userFlows: [],
      acceptanceCriteria: ["The CLI reports the saved task"],
    };
    const cliBuild: FileBuild = {
      files: [
        {
          path: "src/cli.ts",
          purpose: "CLI",
          contents: "export const run = () => ({ exitCode: 0 });",
          edits: [],
        },
      ],
    };
    const path = "tests/workflow.test.ts";
    const withSource = (body: string): TestPlan => ({
      testPlan: "CLI acceptance",
      coverage: [
        {
          requirementId: "AC-1",
          testPath: path,
          testName: "reports the saved task",
          kind: "unit",
        },
      ],
      files: [
        {
          path,
          purpose: "acceptance",
          contents: [
            "import { expect, it } from 'vitest';",
            "it('reports the saved task', async () => {",
            body,
            "});",
          ].join("\n"),
        },
      ],
    });

    expect(
      assessGeneratedTests(
        cliSpec,
        cliBuild,
        withSource(
          "  const withTempTaskFile = async (callback) => { await callback('task.json'); }; await withTempTaskFile(async (filePath) => { const result = run(filePath); expect(result.exitCode).toBe(0); });",
        ),
      ).ok,
    ).toBe(true);
    expect(
      assessGeneratedTests(
        cliSpec,
        cliBuild,
        withSource(
          "  const verifyResult = async () => { const result = run(); expect(result.exitCode).toBe(0); }; await verifyResult();",
        ),
      ).ok,
    ).toBe(true);
    expect(
      assessGeneratedTests(
        cliSpec,
        cliBuild,
        withSource(
          "  const verifyResult = async () => { const result = run(); expect(result.exitCode).toBe(0); }; await Promise.all([verifyResult()]);",
        ),
      ).ok,
    ).toBe(true);
    expect(
      assessGeneratedTests(
        cliSpec,
        cliBuild,
        withSource(
          "  const inspectResult = async () => { const result = run(); expect(result.exitCode).toBe(0); }; const verifyResult = () => inspectResult(); await verifyResult();",
        ),
      ).ok,
    ).toBe(true);
    expect(
      assessGeneratedTests(
        cliSpec,
        cliBuild,
        withSource(
          "  const deferred = () => { const result = run(); expect(result.exitCode).toBe(0); };",
        ),
      ).ok,
    ).toBe(false);
    expect(
      assessGeneratedTests(
        cliSpec,
        cliBuild,
        withSource(
          "  await withTempTaskFile(async () => { if (false) { const result = run(); expect(result.exitCode).toBe(0); } });",
        ),
      ).ok,
    ).toBe(false);
    expect(
      assessGeneratedTests(
        cliSpec,
        cliBuild,
        withSource(
          "  const floating = async () => { await Promise.resolve(); const result = run(); expect(result.exitCode).toBe(0); }; floating();",
        ),
      ).ok,
    ).toBe(false);
    expect(
      assessGeneratedTests(
        cliSpec,
        cliBuild,
        withSource(
          "  await Promise.resolve(async () => { const result = run(); expect(result.exitCode).toBe(0); });",
        ),
      ).ok,
    ).toBe(false);
    expect(
      assessGeneratedTests(
        cliSpec,
        cliBuild,
        withSource("  const verifyResult = async () => {}; await verifyResult();"),
      ).ok,
    ).toBe(false);
  });

  it("resolves same-named helpers lexically and rejects unconsumed generators", () => {
    const cliSpec: ProductSpec = {
      ...spec,
      userFlows: [],
      acceptanceCriteria: ["The CLI reports the saved task"],
    };
    const cliBuild: FileBuild = {
      files: [
        {
          path: "src/cli.ts",
          purpose: "CLI",
          contents: "export const run = () => ({ exitCode: 0 });",
          edits: [],
        },
      ],
    };
    const path = "tests/scoped.test.ts";
    const mappedPlan = (contents: string): TestPlan => ({
      testPlan: "CLI acceptance",
      coverage: [
        {
          requirementId: "AC-1",
          testPath: path,
          testName: "mapped test",
          kind: "unit",
        },
      ],
      files: [{ path, purpose: "acceptance", contents }],
    });

    const duplicateNames = mappedPlan(
      [
        "import { expect, it } from 'vitest';",
        "it('mapped test', () => { const verify = () => {}; verify(); });",
        "it('other test', () => { const verify = () => { expect(run().exitCode).toBe(0); }; verify(); });",
      ].join("\n"),
    );
    expect(assessGeneratedTests(cliSpec, cliBuild, duplicateNames).ok).toBe(false);

    const generator = mappedPlan(
      [
        "import { expect, it } from 'vitest';",
        "it('mapped test', () => {",
        "  function* verify() { expect(run().exitCode).toBe(0); }",
        "  verify();",
        "});",
      ].join("\n"),
    );
    expect(assessGeneratedTests(cliSpec, cliBuild, generator).ok).toBe(false);
  });

  it("recognizes awaited Vitest rejection assertions as executable evidence", () => {
    const cliSpec: ProductSpec = {
      ...spec,
      userFlows: [],
      acceptanceCriteria: ["Blank tasks are rejected with a friendly message"],
    };
    const cliBuild: FileBuild = {
      files: [
        {
          path: "src/commands.ts",
          purpose: "CLI commands",
          contents: "export async function runCommand() { throw new Error('blank'); }",
          edits: [],
        },
      ],
    };
    const path = "test/workflow.test.ts";
    const testName = "rejects a blank task description with a clear next step";
    const result = assessGeneratedTests(cliSpec, cliBuild, {
      testPlan: "CLI acceptance",
      coverage: [
        {
          requirementId: "AC-1",
          testPath: path,
          testName,
          kind: "unit",
        },
      ],
      files: [
        {
          path,
          purpose: "acceptance",
          contents: [
            'import { expect, it } from "vitest";',
            `it("${testName}", async () => {`,
            '  await expect(runCommand(["add", "   "])).rejects.toThrow(',
            '    "Please type a task description.",',
            "  );",
            "});",
          ].join("\n"),
        },
      ],
    });

    expect(result).toMatchObject({ ok: true, errors: [] });
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
      files: [
        {
          path: "calculator.py",
          purpose: "calculator",
          contents: "def add(a,b): return a+b\n",
          edits: [],
        },
      ],
    };
    const good: TestPlan = {
      testPlan: "calculator",
      coverage: [
        {
          requirementId: "AC-1",
          testPath: "tests/calculator_test.py",
          testName: "test_add",
          kind: "unit",
        },
      ],
      files: [
        {
          path: "tests/calculator_test.py",
          purpose: "unit",
          contents: "def test_add():\n    result = add(1, 2)\n    assert result == 3\n",
        },
      ],
    };
    expect(assessGeneratedTests(pythonSpec, pythonBuild, good).ok).toBe(true);
    good.files[0]!.contents = "def test_add():\n    assert True\n";
    expect(assessGeneratedTests(pythonSpec, pythonBuild, good).ok).toBe(false);

    good.files[0]!.contents =
      'def test_add():\n    output = "vitest ready"\n    assert "vite" not in output\n';
    expect(assessGeneratedTests(pythonSpec, pythonBuild, good).ok).toBe(false);
    good.files[0]!.contents =
      'def test_add():\n    output = "vitest ready"\n    assert not re.search(r"(vite|next)", output)\n';
    expect(assessGeneratedTests(pythonSpec, pythonBuild, good).ok).toBe(false);
  });
});
