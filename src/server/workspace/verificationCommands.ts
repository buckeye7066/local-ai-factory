import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { normalizeSafeRelativePath, normalizeTestPath } from "./testPaths.js";

export interface VerificationCommand {
  bin: string;
  args: string[];
  isTest: boolean;
  /** Exact generated test selected by this engine-owned command. */
  directTestPath?: string;
  /** True only for a real browser-runner invocation. */
  isBrowser?: boolean;
  /** Known local runner whose structured output the engine parses. */
  runner?: "vitest" | "jest" | "playwright" | "pytest";
}

export interface VerificationPlan {
  commands: VerificationCommand[];
  incomplete: Array<{ command: string; reason: string }>;
}

export interface GeneratedVerificationTest {
  path: string;
  contents: string;
}

/**
 * Select every safe test file currently written by the run, regardless of
 * whether Builder or Test Writer authored it. The direct-evidence gate later
 * requires every one of these paths, so planning only Test Writer output makes
 * a Builder-authored passing test impossible to prove.
 */
export function generatedTestsForVerification(
  files: Iterable<GeneratedVerificationTest>,
): GeneratedVerificationTest[] {
  const tests = new Map<string, GeneratedVerificationTest>();
  for (const file of files) {
    const path = normalizeTestPath(file.path);
    if (!path) continue;
    tests.set(path, { path, contents: file.contents });
  }
  return [...tests.values()];
}

function exists(workspacePath: string, name: string): boolean {
  return existsSync(join(workspacePath, name));
}

function hasRootPython(workspacePath: string): boolean {
  try {
    return readdirSync(workspacePath, { withFileTypes: true }).some(
      (entry) => entry.isFile() && /\.(py|pyw)$/i.test(entry.name),
    );
  } catch {
    return false;
  }
}

function readPackage(workspacePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(
      readFileSync(join(workspacePath, "package.json"), "utf8"),
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
}

type PackageManager = "npm" | "pnpm" | "yarn";

interface PackageManagerResolution {
  manager: PackageManager | null;
  reason?: string;
}

/**
 * `packageManager` is authoritative when present. A compatibility lockfile
 * must not silently switch verification to another dependency graph. Without
 * a declaration, one lockfile is unambiguous; conflicting locks fail closed.
 */
function packageManagerResolution(workspacePath: string): PackageManagerResolution {
  const declared = readPackage(workspacePath)?.packageManager;
  if (typeof declared === "string" && declared.trim()) {
    const match = /^(npm|pnpm|yarn)@/i.exec(declared.trim());
    if (!match) {
      return {
        manager: null,
        reason: `unsupported declared packageManager: ${declared.trim()}`,
      };
    }
    return { manager: match[1]!.toLowerCase() as PackageManager };
  }

  const detected = new Set<PackageManager>();
  if (exists(workspacePath, "yarn.lock")) detected.add("yarn");
  if (exists(workspacePath, "pnpm-lock.yaml")) detected.add("pnpm");
  if (
    exists(workspacePath, "package-lock.json") ||
    exists(workspacePath, "npm-shrinkwrap.json")
  ) {
    detected.add("npm");
  }
  if (detected.size > 1) {
    return {
      manager: null,
      reason: `conflicting lockfiles (${[...detected].sort().join(", ")}) and no declared packageManager`,
    };
  }
  return { manager: [...detected][0] ?? "pnpm" };
}

function packageScriptCommand(
  manager: PackageManager,
  script: string,
): VerificationCommand {
  return {
    bin: manager,
    args: ["run", script],
    isTest: false,
  };
}

/**
 * Parse the deliberately small package-script subset whose runner and root we
 * can prove without invoking a shell. Expansions and compound commands are
 * rejected because their effective Vitest root cannot be known statically.
 */
function plainScriptWords(source: string): string[] | null {
  const words: string[] = [];
  let word = "";
  let quote: '"' | null = null;
  const finishWord = () => {
    if (word) words.push(word);
    word = "";
  };

  for (const character of source.trim()) {
    // A package script's CR/LF is a shell command boundary, not ordinary word
    // spacing. Reject it even after a backslash so containment is unambiguous.
    if (character === "\r" || character === "\n") return null;
    // This parser accepts only the intersection of POSIX and cmd.exe quoting.
    // In particular, a POSIX backslash does not escape &, |, or other command
    // separators on Windows, and single quotes are not cmd.exe quotes.
    if (character === "\\") {
      return null;
    }
    if (quote) {
      if (character === quote) quote = null;
      else if (/[;&|<>()$`%!^]/.test(character)) return null;
      else word += character;
      continue;
    }
    if (character === '"') {
      quote = '"';
      continue;
    }
    if (character === "'") return null;
    if (/\s/.test(character)) {
      finishWord();
      continue;
    }
    // Package-manager scripts run through a shell. An unquoted `#` starts a
    // comment on POSIX, which would discard an engine-appended `--root=.` and
    // let Vitest rediscover configuration above the candidate workspace.
    if (/[#;&|<>()$`%!^]/.test(character)) return null;
    word += character;
  }
  if (quote) return null;
  finishWord();
  return words.length > 0 ? words : null;
}

interface VitestScript {
  root: string;
  ownsRoot: boolean;
}

const SAFE_VITEST_FLAGS = new Set(["--coverage=false", "--passWithNoTests", "--run"]);
const SAFE_VITEST_PATH_OPTIONS = new Set(["--config", "--dir", "--root"]);

/** Canonicalize equivalent, contained Vitest root spellings. */
function normalizeSafeVitestRoot(raw: string): string | null {
  const slashed = raw.replace(/\\/g, "/");
  if (slashed.startsWith("/") || /^[A-Za-z]:/.test(slashed)) return null;
  const withoutPrefix = slashed.replace(/^\.\/+/, "");
  const withoutTrailingSlash = withoutPrefix.replace(/\/+$/, "");
  if (!withoutTrailingSlash || withoutTrailingSlash === ".") return ".";
  const normalized = normalizeSafeRelativePath(withoutTrailingSlash);
  if (!normalized) return null;
  const parts = normalized.split("/").filter((part) => part !== ".");
  return parts.join("/") || ".";
}

function runnerScriptWords(
  script: unknown,
  runner: "vitest" | "jest",
): string[] | null {
  if (typeof script !== "string") return null;
  const words = plainScriptWords(script);
  return words?.[0] === runner ? words : null;
}

function inspectVitestScript(script: unknown): VitestScript | null {
  const words = runnerScriptWords(script, "vitest");
  if (!words) return null;
  let root: string | undefined;
  const seenPathOptions = new Set<string>();
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index]!;
    if (index === 1 && word === "run") continue;
    if (SAFE_VITEST_FLAGS.has(word)) continue;

    const equals = word.indexOf("=");
    const option = equals < 0 ? word : word.slice(0, equals);
    if (!SAFE_VITEST_PATH_OPTIONS.has(option) || seenPathOptions.has(option)) {
      return null;
    }
    seenPathOptions.add(option);
    let candidate: string | undefined;
    if (equals < 0) {
      candidate = words[index + 1];
      index += 1;
    } else {
      candidate = word.slice(equals + 1);
    }
    if (!candidate || candidate.startsWith("-")) return null;
    const normalized = normalizeSafeVitestRoot(candidate);
    if (!normalized) return null;
    if (option === "--root") root = normalized;
  }
  return { root: root ?? ".", ownsRoot: root !== undefined };
}

function directVitestPath(path: string, root: string): string | null {
  if (root === ".") return path;
  const prefix = `${root}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

/**
 * A restored candidate can live below the Factory Deck checkout. Vitest's
 * config discovery must never escape that candidate and adopt an ancestor
 * `vitest.config.*`, so simple Vitest host scripts receive an explicit root.
 */
function packageTestCommand(
  manager: PackageManager,
  workspacePath: string,
): VerificationCommand {
  const scripts = readPackage(workspacePath)?.scripts;
  const testScript =
    scripts && typeof scripts === "object"
      ? (scripts as Record<string, unknown>).test
      : undefined;
  const vitest = inspectVitestScript(testScript);
  const pinCandidateRoot = Boolean(vitest && !vitest.ownsRoot);
  const args =
    pinCandidateRoot && manager === "npm"
      ? ["test", "--", "--root=."]
      : pinCandidateRoot && (manager === "pnpm" || manager === "yarn")
        ? ["test", "--root=."]
        : ["test"];
  return { bin: manager, args, isTest: true };
}

function javascriptCommands(
  workspacePath: string,
  resolution = packageManagerResolution(workspacePath),
): VerificationCommand[] {
  if (!exists(workspacePath, "package.json")) return [];
  if (!resolution.manager) return [];
  if (resolution.manager === "yarn") {
    return [
      { bin: "yarn", args: ["install"], isTest: false },
      packageTestCommand("yarn", workspacePath),
    ];
  }
  const prismaStep = hasPrismaSchema(workspacePath);
  if (resolution.manager === "npm") {
    return [
      { bin: "npm", args: ["ci"], isTest: false },
      { bin: "npm", args: ["rebuild"], isTest: false },
      ...(prismaStep
        ? [
            {
              bin: "npx",
              args: ["--no-install", "prisma", "generate"],
              isTest: false,
            },
          ]
        : []),
      packageTestCommand("npm", workspacePath),
    ];
  }
  return [
    { bin: "pnpm", args: ["install"], isTest: false },
    { bin: "pnpm", args: ["rebuild"], isTest: false },
    ...(prismaStep
      ? [
          {
            bin: "npx",
            args: ["--no-install", "prisma", "generate"],
            isTest: false,
          },
        ]
      : []),
    packageTestCommand("pnpm", workspacePath),
  ];
}

/** True when the repo (or a common workspace layout) ships a prisma schema. */
function hasPrismaSchema(workspacePath: string): boolean {
  return [
    "prisma/schema.prisma",
    "services/api/prisma/schema.prisma",
    "apps/api/prisma/schema.prisma",
    "packages/db/prisma/schema.prisma",
    "backend/prisma/schema.prisma",
    "server/prisma/schema.prisma",
  ].some((rel) => exists(workspacePath, rel));
}

const DIRECT_TEST_PATH = /^(?:[A-Za-z0-9_.-]+\/)*test_[A-Za-z0-9_.-]+\.py$/;

function workflowPythonTests(workspacePath: string): VerificationCommand[] {
  const workflowDir = join(workspacePath, ".github", "workflows");
  let workflowFiles: string[];
  try {
    workflowFiles = readdirSync(workflowDir)
      .filter((name) => /\.ya?ml$/i.test(name))
      .sort();
  } catch {
    return [];
  }

  const commands: VerificationCommand[] = [];
  const seen = new Set<string>();
  for (const workflowFile of workflowFiles) {
    let source: string;
    try {
      source = readFileSync(join(workflowDir, workflowFile), "utf8");
    } catch {
      continue;
    }
    for (const rawLine of source.split(/\r?\n/)) {
      const line = rawLine.trim();
      const match =
        /^(?:python|python3(?:\.\d+)?)\s+((?:\.\/)?(?:[A-Za-z0-9_.-]+\/)*test_[A-Za-z0-9_.-]+\.py)\s*$/.exec(
          line,
        );
      if (!match) continue;
      const testPath = match[1]!.replace(/^\.\//, "");
      if (!DIRECT_TEST_PATH.test(testPath)) continue;
      if (!existsSync(join(workspacePath, testPath))) continue;
      if (seen.has(testPath)) continue;
      seen.add(testPath);
      commands.push({ bin: "python", args: [testPath], isTest: true });
    }
  }
  return commands;
}

function pythonCommands(workspacePath: string): VerificationCommand[] {
  const isPython =
    exists(workspacePath, "pyproject.toml") ||
    exists(workspacePath, "requirements.txt") ||
    exists(workspacePath, "setup.py") ||
    exists(workspacePath, "setup.cfg") ||
    hasRootPython(workspacePath);
  if (!isPython) return [];

  const bin = "python";
  const commands: VerificationCommand[] = [];
  if (exists(workspacePath, "requirements.txt")) {
    commands.push({
      bin,
      args: [
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        "-r",
        "requirements.txt",
      ],
      isTest: false,
    });
  }
  commands.push({
    bin,
    args: ["-m", "compileall", "-q", "."],
    isTest: false,
  });
  const ciTests = workflowPythonTests(workspacePath);
  // Workflow-specific smoke commands may add coverage, but they can never
  // replace the full host pytest suite. Generated workflows are part of the
  // candidate patch and therefore cannot define their own verification gate.
  commands.push(...ciTests);
  commands.push({ bin, args: ["-m", "pytest", "-q"], isTest: true });
  return commands;
}

function dependencies(pkg: Record<string, unknown> | null): Set<string> {
  const out = new Set<string>();
  if (!pkg) return out;
  for (const key of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    const map = pkg[key];
    if (map && typeof map === "object") {
      for (const name of Object.keys(map as Record<string, unknown>)) out.add(name);
    }
  }
  return out;
}

type JavascriptRunner = "vitest" | "jest";

function runnerDeclaredByTest(contents: string): JavascriptRunner | "ambiguous" | null {
  const fileName = "generated-test.tsx";
  const compilerOptions: ts.CompilerOptions = {
    jsx: ts.JsxEmit.Preserve,
    module: ts.ModuleKind.ESNext,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
  };
  const parsedSource = ts.createSourceFile(
    fileName,
    contents,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const compilerHost = ts.createCompilerHost(compilerOptions, true);
  compilerHost.getSourceFile = (requested) =>
    requested === fileName ? parsedSource : undefined;
  compilerHost.fileExists = (requested) => requested === fileName;
  compilerHost.readFile = (requested) =>
    requested === fileName ? contents : undefined;
  compilerHost.writeFile = () => {};
  const program = ts.createProgram([fileName], compilerOptions, compilerHost);
  const source = program.getSourceFile(fileName) ?? parsedSource;
  const checker = program.getTypeChecker();
  const modules = new Set<string>();
  let vitestApi = false;
  let jestApi = false;
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const clause = node.importClause;
      const runtimeImport =
        !clause ||
        (!clause.isTypeOnly &&
          (Boolean(clause.name) ||
            !clause.namedBindings ||
            ts.isNamespaceImport(clause.namedBindings) ||
            clause.namedBindings.elements.some((element) => !element.isTypeOnly)));
      if (runtimeImport) modules.add(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      modules.add(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const argument = node.arguments[0]!;
      const directRequire =
        ts.isIdentifier(node.expression) && node.expression.text === "require";
      const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if ((directRequire || dynamicImport) && ts.isStringLiteralLike(argument)) {
        modules.add(argument.text);
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === "vi" || node.expression.text === "jest") &&
      // Imports already establish their runner through `modules`. API syntax
      // is evidence only for an unshadowed runner global; a local parameter,
      // variable, or import named `vi`/`jest` is ordinary candidate code.
      !checker.getSymbolAtLocation(node.expression)
    ) {
      if (node.expression.text === "vi") vitestApi = true;
      if (node.expression.text === "jest") jestApi = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const vitest = modules.has("vitest") || vitestApi;
  const jest = modules.has("@jest/globals") || jestApi;
  if (vitest && jest) return "ambiguous";
  return vitest ? "vitest" : jest ? "jest" : null;
}

function hasPlaywrightConfig(workspacePath: string): boolean {
  return ["js", "cjs", "mjs", "ts", "cts", "mts"].some((ext) =>
    exists(workspacePath, `playwright.config.${ext}`),
  );
}

/**
 * Baseline trust signal. The orchestrator captures this before generated writes;
 * an extend run may not self-author the harness used to prove its own UI.
 */
export function hasPlaywrightHarness(workspacePath: string): boolean {
  const deps = dependencies(readPackage(workspacePath));
  return (
    (deps.has("@playwright/test") || deps.has("playwright")) &&
    hasPlaywrightConfig(workspacePath)
  );
}

/**
 * Full verification contract used by the orchestrator. Existing setup/host
 * checks remain, but each generated test is also selected directly by a known
 * local runner. Missing runners/harnesses are explicit incomplete evidence.
 */
export function verificationPlanForWorkspace(
  workspacePath: string,
  input: {
    generatedTests?: GeneratedVerificationTest[];
    uiAcceptanceRequired?: boolean;
    /** Captured before builder writes. False prevents a self-authored harness. */
    trustedBrowserHarness?: boolean;
  } = {},
): VerificationPlan {
  const managerResolution = packageManagerResolution(workspacePath);
  const base = [
    ...javascriptCommands(workspacePath, managerResolution),
    ...pythonCommands(workspacePath),
  ];
  const incomplete: VerificationPlan["incomplete"] = [];
  const packageJson = readPackage(workspacePath);
  const deps = dependencies(packageJson);
  const scripts =
    packageJson?.scripts && typeof packageJson.scripts === "object"
      ? (packageJson.scripts as Record<string, unknown>)
      : {};
  const testScriptText = typeof scripts.test === "string" ? scripts.test.trim() : "";
  const vitestScript = inspectVitestScript(scripts.test);
  if (exists(workspacePath, "package.json") && !managerResolution.manager) {
    incomplete.push({
      command: "package manager",
      reason: managerResolution.reason ?? "package manager could not be resolved",
    });
  }
  if (/^vitest(?:\s|$)/i.test(testScriptText) && !vitestScript) {
    incomplete.push({
      command: "host tests",
      reason:
        "Vitest test script has compound, unsupported, absolute, traversing, or ambiguous options that cannot be contained to the candidate",
    });
  }
  const quality = ["lint", "typecheck", "build"]
    .filter((name) => typeof scripts[name] === "string")
    .flatMap((name) =>
      managerResolution.manager
        ? [packageScriptCommand(managerResolution.manager, name)]
        : [],
    );
  const direct: VerificationCommand[] = [];
  const browserHarness =
    input.trustedBrowserHarness ?? hasPlaywrightHarness(workspacePath);
  const jestScript = runnerScriptWords(scripts.test, "jest");
  const vitestAvailable = deps.has("vitest") || Boolean(vitestScript);
  const jestAvailable = deps.has("jest") || Boolean(jestScript);

  for (const generated of input.generatedTests ?? []) {
    const path = normalizeTestPath(generated.path);
    if (!path) {
      incomplete.push({
        command: generated.path,
        reason: "generated test path is not a safe supported relative path",
      });
      continue;
    }
    const browser =
      /from\s+["']@playwright\/test["']|require\(["']@playwright\/test["']\)/.test(
        generated.contents,
      );
    if (browser) {
      if (!browserHarness) {
        incomplete.push({
          command: path,
          reason:
            "generated browser test has no trusted pre-build Playwright dependency and config",
        });
        continue;
      }
      direct.push({
        bin: "npx",
        args: ["--no-install", "playwright", "test", path, "--reporter=json"],
        isTest: true,
        isBrowser: true,
        runner: "playwright",
        directTestPath: path,
      });
      continue;
    }
    if (/\.py$/i.test(path)) {
      direct.push({
        bin: "python",
        args: ["-m", "pytest", "-vv", path],
        isTest: true,
        runner: "pytest",
        directTestPath: path,
      });
      continue;
    }
    const declaredRunner = runnerDeclaredByTest(generated.contents);
    let runner: JavascriptRunner | null = null;
    if (declaredRunner === "ambiguous") {
      incomplete.push({
        command: path,
        reason: "generated test mixes explicit Vitest and Jest APIs",
      });
      continue;
    }
    if (declaredRunner === "vitest") {
      if (!vitestAvailable) {
        incomplete.push({
          command: path,
          reason:
            "generated test explicitly requires Vitest, but no local Vitest runner is declared",
        });
        continue;
      }
      runner = "vitest";
    } else if (declaredRunner === "jest") {
      if (!jestAvailable) {
        incomplete.push({
          command: path,
          reason:
            "generated test explicitly requires Jest, but no local Jest runner is declared",
        });
        continue;
      }
      runner = "jest";
    } else if (vitestAvailable && !jestAvailable) {
      runner = "vitest";
    } else if (jestAvailable && !vitestAvailable) {
      runner = "jest";
    } else if (vitestAvailable && jestAvailable && vitestScript && !jestScript) {
      runner = "vitest";
    } else if (vitestAvailable && jestAvailable && jestScript && !vitestScript) {
      runner = "jest";
    }

    if (runner === "vitest") {
      const root = vitestScript?.root ?? ".";
      const testPath = directVitestPath(path, root);
      if (!testPath) {
        incomplete.push({
          command: path,
          reason: `generated Vitest test is outside the candidate-owned root ${root}`,
        });
        continue;
      }
      direct.push({
        bin: "npx",
        args: [
          "--no-install",
          "vitest",
          "run",
          testPath,
          "--reporter=json",
          `--root=${root}`,
        ],
        isTest: true,
        runner: "vitest",
        directTestPath: path,
      });
    } else if (runner === "jest") {
      direct.push({
        bin: "npx",
        args: ["--no-install", "jest", "--runTestsByPath", path, "--json"],
        isTest: true,
        runner: "jest",
        directTestPath: path,
      });
    } else {
      incomplete.push({
        command: path,
        reason:
          vitestAvailable && jestAvailable
            ? "both Vitest and Jest are declared, but this generated test has no unambiguous runner identity"
            : "no declared local Vitest/Jest/Pytest runner can execute this generated test directly",
      });
    }
  }

  if (input.uiAcceptanceRequired && !direct.some((cmd) => cmd.isBrowser)) {
    incomplete.push({
      command: "browser acceptance",
      reason:
        "interactive UI changed but no executable generated Playwright journey is available",
    });
  }
  if (input.uiAcceptanceRequired && typeof scripts.build !== "string") {
    incomplete.push({
      command: "build",
      reason: "interactive UI changed but the host declares no build script",
    });
  }
  if (!base.some((command) => command.isTest)) {
    incomplete.push({
      command: "host tests",
      reason: "no supported host test command is available",
    });
  }

  const setup = base.filter((command) => !command.isTest);
  const browserSetup: VerificationCommand[] = direct.some(
    (command) => command.isBrowser,
  )
    ? [
        {
          bin: "npx",
          args: ["--no-install", "playwright", "install", "chromium"],
          isTest: false,
        },
      ]
    : [];
  const hostTests = base.filter((command) => command.isTest);
  return {
    commands: [...setup, ...quality, ...browserSetup, ...direct, ...hostTests],
    incomplete,
  };
}

/** Backward-compatible base planner used by existing callers/tests. */
export function verificationCommandsForWorkspace(
  workspacePath: string,
): VerificationCommand[] {
  return [...javascriptCommands(workspacePath), ...pythonCommands(workspacePath)];
}
