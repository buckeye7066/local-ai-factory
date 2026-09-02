import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index]!;
    let candidate: string | undefined;
    if (word === "--root") {
      candidate = words[index + 1];
      index += 1;
    } else if (word.startsWith("--root=")) {
      candidate = word.slice("--root=".length);
    }
    if (candidate === undefined) continue;
    const normalized = normalizeSafeVitestRoot(candidate);
    if (!normalized || root !== undefined) return null;
    root = normalized;
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

type JavascriptToken = {
  kind: "identifier" | "string" | "literal" | "punctuation";
  value: string;
};

const REGEX_PREFIX_KEYWORDS = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

/**
 * Tokenize only the JavaScript surface needed to identify an actual runner.
 * Comments, fixture strings, template text, and regex literals never become
 * API tokens, so examples such as `"vi.mock()"` cannot override a real Jest
 * import. This is intentionally not a general JavaScript parser.
 */
function javascriptRunnerTokens(source: string): JavascriptToken[] {
  const tokens: JavascriptToken[] = [];
  let index = 0;
  let canStartRegex = true;
  const push = (token: JavascriptToken) => {
    tokens.push(token);
    if (token.kind === "identifier") {
      canStartRegex = REGEX_PREFIX_KEYWORDS.has(token.value);
    } else if (token.kind === "string" || token.kind === "literal") {
      canStartRegex = false;
    } else {
      canStartRegex = !/[\)\]\}]/.test(token.value);
    }
  };

  while (index < source.length) {
    const character = source[index]!;
    const next = source[index + 1];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === "/" && next === "/") {
      index += 2;
      while (index < source.length && !/[\r\n]/.test(source[index]!)) index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (
        index < source.length &&
        !(source[index] === "*" && source[index + 1] === "/")
      ) {
        index += 1;
      }
      index = Math.min(source.length, index + 2);
      continue;
    }
    if (character === '"' || character === "'") {
      const quote = character;
      let value = "";
      index += 1;
      while (index < source.length) {
        const current = source[index]!;
        if (current === "\\") {
          if (index + 1 < source.length) value += source[index + 1]!;
          index += 2;
          continue;
        }
        if (current === quote) {
          index += 1;
          break;
        }
        value += current;
        index += 1;
      }
      push({ kind: "string", value });
      continue;
    }
    if (character === "`") {
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2;
        } else if (source[index] === "`") {
          index += 1;
          break;
        } else {
          index += 1;
        }
      }
      push({ kind: "literal", value: "template" });
      continue;
    }
    if (character === "/" && canStartRegex) {
      let inCharacterClass = false;
      index += 1;
      while (index < source.length) {
        const current = source[index]!;
        if (current === "\\") {
          index += 2;
          continue;
        }
        if (current === "[") inCharacterClass = true;
        if (current === "]") inCharacterClass = false;
        index += 1;
        if (current === "/" && !inCharacterClass) break;
      }
      while (index < source.length && /[A-Za-z]/.test(source[index]!)) index += 1;
      push({ kind: "literal", value: "regex" });
      continue;
    }
    if (/[A-Za-z_$]/.test(character)) {
      const start = index;
      index += 1;
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index]!)) {
        index += 1;
      }
      push({ kind: "identifier", value: source.slice(start, index) });
      continue;
    }
    if (/[0-9]/.test(character)) {
      const start = index;
      index += 1;
      while (index < source.length && /[A-Za-z0-9_.]/.test(source[index]!)) {
        index += 1;
      }
      push({ kind: "literal", value: source.slice(start, index) });
      continue;
    }
    index += 1;
    push({ kind: "punctuation", value: character });
  }
  return tokens;
}

function runnerDeclaredByTest(contents: string): JavascriptRunner | "ambiguous" | null {
  const tokens = javascriptRunnerTokens(contents);
  const modules = new Set<string>();
  let vitestApi = false;
  let jestApi = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const previous = tokens[index - 1];
    const first = tokens[index + 1];
    const second = tokens[index + 2];
    if (
      token.kind === "identifier" &&
      (token.value === "require" || token.value === "import") &&
      previous?.value !== "." &&
      first?.value === "(" &&
      second?.kind === "string"
    ) {
      modules.add(second.value);
    }
    if (token.kind === "identifier" && token.value === "import") {
      if (first?.kind === "string") modules.add(first.value);
      for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
        const candidate = tokens[cursor]!;
        if (candidate.value === ";") break;
        if (
          candidate.kind === "identifier" &&
          candidate.value === "from" &&
          tokens[cursor + 1]?.kind === "string"
        ) {
          modules.add(tokens[cursor + 1]!.value);
          break;
        }
      }
    }
    if (
      token.kind === "identifier" &&
      previous?.value !== "." &&
      first?.value === "." &&
      second?.kind === "identifier" &&
      ["fn", "mock", "spyOn"].includes(second.value)
    ) {
      if (token.value === "vi") vitestApi = true;
      if (token.value === "jest") jestApi = true;
    }
  }
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
        "Vitest test script has a compound, absolute, traversing, or ambiguous root that cannot be contained to the candidate",
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
