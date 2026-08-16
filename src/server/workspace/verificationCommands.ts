import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface VerificationCommand {
  bin: string;
  args: string[];
  isTest: boolean;
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

function javascriptCommands(workspacePath: string): VerificationCommand[] {
  if (!exists(workspacePath, "package.json")) return [];
  if (exists(workspacePath, "yarn.lock")) {
    return [
      { bin: "yarn", args: ["install"], isTest: false },
      { bin: "yarn", args: ["test"], isTest: true },
    ];
  }
  // REBUILD AFTER INSTALL — the skipped-native-scripts class (measured twice).
  // Modern package managers skip dependency install scripts by default as a
  // supply-chain posture: npm 11.17 ships `allow-scripts` pinned to an EMPTY
  // allowlist, and pnpm v9 skips build scripts for unapproved packages. A
  // fresh install in an isolated workspace therefore leaves native modules
  // (better-sqlite3) with NO compiled binding, and every downstream test that
  // touches the database fails with "Could not locate the bindings file".
  // That is exactly what killed GrantFlow run d687f5fd (2026-08-15): npm ci
  // exit 0 → 20 auth-test failures + a 1080s hang, three paid repair loops
  // patching innocent files, and a final review that mis-blamed the Node
  // version. `rebuild` compiles the already-installed packages' native code
  // (it executes even for packages the allowlist has not approved — verified
  // live in that workspace: the warning prints, the binding builds, the auth
  // suite goes green) and is an idempotent no-op when nothing needs building.
  // PRISMA CLIENT — the same skipped-scripts class, one layer up. A repo with
  // a prisma schema generates its client in a postinstall hook; with install
  // scripts skipped the client never materializes and every test that imports
  // it dies with "@prisma/client did not initialize yet". SermonSmith slice
  // 40c4c51d burned three repair loops on exactly that (2026-08-16).
  // `prisma generate` is idempotent and a no-op when the client is current.
  const prismaStep = hasPrismaSchema(workspacePath);
  if (
    exists(workspacePath, "package-lock.json") ||
    exists(workspacePath, "npm-shrinkwrap.json")
  ) {
    return [
      { bin: "npm", args: ["ci"], isTest: false },
      { bin: "npm", args: ["rebuild"], isTest: false },
      ...(prismaStep ? [{ bin: "npx", args: ["prisma", "generate"], isTest: false }] : []),
      { bin: "npm", args: ["test"], isTest: true },
    ];
  }
  return [
    { bin: "pnpm", args: ["install"], isTest: false },
    { bin: "pnpm", args: ["rebuild"], isTest: false },
    ...(prismaStep ? [{ bin: "npx", args: ["prisma", "generate"], isTest: false }] : []),
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

  // setup-python and standard Windows installs both expose "python". Keeping
  // selection deterministic also lets the command sandbox resolve the binary
  // from trusted PATH entries instead of accepting a workspace-supplied shim.
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

  // Some mature Python repositories intentionally run script-style regression
  // programs from Actions. Global pytest collection can execute diagnostics
  // that were never written as pytest tests (for example, camera probes that
  // exit when hardware is absent). Reuse the repository's explicit CI tests
  // when present; otherwise retain the conventional pytest fallback.
  const ciTests = workflowPythonTests(workspacePath);
  commands.push(
    ...(ciTests.length
      ? ciTests
      : [{ bin, args: ["-m", "pytest", "-q"], isTest: true }]),
  );
  return commands;
}

/**
 * Derive deterministic verification commands from manifests already present
 * in the generated/ingested workspace. This prevents Factory Deck from running
 * pnpm against every repository regardless of its actual language.
 *
 * Polyglot repositories run both supported plans. Unknown stacks return an
 * empty plan and are reported honestly by the orchestrator.
 */
export function verificationCommandsForWorkspace(
  workspacePath: string,
): VerificationCommand[] {
  return [
    ...javascriptCommands(workspacePath),
    ...pythonCommands(workspacePath),
  ];
}
