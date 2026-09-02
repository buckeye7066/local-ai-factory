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

function unwrapTransparent(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function stringModule(node: ts.Expression | undefined): string | null {
  if (!node) return null;
  const value = unwrapTransparent(node);
  return ts.isStringLiteralLike(value) ? value.text : null;
}

function requireModule(expression: ts.Expression | undefined): string | null {
  if (!expression) return null;
  const value = unwrapTransparent(expression);
  if (!ts.isCallExpression(value)) return null;
  if (!ts.isIdentifier(value.expression) || value.expression.text !== "require") {
    return null;
  }
  return stringModule(value.arguments[0]);
}

function importedName(element: ts.ImportSpecifier | ts.BindingElement): string {
  return (element.propertyName ?? element.name).getText();
}

function directMethod(name: string): string | null {
  return DIRECT_METHOD.test(name) ? name : null;
}

function bindingIdentifiers(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingIdentifiers(element.name),
  );
}

function nearestAncestor(
  node: ts.Node,
  predicate: (candidate: ts.Node) => boolean,
): ts.Node | null {
  for (let current = node.parent; current; current = current.parent) {
    if (predicate(current)) return current;
  }
  return null;
}

function lexicalScopeFor(declaration: ts.Node): ts.Node | null {
  return nearestAncestor(
    declaration,
    (node) =>
      ts.isBlock(node) ||
      ts.isSourceFile(node) ||
      ts.isCaseBlock(node) ||
      ts.isCatchClause(node),
  );
}

function functionScopeFor(declaration: ts.Node): ts.Node | null {
  return nearestAncestor(
    declaration,
    (node) => ts.isFunctionLike(node) || ts.isSourceFile(node),
  );
}

function registerLexicalBindings(
  sourceFile: ts.SourceFile,
): Map<ts.Node, Map<string, ts.Identifier[]>> {
  const scopes = new Map<ts.Node, Map<string, ts.Identifier[]>>();
  const add = (scope: ts.Node | null, identifier: ts.Identifier) => {
    if (!scope) return;
    let names = scopes.get(scope);
    if (!names) {
      names = new Map();
      scopes.set(scope, names);
    }
    const declarations = names.get(identifier.text) ?? [];
    declarations.push(identifier);
    names.set(identifier.text, declarations);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && node.importClause) {
      const clause = node.importClause;
      if (clause.name) add(sourceFile, clause.name);
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        add(sourceFile, bindings.name);
      } else if (bindings) {
        for (const element of bindings.elements) add(sourceFile, element.name);
      }
    } else if (ts.isParameter(node)) {
      const scope = nearestAncestor(node, ts.isFunctionLike);
      for (const identifier of bindingIdentifiers(node.name)) add(scope, identifier);
    } else if (ts.isVariableDeclaration(node)) {
      const list = ts.isVariableDeclarationList(node.parent) ? node.parent : null;
      const blockScoped = Boolean(list && list.flags & ts.NodeFlags.BlockScoped);
      const scope = blockScoped
        ? lexicalScopeFor(node)
        : functionScopeFor(node);
      for (const identifier of bindingIdentifiers(node.name)) add(scope, identifier);
    } else if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name
    ) {
      add(lexicalScopeFor(node), node.name);
    } else if (ts.isCatchClause(node) && node.variableDeclaration) {
      for (const identifier of bindingIdentifiers(node.variableDeclaration.name)) {
        add(node, identifier);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return scopes;
}

function resolveBinding(
  use: ts.Identifier,
  scopes: ReadonlyMap<ts.Node, ReadonlyMap<string, readonly ts.Identifier[]>>,
): ts.Identifier | null {
  for (let current: ts.Node | undefined = use.parent; current; current = current.parent) {
    const declarations = scopes.get(current)?.get(use.text);
    if (declarations?.length) return declarations[0]!;
  }
  return null;
}

function hasShellTrue(call: ts.CallExpression): boolean {
  return call.arguments.some((argument) => {
    const value = unwrapTransparent(argument);
    if (!ts.isObjectLiteralExpression(value)) return false;
    return value.properties.some((property) => {
      if (!ts.isPropertyAssignment(property)) return false;
      const name = property.name.getText().replace(/^["']|["']$/g, "");
      return (
        name === "shell" &&
        unwrapTransparent(property.initializer).kind === ts.SyntaxKind.TrueKeyword
      );
    });
  });
}

/**
 * Node cannot directly execute Windows batch wrappers through execFile/spawn.
 * Resolve real child_process bindings through lexical AST scopes, so aliases
 * are covered while comments, fixtures, and shadowed same-named functions
 * never become false portability blockers.
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
    const scopes = registerLexicalBindings(sourceFile);
    const methodBindings = new Map<ts.Identifier, string>();
    const namespaceBindings = new Set<ts.Identifier>();
    const promisifyBindings = new Set<ts.Identifier>();
    const scriptBindings = new Set<ts.Identifier>();

    const bindingFor = (identifier: ts.Identifier): ts.Identifier | null =>
      resolveBinding(identifier, scopes);

    const methodFromExpression = (expression: ts.Expression): string | null => {
      const value = unwrapTransparent(expression);
      if (ts.isIdentifier(value)) {
        const binding = bindingFor(value);
        return binding ? (methodBindings.get(binding) ?? null) : null;
      }
      if (!ts.isPropertyAccessExpression(value)) return null;
      const method = directMethod(value.name.text);
      if (!method) return null;
      const receiver = unwrapTransparent(value.expression);
      if (ts.isIdentifier(receiver)) {
        const binding = bindingFor(receiver);
        if (binding && namespaceBindings.has(binding)) return method;
      }
      const required = requireModule(receiver);
      return required && CHILD_PROCESS_MODULES.has(required) ? method : null;
    };

    const expressionContainsWindowsScript = (expression: ts.Expression): boolean => {
      let found = false;
      const visit = (node: ts.Node): void => {
        if (found) return;
        if (
          (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) &&
          WINDOWS_SCRIPT.test(node.text)
        ) {
          found = true;
          return;
        }
        if (ts.isIdentifier(node)) {
          const binding = bindingFor(node);
          if (binding && scriptBindings.has(binding)) {
            found = true;
            return;
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(unwrapTransparent(expression));
      return found;
    };

    const collectSemantics = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && node.importClause) {
        const module = stringModule(node.moduleSpecifier);
        const clause = node.importClause;
        if (module && CHILD_PROCESS_MODULES.has(module)) {
          if (clause.name) namespaceBindings.add(clause.name);
          const bindings = clause.namedBindings;
          if (bindings && ts.isNamespaceImport(bindings)) {
            namespaceBindings.add(bindings.name);
          } else if (bindings) {
            for (const element of bindings.elements) {
              const method = directMethod(importedName(element));
              if (method) methodBindings.set(element.name, method);
            }
          }
        }
        if (module && UTIL_MODULES.has(module)) {
          const bindings = clause.namedBindings;
          if (bindings && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) {
              if (importedName(element) === "promisify") {
                promisifyBindings.add(element.name);
              }
            }
          }
        }
      }

      if (ts.isVariableDeclaration(node) && node.initializer) {
        if (ts.isIdentifier(node.name)) {
          const binding = node.name;
          const required = requireModule(node.initializer);
          if (required && CHILD_PROCESS_MODULES.has(required)) {
            namespaceBindings.add(binding);
          }

          const direct = methodFromExpression(node.initializer);
          if (direct) methodBindings.set(binding, direct);

          const initializer = unwrapTransparent(node.initializer);
          if (ts.isCallExpression(initializer)) {
            const callee = unwrapTransparent(initializer.expression);
            if (ts.isIdentifier(callee)) {
              const promisifyBinding = bindingFor(callee);
              if (promisifyBinding && promisifyBindings.has(promisifyBinding)) {
                const target = initializer.arguments[0];
                if (target) {
                  const method = methodFromExpression(target);
                  if (method) methodBindings.set(binding, method);
                }
              }
            }
          }

          if (expressionContainsWindowsScript(node.initializer)) {
            scriptBindings.add(binding);
          }
        } else {
          const required = requireModule(node.initializer);
          if (required && CHILD_PROCESS_MODULES.has(required)) {
            for (const element of node.name.elements) {
              if (ts.isOmittedExpression(element) || !ts.isIdentifier(element.name)) {
                continue;
              }
              const method = directMethod(importedName(element));
              if (method) methodBindings.set(element.name, method);
            }
          }
        }
      }
      ts.forEachChild(node, collectSemantics);
    };
    collectSemantics(sourceFile);

    const inspectCalls = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const method = methodFromExpression(node.expression);
        const first = node.arguments[0];
        if (
          method &&
          first &&
          expressionContainsWindowsScript(first) &&
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
