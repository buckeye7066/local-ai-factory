import * as ts from "typescript";
import type { FileBuild, ProductSpec, TestPlan } from "../../shared/schemas.js";
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
const ASSERT_OBJECT_METHODS = new Set([
  "ok",
  "equal",
  "notEqual",
  "strictEqual",
  "notStrictEqual",
  "deepEqual",
  "notDeepEqual",
  "deepStrictEqual",
  "notDeepStrictEqual",
  "match",
  "doesNotMatch",
  "throws",
  "doesNotThrow",
  "rejects",
  "doesNotReject",
  "fail",
]);
const ASYNC_ASSERT_OBJECT_METHODS = new Set(["rejects", "doesNotReject"]);

export interface AcceptanceRequirement {
  id: string;
  text: string;
  browserRequired: boolean;
}

interface TestEvidence {
  name: string;
  meaningfulAssertion: boolean;
  brittleAssertions: string[];
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

type JavascriptHelper =
  | ts.ArrowFunction
  | ts.FunctionExpression
  | ts.FunctionDeclaration;

type VisibleBinding =
  | { kind: "helper"; helper: JavascriptHelper }
  | { kind: "import"; module: string; imported: string }
  | { kind: "other" };

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

function isAsyncFunction(node: JavascriptHelper): boolean {
  return (
    node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ===
    true
  );
}

function isGeneratorHelper(node: JavascriptHelper): boolean {
  return (
    (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) &&
    Boolean(node.asteriskToken)
  );
}

function bindingNameContains(binding: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(binding)) return binding.text === name;
  return binding.elements.some(
    (element) =>
      !ts.isOmittedExpression(element) && bindingNameContains(element.name, name),
  );
}

function importBinding(
  statement: ts.ImportDeclaration,
  name: string,
): VisibleBinding | null {
  if (!ts.isStringLiteral(statement.moduleSpecifier)) return null;
  const module = statement.moduleSpecifier.text;
  const clause = statement.importClause;
  if (!clause) return null;
  if (clause.name?.text === name) {
    return { kind: "import", module, imported: "default" };
  }
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings) && bindings.name.text === name) {
    return { kind: "import", module, imported: "*" };
  }
  if (bindings && ts.isNamedImports(bindings)) {
    const specifier = bindings.elements.find((element) => element.name.text === name);
    if (specifier) {
      return {
        kind: "import",
        module,
        imported: specifier.propertyName?.text ?? specifier.name.text,
      };
    }
  }
  return null;
}

function statementBinding(
  statement: ts.Statement,
  name: string,
  callPosition: number,
  allowFollowingDeclarations: boolean,
): VisibleBinding | null {
  if (ts.isImportDeclaration(statement)) return importBinding(statement, name);
  if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) {
    return isGeneratorHelper(statement)
      ? { kind: "other" }
      : { kind: "helper", helper: statement };
  }
  if (
    (ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) &&
    statement.name?.text === name
  ) {
    return { kind: "other" };
  }
  if (!ts.isVariableStatement(statement)) return null;
  for (const declaration of statement.declarationList.declarations) {
    if (!bindingNameContains(declaration.name, name)) continue;
    const initializedBeforeCall =
      allowFollowingDeclarations || declaration.getStart() < callPosition;
    if (
      initializedBeforeCall &&
      ts.isIdentifier(declaration.name) &&
      declaration.initializer &&
      (ts.isArrowFunction(declaration.initializer) ||
        ts.isFunctionExpression(declaration.initializer)) &&
      !isGeneratorHelper(declaration.initializer)
    ) {
      return { kind: "helper", helper: declaration.initializer };
    }
    // A declaration that is not an initialized callable still shadows every
    // outer helper (including declarations later in the same TDZ/var scope).
    return { kind: "other" };
  }
  return null;
}

function statementsBinding(
  statements: readonly ts.Statement[],
  name: string,
  callPosition: number,
  allowFollowingDeclarations: boolean,
): VisibleBinding | null {
  const matches = statements
    .map((statement) =>
      statementBinding(statement, name, callPosition, allowFollowingDeclarations),
    )
    .filter((binding): binding is VisibleBinding => binding !== null);
  // Duplicate runtime bindings are too ambiguous for static acceptance evidence.
  return matches.length === 1
    ? matches[0]!
    : matches.length > 1
      ? { kind: "other" }
      : null;
}

function declarationListBinds(
  list: ts.VariableDeclarationList | undefined,
  name: string,
): boolean {
  return Boolean(
    list?.declarations.some((declaration) =>
      bindingNameContains(declaration.name, name),
    ),
  );
}

/** Resolve the binding visible at a call site, nearest lexical scope first. */
function resolveVisibleBinding(
  call: ts.CallExpression,
  name: string,
  executionRoot: JavascriptHelper,
): VisibleBinding | null {
  const callPosition = call.getStart();
  let allowFollowingDeclarations = false;
  let current: ts.Node | undefined = call.parent;
  while (current) {
    if (ts.isBlock(current) || ts.isSourceFile(current)) {
      const binding = statementsBinding(
        current.statements,
        name,
        callPosition,
        allowFollowingDeclarations,
      );
      if (binding) return binding;
    }
    if (ts.isCaseBlock(current)) {
      const binding = statementsBinding(
        current.clauses.flatMap((clause) => [...clause.statements]),
        name,
        callPosition,
        allowFollowingDeclarations,
      );
      if (binding) return binding;
    }
    if (
      (ts.isForStatement(current) ||
        ts.isForInStatement(current) ||
        ts.isForOfStatement(current)) &&
      current.initializer &&
      ts.isVariableDeclarationList(current.initializer) &&
      declarationListBinds(current.initializer, name)
    ) {
      return { kind: "other" };
    }
    if (
      ts.isCatchClause(current) &&
      current.variableDeclaration &&
      bindingNameContains(current.variableDeclaration.name, name)
    ) {
      return { kind: "other" };
    }
    if (
      ts.isFunctionLike(current) &&
      current.parameters.some((parameter) => bindingNameContains(parameter.name, name))
    ) {
      return { kind: "other" };
    }
    if (current === executionRoot) allowFollowingDeclarations = true;
    current = current.parent;
  }
  return null;
}

function importedCallbackHelper(binding: VisibleBinding, name: string): boolean {
  if (binding.kind !== "import") return false;
  const imported = binding.imported === "*" ? name : binding.imported;
  if (imported === "waitFor") return /^@testing-library\//.test(binding.module);
  if (imported !== "act") return false;
  return (
    binding.module === "react" ||
    binding.module === "react-dom/test-utils" ||
    binding.module === "react-test-renderer" ||
    /^@testing-library\//.test(binding.module)
  );
}

function verifiedAssertionBinding(
  call: ts.CallExpression,
  name: string,
  executionRoot: JavascriptHelper,
): boolean {
  const binding = resolveVisibleBinding(call, name, executionRoot);
  if (!binding) return name === "expect"; // Jest commonly provides global expect.
  if (binding.kind !== "import") return false;
  if (name === "expect") {
    return (
      binding.imported === "expect" &&
      (binding.module === "vitest" ||
        binding.module === "@playwright/test" ||
        binding.module === "@jest/globals")
    );
  }
  return (
    name === "assert" &&
    ((["node:assert", "node:assert/strict", "assert", "assert/strict"].includes(
      binding.module,
    ) &&
      ["default", "*", "strict"].includes(binding.imported)) ||
      (["vitest", "chai"].includes(binding.module) && binding.imported === "assert"))
  );
}

/**
 * Follow expression composition until the value is awaited or returned. This
 * recognizes `await Promise.all([helper()])` and concise returned helper calls
 * without treating a floating promise as executed evidence.
 */
function isUnshadowedPromiseAll(
  call: ts.CallExpression,
  executionRoot: JavascriptHelper,
): boolean {
  return (
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    call.expression.expression.text === "Promise" &&
    (call.expression.name.text === "all" ||
      call.expression.name.text === "allSettled") &&
    resolveVisibleBinding(call, "Promise", executionRoot) === null
  );
}

function expressionResultIsObserved(
  expression: ts.Expression,
  executionRoot: JavascriptHelper,
): boolean {
  let current: ts.Node = expression;
  while (current.parent) {
    const parent = current.parent;
    if (ts.isAwaitExpression(parent) && parent.expression === current) return true;
    if (ts.isReturnStatement(parent) && parent.expression === current) return true;
    if (ts.isArrowFunction(parent) && parent.body === current) return true;
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isSatisfiesExpression(parent)
    ) {
      current = parent;
      continue;
    }
    if (
      ts.isArrayLiteralExpression(parent) &&
      ts.isCallExpression(parent.parent) &&
      parent.parent.arguments.some((argument) => argument === parent) &&
      isUnshadowedPromiseAll(parent.parent, executionRoot)
    ) {
      current = parent.parent;
      continue;
    }
    break;
  }
  return false;
}

function statementDefinitelyTerminates(statement: ts.Statement): boolean {
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return true;
  if (ts.isBlock(statement)) {
    return statement.statements.some((child) => statementDefinitelyTerminates(child));
  }
  if (ts.isIfStatement(statement)) {
    if (statement.expression.kind === ts.SyntaxKind.TrueKeyword) {
      return statementDefinitelyTerminates(statement.thenStatement);
    }
    if (statement.expression.kind === ts.SyntaxKind.FalseKeyword) {
      return Boolean(
        statement.elseStatement &&
          statementDefinitelyTerminates(statement.elseStatement),
      );
    }
    return Boolean(
      statement.elseStatement &&
        statementDefinitelyTerminates(statement.thenStatement) &&
        statementDefinitelyTerminates(statement.elseStatement),
    );
  }
  return false;
}

function helperInvokesParameter(
  helper: JavascriptHelper,
  parameterIndex: number,
  callback: ts.ArrowFunction | ts.FunctionExpression,
): boolean {
  const parameter = helper.parameters[parameterIndex]?.name;
  if (!parameter || !ts.isIdentifier(parameter) || !helper.body) return false;
  let invoked = false;
  const visit = (node: ts.Node, root = false): void => {
    if (invoked) return;
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
        visit(statement);
        if (statementDefinitelyTerminates(statement)) break;
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
      // A callback invoked only on one runtime branch is not guaranteed evidence.
      return;
    }
    if (
      ts.isWhileStatement(node) &&
      node.expression.kind === ts.SyntaxKind.FalseKeyword
    ) {
      return;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === parameter.text &&
      (!isAsyncFunction(callback) || expressionResultIsObserved(node, helper))
    ) {
      invoked = true;
      return;
    }
    ts.forEachChild(node, (child) => visit(child));
  };
  visit(helper.body, true);
  return invoked;
}

function callInvokesInlineCallback(
  call: ts.CallExpression,
  callback: ts.ArrowFunction | ts.FunctionExpression,
  executionRoot: JavascriptHelper,
): boolean {
  const parameterIndex = call.arguments.findIndex((argument) => argument === callback);
  if (parameterIndex < 0) return false;
  if (ts.isIdentifier(call.expression)) {
    const binding = resolveVisibleBinding(call, call.expression.text, executionRoot);
    if (binding?.kind === "helper") {
      return helperInvokesParameter(binding.helper, parameterIndex, callback);
    }
    return binding ? importedCallbackHelper(binding, call.expression.text) : false;
  }
  if (
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression)
  ) {
    const binding = resolveVisibleBinding(
      call,
      call.expression.expression.text,
      executionRoot,
    );
    return binding ? importedCallbackHelper(binding, call.expression.name.text) : false;
  }
  return false;
}

function hasTopLevelAlternation(pattern: string): boolean {
  let depth = 0;
  let inCharacterClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "[") {
      inCharacterClass = true;
      continue;
    }
    if (char === "]") {
      inCharacterClass = false;
      continue;
    }
    if (inCharacterClass) continue;
    if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === "|" && depth === 0) return true;
  }
  return false;
}

function leftRegexBoundary(fragment: string): boolean {
  return (
    fragment.endsWith("\\b") ||
    /(?:^|[^\\])\^$/.test(fragment) ||
    /\\s[*+?]?$/.test(fragment) ||
    /\(\?:\^\|\\s[*+?]?\)$/.test(fragment) ||
    /\(\?:\\s[*+?]?\|\^\)$/.test(fragment)
  );
}

function rightRegexBoundary(fragment: string): boolean {
  return (
    fragment.startsWith("\\b") ||
    /^\$/.test(fragment) ||
    /^\\s[*+?]?/.test(fragment) ||
    /^\(\?:\\s[*+?]?\|\$\)/.test(fragment) ||
    /^\(\?:\$\|\\s[*+?]?\)/.test(fragment)
  );
}

function shortUnboundedRegexToken(pattern: string): string | null {
  // Anchors protect the entire expression only when no top-level alternative
  // can escape them (`^vite|next$` is not globally anchored).
  if (
    pattern.startsWith("^") &&
    pattern.endsWith("$") &&
    !hasTopLevelAlternation(pattern)
  ) {
    return null;
  }
  let inCharacterClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "[") {
      inCharacterClass = true;
      continue;
    }
    if (char === "]") {
      inCharacterClass = false;
      continue;
    }
    if (inCharacterClass || !/[A-Za-z]/.test(char)) continue;
    let end = index + 1;
    while (end < pattern.length && /[A-Za-z0-9_-]/.test(pattern[end]!)) end += 1;
    const token = pattern.slice(index, end);
    const previous = pattern[index - 1] ?? "";
    const following = pattern[end] ?? "";
    const partOfLongerToken = /[A-Za-z0-9_-]/.test(previous + following);
    if (!partOfLongerToken && token.length >= 2 && token.length <= 4) {
      const left = pattern.slice(0, index);
      const right = pattern.slice(end);
      const leftBounded = leftRegexBoundary(left);
      const rightBounded = rightRegexBoundary(right);
      if (!leftBounded || !rightBounded) return token;
    }
    index = end - 1;
  }
  return null;
}

function brittleSubstring(text: string): string | null {
  const trimmed = text.trim();
  const hasLeftBoundary = text.length > 0 && /[^A-Za-z0-9_-]/.test(text[0]!);
  const hasRightBoundary =
    text.length > 0 && /[^A-Za-z0-9_-]/.test(text[text.length - 1]!);
  return trimmed.length <= 4 && !(hasLeftBoundary && hasRightBoundary)
    ? `brittle negated substring ${JSON.stringify(text)}; ` +
        "use a token-, line-, or structure-specific assertion"
    : null;
}

function brittleRegex(pattern: string): string | null {
  const token = shortUnboundedRegexToken(pattern);
  return token
    ? `brittle unbounded negated regex alternative ${JSON.stringify(token)}; ` +
        "use explicit token boundaries or exact dependency/command checks"
    : null;
}

/**
 * Reject negative assertions whose matcher is broader than the thing it is
 * supposed to exclude. These are especially dangerous in generated tests:
 * `"at "` matches the ordinary word `that`, and `/vite/` matches the allowed
 * test runner `vitest`. Require a specific token or line boundary instead of
 * letting a false positive send product repair after working source code.
 */
function brittleNegatedMatcher(
  call: ts.CallExpression,
  executionRoot: JavascriptHelper,
): string | null {
  if (!ts.isPropertyAccessExpression(call.expression)) return null;
  const matcher = call.expression.name.text;
  const negated = call.expression.expression;
  const expected = call.arguments[0];
  const expectNegation =
    ts.isPropertyAccessExpression(negated) &&
    negated.name.text === "not" &&
    ts.isCallExpression(negated.expression) &&
    ts.isIdentifier(negated.expression.expression) &&
    negated.expression.expression.text === "expect";
  if (expectNegation) {
    if (matcher === "toContain" && expected && ts.isStringLiteralLike(expected)) {
      return brittleSubstring(expected.text);
    }
    if (matcher === "toMatch" && expected && ts.isRegularExpressionLiteral(expected)) {
      const literal = expected.getText();
      const finalSlash = literal.lastIndexOf("/");
      return brittleRegex(finalSlash > 0 ? literal.slice(1, finalSlash) : "");
    }
  }
  if (
    matcher === "doesNotMatch" &&
    ts.isIdentifier(negated) &&
    negated.text === "assert" &&
    verifiedAssertionBinding(call, "assert", executionRoot)
  ) {
    const pattern = call.arguments[1];
    if (pattern && ts.isRegularExpressionLiteral(pattern)) {
      const literal = pattern.getText();
      const finalSlash = literal.lastIndexOf("/");
      return brittleRegex(finalSlash > 0 ? literal.slice(1, finalSlash) : "");
    }
  }
  return null;
}

function analyzeCallback(
  callback: ts.ArrowFunction | ts.FunctionExpression,
): Omit<TestEvidence, "name" | "browser"> {
  let meaningfulAssertion = false;
  const brittleAssertions: string[] = [];
  let gotoApp = false;
  let interaction = false;
  let reload = false;
  let forbiddenBrowserFixture = false;

  const inspectCall = (
    call: ts.CallExpression,
    executionRoot: JavascriptHelper,
  ): void => {
    const brittle = brittleNegatedMatcher(call, executionRoot);
    if (brittle && !brittleAssertions.includes(brittle)) {
      brittleAssertions.push(brittle);
    }
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
    if (
      name &&
      ASSERT_METHOD.test(name) &&
      expectCall &&
      verifiedAssertionBinding(expectCall, "expect", executionRoot) &&
      (!/\.(?:resolves|rejects)\b/.test(call.expression.getText()) ||
        expressionResultIsObserved(call, executionRoot))
    ) {
      if (!isPrimitiveLiteral(expectCall.arguments[0])) meaningfulAssertion = true;
      return;
    }
    if (
      name === "assert" &&
      ts.isIdentifier(call.expression) &&
      verifiedAssertionBinding(call, "assert", executionRoot) &&
      !isPrimitiveLiteral(call.arguments[0])
    ) {
      meaningfulAssertion = true;
      return;
    }

    // Node's assert/strict and Vitest's assert APIs put the assertion name on
    // a property (assert.equal, assert.ok, assert.rejects, ...). The previous
    // detector looked only at the property name, so real executable assertions
    // generated with the host's declared node:assert stack were rejected before
    // the runner could execute them. Require the receiver to be literally
    // "assert" and the observed value/callback to be non-literal; this accepts
    // standard assertion APIs without turning arbitrary .equal() calls or
    // assert.equal(1, 1) into evidence.
    if (
      ts.isPropertyAccessExpression(call.expression) &&
      ts.isIdentifier(call.expression.expression) &&
      call.expression.expression.text === "assert" &&
      verifiedAssertionBinding(call, "assert", executionRoot) &&
      name &&
      ASSERT_OBJECT_METHODS.has(name) &&
      (!ASYNC_ASSERT_OBJECT_METHODS.has(name) ||
        expressionResultIsObserved(call, executionRoot)) &&
      !isPrimitiveLiteral(call.arguments[0])
    ) {
      meaningfulAssertion = true;
    }
  };

  // Nested declarations are not executable evidence on their own. An inline
  // callback passed to a call the test awaits is part of that test's reachable
  // control flow, so inspect it while still rejecting stored/deferred helpers.
  const isAwaitedInlineCallback = (
    node: ts.Node,
    executionRoot: JavascriptHelper,
  ): boolean => {
    if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return false;
    const call = node.parent;
    return (
      ts.isCallExpression(call) &&
      call.arguments.some((argument) => argument === node) &&
      expressionResultIsObserved(call, executionRoot) &&
      callInvokesInlineCallback(call, node, executionRoot)
    );
  };

  // Generated tests often centralize repeated error assertions in a small
  // same-file helper. A declaration alone is still not evidence, but a helper
  // directly reached from the active test is. Async helpers must be awaited or
  // returned so a floating promise cannot masquerade as executed acceptance.
  const activeHelpers = new Set<JavascriptHelper>();

  const visit = (
    node: ts.Node,
    root = false,
    executionRoot: JavascriptHelper = callback,
  ): void => {
    if (
      !root &&
      (ts.isArrowFunction(node) ||
        ts.isFunctionExpression(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node)) &&
      !isAwaitedInlineCallback(node, executionRoot)
    ) {
      return;
    }
    if (ts.isBlock(node)) {
      for (const statement of node.statements) {
        visit(statement, false, executionRoot);
        if (statementDefinitelyTerminates(statement)) break;
      }
      return;
    }
    if (ts.isIfStatement(node)) {
      if (node.expression.kind === ts.SyntaxKind.FalseKeyword) {
        if (node.elseStatement) visit(node.elseStatement, false, executionRoot);
        return;
      }
      if (node.expression.kind === ts.SyntaxKind.TrueKeyword) {
        visit(node.thenStatement, false, executionRoot);
        return;
      }
      visit(node.thenStatement, false, executionRoot);
      if (node.elseStatement) visit(node.elseStatement, false, executionRoot);
      return;
    }
    if (
      ts.isWhileStatement(node) &&
      node.expression.kind === ts.SyntaxKind.FalseKeyword
    ) {
      return;
    }
    if (ts.isCallExpression(node)) {
      inspectCall(node, executionRoot);
      if (ts.isIdentifier(node.expression)) {
        const binding = resolveVisibleBinding(
          node,
          node.expression.text,
          executionRoot,
        );
        const helper = binding?.kind === "helper" ? binding.helper : null;
        if (
          helper &&
          helper.body &&
          !activeHelpers.has(helper) &&
          !isGeneratorHelper(helper) &&
          (!isAsyncFunction(helper) || expressionResultIsObserved(node, executionRoot))
        ) {
          activeHelpers.add(helper);
          visit(helper.body, true, executionRoot);
          activeHelpers.delete(helper);
        }
      }
    }
    ts.forEachChild(node, (child) => visit(child, false, executionRoot));
  };
  visit(callback.body, true);
  return {
    meaningfulAssertion,
    brittleAssertions,
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
      if ((base === "test" || base === "it") && mode !== "skip" && mode !== "todo") {
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

function stripPythonComment(line: string): string {
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "#") return line.slice(0, index);
  }
  return line;
}

function pythonBracketDelta(line: string): number {
  let delta = 0;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") delta += 1;
    if (char === ")" || char === "]" || char === "}") delta -= 1;
  }
  return delta;
}

function pythonLogicalStatements(lines: string[]): string[] {
  const statements: string[] = [];
  let current = "";
  let depth = 0;
  for (const raw of lines) {
    const line = stripPythonComment(raw).trim();
    if (!line) continue;
    const continued = line.endsWith("\\");
    const fragment = continued ? line.slice(0, -1).trimEnd() : line;
    current = current ? `${current} ${fragment}` : fragment;
    depth += pythonBracketDelta(fragment);
    if (depth <= 0 && !continued) {
      statements.push(current);
      current = "";
      depth = 0;
    }
  }
  if (current) statements.push(current);
  return statements;
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
    const statements = pythonLogicalStatements(body);
    const meaningfulAssertion = statements.some(
      (entry) =>
        /^assert\s+/.test(entry) && !/^assert\s+(?:True|1)(?:\s|$)/.test(entry),
    );
    const brittleAssertions: string[] = [];
    for (const entry of statements) {
      const substring = /^assert\s+(["'])(.*?)\1\s+not\s+in\b/.exec(entry);
      if (substring) {
        const issue = brittleSubstring(substring[2] ?? "");
        if (issue && !brittleAssertions.includes(issue)) brittleAssertions.push(issue);
      }
      const negativeRegex =
        /^assert\s+(?:not\s+)?re\.(?:search|match|fullmatch)\(\s*r?(["'])(.*?)\1/.exec(
          entry,
        );
      if (
        negativeRegex &&
        (/^assert\s+not\s+/.test(entry) || /\bis\s+None\b/.test(entry))
      ) {
        const issue = brittleRegex(negativeRegex[2] ?? "");
        if (issue && !brittleAssertions.includes(issue)) brittleAssertions.push(issue);
      }
    }
    tests.set(match[1]!, {
      name: match[1]!,
      meaningfulAssertion,
      brittleAssertions,
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
  return /\.py$/i.test(path) ? analyzePython(source) : analyzeJavascript(source);
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
    for (const test of evidence.tests.values()) {
      for (const issue of test.brittleAssertions) {
        errors.push(`${file.path}: test ${JSON.stringify(test.name)} uses ${issue}`);
      }
    }
    if (evidence.browserImport) browserTestPaths.push(path);
  }

  const coverage = testPlan.coverage ?? [];
  if (!coverage.length) {
    errors.push("test plan has no machine-readable requirement coverage");
  }
  const known = new Map(
    requirements.map((requirement) => [requirement.id, requirement]),
  );
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
        errors.push(
          `${item.requirementId}: browser test does not navigate to the real app`,
        );
      }
      if (requirement.browserRequired && !test.interaction) {
        errors.push(
          `${item.requirementId}: browser test performs no real user interaction`,
        );
      }
      if (RELOAD.test(requirement.text) && !test.reload) {
        errors.push(
          `${item.requirementId}: persistence coverage requires page.reload()`,
        );
      }
    } else if (requirement.browserRequired) {
      errors.push(
        `${item.requirementId}: interactive UI requirement must use browser coverage`,
      );
    }
  }
  for (const requirement of requirements) {
    if (!coverage.some((item) => item.requirementId === requirement.id)) {
      errors.push(`${requirement.id}: acceptance requirement has no mapped test`);
    }
  }
  if (uiAcceptanceRequired && !coverage.some((item) => item.kind === "browser")) {
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
      errors.push(
        `${item.requirementId}: mapped test file did not produce valid direct runner evidence`,
      );
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
