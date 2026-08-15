import { existsSync, readdirSync } from "node:fs";
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
  if (
    exists(workspacePath, "package-lock.json") ||
    exists(workspacePath, "npm-shrinkwrap.json")
  ) {
    return [
      { bin: "npm", args: ["ci"], isTest: false },
      { bin: "npm", args: ["test"], isTest: true },
    ];
  }
  return [
    { bin: "pnpm", args: ["install"], isTest: false },
    { bin: "pnpm", args: ["test"], isTest: true },
  ];
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
  commands.push({ bin, args: ["-m", "pytest", "-q"], isTest: true });
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
