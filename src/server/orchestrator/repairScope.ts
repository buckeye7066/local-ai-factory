const PROTECTED_BUILD_FILES = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "requirements.txt",
  "requirements-dev.txt",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "pipfile",
  "pipfile.lock",
  "poetry.lock",
  "pytest.ini",
  "tox.ini",
  ".coveragerc",
  "go.mod",
  "go.sum",
  "cargo.toml",
  "cargo.lock",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "composer.json",
  "composer.lock",
]);

/** Files that product repair must treat as immutable verification evidence. */
export function isForbiddenRepairPath(path: string): boolean {
  const canonical = path.replace(/\\/g, "/");
  const base = canonical.split("/").pop()?.toLowerCase() ?? "";
  const testPath =
    /(^|\/)(?:__tests__|tests?|spec)(\/|$)/i.test(canonical) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(canonical) ||
    /(^|\/)test_[^/]+\.py$/i.test(canonical) ||
    /_test\.py$/i.test(canonical);
  const toolConfig =
    /(^|\/)(?:vitest|jest|playwright|vite)(?:\.[\w-]+)?\.config\.[cm]?[jt]s$/i.test(
      canonical,
    ) ||
    /(^|\/)(?:tsconfig(?:\.[\w-]+)?\.json|eslint\.config\.[cm]?[jt]s)$/i.test(
      canonical,
    );
  return testPath || PROTECTED_BUILD_FILES.has(base) || toolConfig;
}
