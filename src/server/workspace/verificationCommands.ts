import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface VerificationCommand {
  bin: string;
  args: string[];
  isTest: boolean;
  /** Exact generated test selected by this engine-owned command. */
  directTestPath?: string;
  /** True only for a real browser-runner invocation. */
  isBrowser?: boolean;
}

export interface VerificationPlan {
  commands: VerificationCommand[];
  incomplete: Array<{ command: string; reason: string }>;
}

export interface GeneratedVerificationTest {
  path: string;
  contents: string;
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

function packageManager(workspacePath: string): PackageManager {
  if (exists(workspacePath, "yarn.lock")) return "yarn";
  if (
    exists(workspacePath, "package-lock.json") ||
    exists(workspacePath, "npm-shrinkwrap.json")
  ) {
    return "npm";
  }
  return "pnpm";
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

function javascriptCommands(workspacePath: string): VerificationCommand[] {
  if (!exists(workspacePath, "package.json")) return [];
  if (exists(workspacePath, "yarn.lock")) {
    return [
      { bin: "yarn", args: ["install"], isTest: false },
      { bin: "yarn", args: ["test"], isTest: true },
    ];
  }
  const prismaStep = hasPrismaSchema(workspacePath);
  if (
    exists(workspacePath, "package-lock.json") ||
    exists(workspacePath, "npm-shrinkwrap.json")
  ) {
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
      { bin: "npm", args: ["test"], isTest: true },
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
    { bin: "pnpm", args: ["test"], isTest: true },
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

const DIRECT_TEST_PATH =
  /^(?:[A-Za-z0-9_.-]+\/)*test_[A-Za-z0-9_.-]+\.py$/;

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
  commands.push(
    ...(ciTests.length
      ? ciTests
      : [{ bin, args: ["-m", "pytest", "-q"], isTest: true }]),
  );
  return commands;
}

function normalizedTestPath(raw: string): string | null {
  const path = raw.replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    !path ||
    path.startsWith("/") ||
    path.split("/").includes("..") ||
    !/(?:\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]+\.py$|_test\.py$)/i.test(
      path,
    )
  ) {
    return null;
  }
  return path;
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

function hasPlaywrightConfig(workspacePath: string): boolean {
  return ["js", "cjs", "mjs", "ts", "cts", "mts"].some((ext) =>
    exists(workspacePath, `playwright.config.${ext}`),
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
  } = {},
): VerificationPlan {
  const base = [
    ...javascriptCommands(workspacePath),
    ...pythonCommands(workspacePath),
  ];
  const incomplete: VerificationPlan["incomplete"] = [];
  const packageJson = readPackage(workspacePath);
  const deps = dependencies(packageJson);
  const scripts =
    packageJson?.scripts && typeof packageJson.scripts === "object"
      ? (packageJson.scripts as Record<string, unknown>)
      : {};
  const manager = packageManager(workspacePath);
  const quality = ["lint", "typecheck", "build"]
    .filter((name) => typeof scripts[name] === "string")
    .map((name) => packageScriptCommand(manager, name));
  const direct: VerificationCommand[] = [];
  const browserHarness =
    (deps.has("@playwright/test") || deps.has("playwright")) &&
    hasPlaywrightConfig(workspacePath);

  for (const generated of input.generatedTests ?? []) {
    const path = normalizedTestPath(generated.path);
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
            "generated browser test has no declared Playwright dependency and tracked root config",
        });
        continue;
      }
      direct.push({
        bin: "npx",
        args: ["--no-install", "playwright", "test", path, "--reporter=json"],
        isTest: true,
        isBrowser: true,
        directTestPath: path,
      });
      continue;
    }
    if (/\.py$/i.test(path)) {
      direct.push({
        bin: "python",
        args: ["-m", "pytest", "-q", path],
        isTest: true,
        directTestPath: path,
      });
      continue;
    }
    if (deps.has("vitest") || String(scripts.test ?? "").includes("vitest")) {
      direct.push({
        bin: "npx",
        args: ["--no-install", "vitest", "run", path],
        isTest: true,
        directTestPath: path,
      });
    } else if (deps.has("jest") || String(scripts.test ?? "").includes("jest")) {
      direct.push({
        bin: "npx",
        args: ["--no-install", "jest", "--runInBand", path],
        isTest: true,
        directTestPath: path,
      });
    } else {
      incomplete.push({
        command: path,
        reason: "no declared local Vitest/Jest/Pytest runner can execute this generated test directly",
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
  const hostTests = base.filter((command) => command.isTest);
  return {
    commands: [...setup, ...quality, ...direct, ...hostTests],
    incomplete,
  };
}

/** Backward-compatible base planner used by existing callers/tests. */
export function verificationCommandsForWorkspace(
  workspacePath: string,
): VerificationCommand[] {
  return [
    ...javascriptCommands(workspacePath),
    ...pythonCommands(workspacePath),
  ];
}
