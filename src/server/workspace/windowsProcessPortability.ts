import ts from "typescript";

export type WindowsProcessPortabilityIssue = {
  path: string;
  line: number;
  reason: string;
};

const JAVASCRIPT_OR_TYPESCRIPT = /\.[cm]?[jt]sx?$/i;
const WINDOWS_SCRIPT = /\.(?:cmd|bat)$/i;
const CHILD_PROCESS_MODULES = new Set(["child_process", "node:child_process"]);
const UTIL_MODULES = new Set(["util", "node:util"]);
const DIRECT_METHOD = /^(execFile|spawn)(?:Sync|Async)?$/;

function scriptKind(path: string): ts.ScriptKind {
  const lower = path.toLowerCase();
  if (lower.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (lower.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(lower)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function stringModule(node: ts.Expression | undefined): string | null {
  return node && ts.isStringLiteralLike(node) ? node.text : null;
}

function requireModule(expression: ts.Expression | undefined): string | null {
  if (!expression || !ts.isCallExpression(expression)) return null;
  if (
    !ts.isIdentifier(expression.expression) ||
    expression.expression.text !== "require"
  ) {
    return null;
  }
  return stringModule(expression.arguments[0]);
}

function importedName(element: ts.ImportSpecifier | ts.BindingElement): string {
  return (element.propertyName ?? element.name).getText();
}

function directMethod(name: string): string | null {
  return DIRECT_METHOD.test(name) ? name : null;
}

function expressionContainsWindowsScript(
  expression: ts.Expression,
  scriptVariables: ReadonlySet<string>,
): boolean {
  if (ts.isStringLiteralLike(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return WINDOWS_SCRIPT.test(expression.text);
  }
  if (ts.isIdentifier(expression) && scriptVariables.has(expression.text)) return true;

  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      WINDOWS_SCRIPT.test(node.text)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(expression);
  return found;
}

function hasShellTrue(call: ts.CallExpression): boolean {
  return call.arguments.some((argument) => {
    if (!ts.isObjectLiteralExpression(argument)) return false;
    return argument.properties.some(
      (property) =>
        ts.isPropertyAssignment(property) &&
        property.name.getText().replace(/^["']|["']$/g, "") === "shell" &&
        property.initializer.kind === ts.SyntaxKind.TrueKeyword,
    );
  });
}

function bindingMethods(
  name: ts.BindingName,
  addMethod: (local: string, method: string) => void,
): void {
  if (!ts.isObjectBindingPattern(name)) return;
  for (const element of name.elements) {
    if (!ts.isIdentifier(element.name)) continue;
    const method = directMethod(importedName(element));
    if (method) addMethod(element.name.text, method);
  }
}

/**
 * Node cannot directly execute Windows batch wrappers through execFile/spawn.
 * Resolve only real child_process bindings through the TypeScript AST, so
 * aliases are covered while comments, fixtures, and unrelated functions never
 * become false portability blockers.
 */
export function assessWindowsProcessPortability(
  files: Iterable<{ path: string; contents: string }>,
): WindowsProcessPortabilityIssue[] {
  const issues: WindowsProcessPortabilityIssue[] = [];
  for (const file of files) {
    if (!JAVASCRIPT_OR_TYPESCRIPT.test(file.path)) continue;
    const sourceFile = ts.createSourceFile(
      file.path,
      file.contents,
      ts.ScriptTarget.Latest,
      true,
      scriptKind(file.path),
    );
    const methods = new Map<string, string>();
    const namespaces = new Set<string>();
    const promisifyNames = new Set<string>();
    const scriptVariables = new Set<string>();
    const addMethod = (local: string, method: string) => methods.set(local, method);

    const collectBindings = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) {
        const module = stringModule(node.moduleSpecifier);
        const clause = node.importClause;
        if (clause && module && CHILD_PROCESS_MODULES.has(module)) {
          if (clause.name) namespaces.add(clause.name.text);
          const bindings = clause.namedBindings;
          if (bindings && ts.isNamespaceImport(bindings)) {
            namespaces.add(bindings.name.text);
          } else if (bindings) {
            for (const element of bindings.elements) {
              const method = directMethod(importedName(element));
              if (method) addMethod(element.name.text, method);
            }
          }
        }
        if (clause && module && UTIL_MODULES.has(module)) {
          const bindings = clause.namedBindings;
          if (bindings && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) {
              if (importedName(element) === "promisify") {
                promisifyNames.add(element.name.text);
              }
            }
          }
        }
      }

      if (ts.isVariableDeclaration(node) && node.initializer) {
        if (ts.isIdentifier(node.name)) {
          const required = requireModule(node.initializer);
          if (required && CHILD_PROCESS_MODULES.has(required)) {
            namespaces.add(node.name.text);
          }
          if (expressionContainsWindowsScript(node.initializer, scriptVariables)) {
            scriptVariables.add(node.name.text);
          }

          if (ts.isIdentifier(node.initializer)) {
            const method = methods.get(node.initializer.text);
            if (method) addMethod(node.name.text, method);
          } else if (ts.isPropertyAccessExpression(node.initializer)) {
            if (namespaces.has(node.initializer.expression.getText())) {
              const method = directMethod(node.initializer.name.text);
              if (method) addMethod(node.name.text, method);
            }
          } else if (
            ts.isCallExpression(node.initializer) &&
            ts.isIdentifier(node.initializer.expression) &&
            promisifyNames.has(node.initializer.expression.text)
          ) {
            const target = node.initializer.arguments[0];
            if (target && ts.isIdentifier(target)) {
              const method = methods.get(target.text);
              if (method) addMethod(node.name.text, method);
            }
          }
        } else {
          const required = requireModule(node.initializer);
          if (required && CHILD_PROCESS_MODULES.has(required)) {
            bindingMethods(node.name, addMethod);
          }
        }
      }
      ts.forEachChild(node, collectBindings);
    };
    collectBindings(sourceFile);

    const callMethod = (expression: ts.Expression): string | null => {
      if (ts.isIdentifier(expression)) return methods.get(expression.text) ?? null;
      if (!ts.isPropertyAccessExpression(expression)) return null;
      const method = directMethod(expression.name.text);
      if (!method) return null;
      if (namespaces.has(expression.expression.getText())) return method;
      const required = requireModule(expression.expression);
      return required && CHILD_PROCESS_MODULES.has(required) ? method : null;
    };

    const inspectCalls = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const method = callMethod(node.expression);
        const first = node.arguments[0];
        if (
          method &&
          first &&
          expressionContainsWindowsScript(first, scriptVariables) &&
          !hasShellTrue(node)
        ) {
          issues.push({
            path: file.path,
            line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
            reason:
              `${method} directly launches a Windows .cmd/.bat wrapper without shell: true. ` +
              "Node reports spawn EINVAL for this on Windows. Invoke a real executable such as process.execPath, use a shell-aware command API, or deliberately enable the shell for that invocation.",
          });
        }
      }
      ts.forEachChild(node, inspectCalls);
    };
    inspectCalls(sourceFile);
  }
  return issues;
}
