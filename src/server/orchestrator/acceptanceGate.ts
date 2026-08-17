import * as ts from "typescript";
import type {
  FileBuild,
  ProductSpec,
  TestPlan,
} from "../../shared/schemas.js";
import { normalizeTestPath } from "../workspace/testPaths.js";

const UI_SOURCE = /\.(?:jsx|tsx|vue|svelte|html|css|scss|sass|less)$/i;
const UI_ACTION =
  /\b(?:click|tap|type|fill|submit|select|open|close|navigate|route|modal|form|button|link|save|edit|delete|reload|refresh|persist|visible|render|display|responsive|keyboard|focus|drag|drop)\b/i;
const RELOAD = /\b(?:reload|refresh|persist|persistence)\b/i;
const INTERACTIONS = new Set([
  "click",
  "dblclick",
  "fill",
  "press",
  "type",
  "selectOption",
  "check",
  "uncheck",
  "dragTo",
  "dispatchEvent",
]);
const ASSERT_METHOD = /^(?:to|not|resolves|rejects|assert)/;

export interface AcceptanceRequirement {
  id: string;
  text: string;
  browserRequired: boolean;
}

interface TestEvidence {
  name: string;
  meaningfulAssertion: boolean;
  browser: boolean;
  gotoApp: boolean;
  interaction: boolean;
  reload: boolean;
  forbiddenBrowserFixture: boolean;
}

interface FileEvidence {
  browserImport: boolean;
  skippedOrTodo: boolean;
  tests: Map<string, TestEvidence>;
}

export interface GeneratedTestAssessment {
  ok: boolean;
  errors: string[];
  uiAcceptanceRequired: boolean;
  browserTestPaths: string[];
  requirements: AcceptanceRequirement[];
}

function expressionName(node: ts.Expression): string | null {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return null;
}

function containsExpectCall(node: ts.Node): ts.CallExpression | null {
  let found: ts.CallExpression | null = null;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(child) &&
      ts.isIdentifier(child.expression) &&
      child.expression.text === "expect"
    ) {
      found = child;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function isPrimitiveLiteral(node: ts.Expression | undefined): boolean {
  return Boolean(
    node &&
      (ts.isStringLiteralLike(node) ||
        ts.isNumericLiteral(node) ||
        node.kind === ts.SyntaxKind.TrueKeyword ||
        node.kind === ts.SyntaxKind.FalseKeyword ||
        node.kind === ts.SyntaxKind.NullKeyword),
  );
}

function analyzeCallback(
  callback: ts.ArrowFunction | ts.FunctionExpression,
): Omit<TestEvidence, "name" | "browser"> {
  let meaningfulAssertion = false;
  let gotoApp = false;
  let interaction = false;
  let reload = false;
  let forbiddenBrowserFixture = false;

  const inspectCall = (call: ts.CallExpression): void => {
    const name = expressionName(call.expression);
    if (name === "setContent") forbiddenBrowserFixture = true;
    if (name === "goto") {
      const first = call.arguments[0];
      if (
        first &&
        ts.isStringLiteralLike(first) &&
        /^(?:data:|file:|about:|javascript:)/i.test(first.text)
      ) {
        forbiddenBrowserFixture = true;
      } else {
        gotoApp = true;
      }
    }
    if (name && INTERACTIONS.has(name)) interaction = true;
    if (name === "reload") reload = true;

    const expectCall = containsExpectCall(call.expression);
    if (name && ASSERT_METHOD.test(name) && expectCall) {
      if (!isPrimitiveLiteral(expectCall.arguments[0])) meaningfulAssertion = true;
      return;
    }
    if (
      (name === "assert" || name?.startsWith("assert") === true) &&
      !isPrimitiveLiteral(call.arguments[0])
    ) {
      meaningfulAssertion = true;
    }
  };

  const visit = (node: ts.Node, root = false): void => {
    if (
      !root &&
      (ts.isArrowFunction(node) ||
        ts.isFunctionExpression(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node))
    ) {
      return;
    }
    if (ts.isBlock(node)) {
      for (const statement of node.statements) {
        if (ts.isReturnStatement(statement)) break;
        visit(statement);
      }
      return;
    }
    if (ts.isIfStatement(node)) {
      if (node.expression.kind === ts.SyntaxKind.FalseKeyword) {
        if (node.elseStatement) visit(node.elseStatement);
        return;
      }
      if (node.expression.kind === ts.SyntaxKind.TrueKeyword) {
        visit(node.thenStatement);
        return;
      }
      visit(node.thenStatement);
      if (node.elseStatement) visit(node.elseStatement);
      return;
    }
    if (ts.isCallExpression(node)) inspectCall(node);
    ts.forEachChild(node, (child) => visit(child));
  };
  visit(callback.body, true);
  return {
    meaningfulAssertion,
    gotoApp,
    interaction,
    reload,
    forbiddenBrowserFixture,
  };
}

function analyzeJavascript(source: string): FileEvidence {
  const file = ts.createSourceFile(
    "factory-test.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let browserImport = false;
  let skippedOrTodo = false;
  const tests = new Map<string, TestEvidence>();

  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "@playwright/test"
    ) {
      browserImport = true;
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      let base: string | null = null;
      let mode: string | null = null;
      if (ts.isIdentifier(callee)) {
        base = callee.text;
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression)
      ) {
        base = callee.expression.text;
        mode = callee.name.text;
      }
      if ((base === "test" || base === "it") && (mode === "skip" || mode === "todo")) {
        skippedOrTodo = true;
      }
      if (
        (base === "test" || base === "it") &&
        mode !== "skip" &&
        mode !== "todo"
      ) {
        const title = node.arguments[0];
        const callback = node.arguments[1];
        if (
          title &&
          ts.isStringLiteralLike(title) &&
          callback &&
          (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
        ) {
          tests.set(title.text, {
            name: title.text,
            browser: browserImport,
            ...analyzeCallback(callback),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  // Imports appear before tests in normal modules, but normalize browser state
  // after the traversal so unusual declaration order cannot matter.
  for (const test of tests.values()) test.browser = browserImport;
  return { browserImport, skippedOrTodo, tests };
}

function analyzePython(source: string): FileEvidence {
  const tests = new Map<string, TestEvidence>();
  const lines = source.split(/\r?\n/);
  let skippedOrTodo = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*@pytest\.mark\.(?:skip|skipif)|pytest\.skip\s*\(/.test(line)) {
      skippedOrTodo = true;
    }
    const match = /^\s*def\s+(test_[A-Za-z0-9_]+)\s*\(/.exec(line);
    if (!match) continue;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]!;
      if (!next.trim()) {
        body.push(next);
        continue;
      }
      const nextIndent = next.match(/^\s*/)?.[0].length ?? 0;
      if (nextIndent <= indent) break;
      body.push(next);
    }
    const meaningfulAssertion = body.some(
      (entry) =>
        /^\s*assert\s+/.test(entry) &&
        !/^\s*assert\s+(?:True|1)(?:\s|$)/.test(entry),
    );
    tests.set(match[1]!, {
      name: match[1]!,
      meaningfulAssertion,
      browser: false,
      gotoApp: false,
      interaction: false,
      reload: false,
      forbiddenBrowserFixture: false,
    });
  }
  return { browserImport: false, skippedOrTodo, tests };
}

function analyzeFile(path: string, source: string): FileEvidence {
  return /\.py$/i.test(path)
    ? analyzePython(source)
    : analyzeJavascript(source);
}

export function acceptanceRequirements(
  spec: ProductSpec,
  productBuild: FileBuild,
): {
  requirements: AcceptanceRequirement[];
  uiAcceptanceRequired: boolean;
} {
  const uiChanged = productBuild.files.some(
    (file) => UI_SOURCE.test(file.path) && !normalizeTestPath(file.path),
  );
  const requirements: AcceptanceRequirement[] = [
    ...spec.userFlows.map((text, index) => ({
      id: `UF-${index + 1}`,
      text,
      browserRequired: uiChanged && UI_ACTION.test(text),
    })),
    ...spec.acceptanceCriteria.map((text, index) => ({
      id: `AC-${index + 1}`,
      text,
      browserRequired: uiChanged && UI_ACTION.test(text),
    })),
  ];
  return { requirements, uiAcceptanceRequired: uiChanged };
}

/**
 * Deterministic minimum quality contract for model-authored tests.
 *
 * It cannot prove that an assertion semantically matches a requirement. It
 * does prove that every requirement is mapped to a named active test, that
 * evidence comes from executable syntax rather than comments/dead branches,
 * and that UI behavior uses a real-app Playwright journey.
 */
export function assessGeneratedTests(
  spec: ProductSpec,
  productBuild: FileBuild,
  testPlan: TestPlan,
): GeneratedTestAssessment {
  const errors: string[] = [];
  const { requirements, uiAcceptanceRequired } = acceptanceRequirements(
    spec,
    productBuild,
  );
  const browserTestPaths: string[] = [];
  const files = new Map<string, FileEvidence>();

  if (!testPlan.files.length) {
    errors.push("no change-specific test files were provided");
  }
  for (const file of testPlan.files) {
    const path = normalizeTestPath(file.path);
    if (!path) {
      errors.push(`${file.path}: path is not a supported relative test file`);
      continue;
    }
    const evidence = analyzeFile(path, file.contents);
    files.set(path, evidence);
    if (evidence.skippedOrTodo) {
      errors.push(`${file.path}: skipped or todo tests are not acceptance evidence`);
    }
    if (!evidence.tests.size) {
      errors.push(`${file.path}: no active named test was found`);
    }
    if (![...evidence.tests.values()].some((test) => test.meaningfulAssertion)) {
      errors.push(`${file.path}: no meaningful executable assertion was found`);
    }
    if (evidence.browserImport) browserTestPaths.push(path);
  }

  const coverage = testPlan.coverage ?? [];
  if (!coverage.length) {
    errors.push("test plan has no machine-readable requirement coverage");
  }
  const known = new Map(requirements.map((requirement) => [requirement.id, requirement]));
  for (const item of coverage) {
    const requirement = known.get(item.requirementId);
    if (!requirement) {
      errors.push(`unknown coverage requirement: ${item.requirementId}`);
      continue;
    }
    const path = normalizeTestPath(item.testPath);
    const file = path ? files.get(path) : undefined;
    const test = file?.tests.get(item.testName);
    if (!path || !file) {
      errors.push(`${item.requirementId}: coverage path is not a generated test file`);
      continue;
    }
    if (!test) {
      errors.push(
        `${item.requirementId}: active test "${item.testName}" was not found in ${path}`,
      );
      continue;
    }
    if (!test.meaningfulAssertion) {
      errors.push(`${item.requirementId}: mapped test has no meaningful assertion`);
    }
    if (item.kind === "browser") {
      if (!file.browserImport || !test.browser) {
        errors.push(`${item.requirementId}: browser coverage is not a Playwright test`);
      }
      if (!test.gotoApp || test.forbiddenBrowserFixture) {
        errors.push(`${item.requirementId}: browser test does not navigate to the real app`);
      }
      if (requirement.browserRequired && !test.interaction) {
        errors.push(`${item.requirementId}: browser test performs no real user interaction`);
      }
      if (RELOAD.test(requirement.text) && !test.reload) {
        errors.push(`${item.requirementId}: persistence coverage requires page.reload()`);
      }
    } else if (requirement.browserRequired) {
      errors.push(`${item.requirementId}: interactive UI requirement must use browser coverage`);
    }
  }
  for (const requirement of requirements) {
    if (!coverage.some((item) => item.requirementId === requirement.id)) {
      errors.push(`${requirement.id}: acceptance requirement has no mapped test`);
    }
  }
  if (
    uiAcceptanceRequired &&
    !coverage.some((item) => item.kind === "browser")
  ) {
    errors.push("UI source changed but no mapped Playwright browser journey exists");
  }

  return {
    ok: errors.length === 0,
    errors,
    uiAcceptanceRequired,
    browserTestPaths,
    requirements,
  };
}

export function assessExecutedCoverage(
  testPlan: TestPlan,
  executed: Array<{
    directTestPath?: string;
    directEvidenceValid?: boolean;
    passedTestNames?: string[];
  }>,
): string[] {
  const errors: string[] = [];
  for (const item of testPlan.coverage ?? []) {
    const path = normalizeTestPath(item.testPath);
    const evidence = executed.find(
      (entry) =>
        path &&
        normalizeTestPath(entry.directTestPath ?? "") === path &&
        entry.directEvidenceValid === true,
    );
    if (!evidence) {
      errors.push(`${item.requirementId}: mapped test file did not produce valid direct runner evidence`);
      continue;
    }
    if (!(evidence.passedTestNames ?? []).includes(item.testName)) {
      errors.push(
        `${item.requirementId}: mapped test "${item.testName}" was not reported passed`,
      );
    }
  }
  return errors;
}
