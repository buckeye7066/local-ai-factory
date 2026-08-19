const JS_TEST =
  /(?:\.(?:test|spec)\.[cm]?[jt]sx?$)|(?:^|\/)__tests__\/[^/]+\.[cm]?[jt]sx?$/i;
const PYTHON_TEST =
  /(?:^|\/)test_[^/]+\.py$|(?:^|\/)[^/]+_test\.py$/i;

export function normalizeSafeRelativePath(raw: string): string | null {
  const path = raw.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (
    !path ||
    path.startsWith("/") ||
    /^[A-Za-z]:\//.test(path) ||
    path.split("/").some((part) => !part || part === "..")
  ) {
    return null;
  }
  return path;
}

export function normalizeTestPath(raw: string): string | null {
  const path = normalizeSafeRelativePath(raw);
  return path && (JS_TEST.test(path) || PYTHON_TEST.test(path)) ? path : null;
}

export function isTestFilePath(raw: string): boolean {
  return normalizeTestPath(raw) !== null;
}

export function isJavascriptTestPath(raw: string): boolean {
  const path = normalizeSafeRelativePath(raw);
  return Boolean(path && JS_TEST.test(path));
}

export function isPythonTestPath(raw: string): boolean {
  const path = normalizeSafeRelativePath(raw);
  return Boolean(path && PYTHON_TEST.test(path));
}
