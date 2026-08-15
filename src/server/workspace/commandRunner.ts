import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, relative, isAbsolute, join, delimiter } from "node:path";

/**
 * commandRunner.ts — conservative command execution for UNTRUSTED generated
 * projects.
 *
 * SECURITY BOUNDARY (defense-in-depth — no single flag opens all holes):
 *  - ALLOWLIST: only specific package-manager subcommands may run, and only
 *    inside a workspace directory (never the project root).
 *  - SCRIPT GATE: any allowlisted command is refused unless
 *    `allowScriptExecution` is enabled — including dependency installs. The
 *    server enables it by default (real execution is the product default,
 *    owner order 2026-08-13; dry-run mode was removed the same day); hermetic
 *    tests leave it off so they never spawn package managers. An install is
 *    NOT safe by itself: a generated `.pnpmfile.cjs` runs project-controlled
 *    code during resolution, and `--ignore-scripts` does NOT disable it. So
 *    installs are gated with everything else, and when executed they
 *    additionally get `--ignore-scripts` + (for pnpm) `--ignore-pnpmfile`.
 *  - NO SHELL INJECTION: callers pass an argv array; POSIX uses no shell, and on
 *    Windows every token is validated against a strict character allowlist.
 *  - NO PM SHADOWING: the package-manager binary is resolved to an ABSOLUTE path
 *    from PATH entries OUTSIDE the workspace, so a planted `pnpm.cmd` in the
 *    generated project can never be executed via cwd/PATH resolution.
 *  - NO INHERITED SECRETS: the child env is rebuilt from an ALLOWLIST of safe
 *    variable names (so credential-bearing vars like DATABASE_URL / MONGODB_URI,
 *    whose names contain no secret keyword, are dropped), any credential-URL
 *    value is redacted, and workspace dirs are stripped from PATH.
 *  - NO LIFECYCLE SCRIPTS: install/ci get `--ignore-scripts` injected, and pnpm
 *    installs also get `--ignore-pnpmfile` so a generated `.pnpmfile.cjs` in the
 *    workspace is never loaded. DELIBERATE EXCEPTION (2026-08-15): `rebuild`
 *    runs the native build hooks of ALREADY-LOCKED registry dependencies —
 *    without it, every repo with a native module (better-sqlite3) fails
 *    verification structurally: GrantFlow run d687f5fd installed with skipped
 *    scripts, got no compiled binding, failed 20 auth tests + a 1080s hang,
 *    and burned three paid repair loops on a misdiagnosis. A guardrail that
 *    makes verification impossible for native-dep repos breaks the product's
 *    purpose; rebuild's exposure is bounded to lockfile packages' own gyp
 *    builds (no `.pnpmfile.cjs`, no arbitrary workspace scripts).
 *
 * NOTE: `isInsideWorkspace` is a cwd BOUNDARY check, not a runtime filesystem
 * sandbox — a script that is actually executed can still read/write outside the
 * workspace via absolute or `../` paths. True containment requires an OS
 * sandbox and is out of scope for this module.
 */

/** (binary, firstArg) pairs that are permitted. */
const ALLOWLIST: ReadonlyArray<readonly [string, string]> = [
  ["npm", "install"],
  ["npm", "ci"],
  ["npm", "run"],
  ["npm", "test"],
  // `rebuild` compiles ALREADY-INSTALLED dependencies' native code (the
  // skipped-install-scripts class: npm 11.17 allow-scripts / pnpm v9 leave
  // better-sqlite3 with no binding after a clean install — GrantFlow run
  // d687f5fd). It executes only package install scripts the install itself
  // would have run, against the locked tree — no new code enters.
  ["npm", "rebuild"],
  ["pnpm", "install"],
  ["pnpm", "run"],
  ["pnpm", "test"],
  ["pnpm", "build"],
  ["pnpm", "typecheck"],
  ["pnpm", "rebuild"],
  ["yarn", "install"],
  ["yarn", "test"],
  ["npx", "tsc"],
];

/** Python entrypoints Factory Deck itself may schedule for verification. */
const PYTHON_BINS = new Set(["python", "python3"]);
const PYTHON_CHECK_MODULES = new Set(["compileall", "pytest", "unittest"]);

const DIRECT_PYTHON_TEST =
  /^(?:[A-Za-z0-9_.-]+\/)*test_[A-Za-z0-9_.-]+\.py$/;

function isSafeDirectPythonTest(arg: string): boolean {
  const normalized = arg.replace(/\\/g, "/");
  return (
    !normalized.startsWith("/") &&
    !normalized.split("/").includes("..") &&
    DIRECT_PYTHON_TEST.test(normalized)
  );
}

function isAllowedPython(args: string[]): boolean {
  if (args.length === 1 && isSafeDirectPythonTest(args[0]!)) return true;
  if (args[0] !== "-m") return false;
  const module = args[1] ?? "";
  if (PYTHON_CHECK_MODULES.has(module)) return true;
  // Dependency installation is deliberately narrow: only a requirements file
  // in the workspace, with pip's version check disabled. The script-execution
  // approval gate still applies because Python packages may execute build hooks.
  return (
    module === "pip" &&
    args.length === 6 &&
    args[2] === "install" &&
    args[3] === "--disable-pip-version-check" &&
    args[4] === "-r" &&
    args[5] === "requirements.txt"
  );
}

export interface CommandRequest {
  bin: string;
  args: string[];
  /** Absolute path to the workspace this command runs in. */
  cwd: string;
}

export interface CommandResult {
  command: string;
  allowed: boolean;
  executed: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  reason?: string;
}

export function isAllowed(bin: string, args: string[]): boolean {
  if (PYTHON_BINS.has(bin)) return isAllowedPython(args);
  const first = args[0] ?? "";
  return ALLOWLIST.some(([b, a]) => b === bin && a === first);
}

/**
 * True when a command runs code the untrusted generated project controls — which
 * every allowlisted command does, so this is now unconditionally true:
 *  - `run`/`test`/`build`/`typecheck`/`npx <bin>` execute package scripts/binaries;
 *  - `install`/`ci` execute a project-controlled `.pnpmfile.cjs` during resolution
 *    (pnpm), which `--ignore-scripts` does NOT disable.
 * Because none of these are safe without approval, the gate applies to all of
 * them (fail closed). Kept as a function so the approval gate and tests have a
 * single, explicit predicate.
 */
export function isScriptExecuting(_bin: string, _args: string[]): boolean {
  return true;
}

/**
 * Windows can only execute .cmd shims (pnpm/npm/yarn/npx) through cmd.exe.
 * We validate every argv token against a strict character allowlist so no shell
 * metacharacter can ever reach cmd.exe (we spawn cmd with verbatim args).
 */
const SAFE_ARG = /^[A-Za-z0-9._:@\/=-]+$/;

export function argsAreShellSafe(bin: string, args: string[]): boolean {
  return [bin, ...args].every((a) => SAFE_ARG.test(a));
}

/**
 * True when `cwd` is inside `workspaceRoot` (or is the root itself). This is a
 * BOUNDARY check on where a command is launched — NOT a runtime filesystem
 * sandbox (see the module header).
 */
export function isInsideWorkspace(workspaceRoot: string, cwd: string): boolean {
  const root = resolve(workspaceRoot);
  const target = resolve(cwd);
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** True when `dir` resolves to `root` or anything beneath it. */
function isPathInside(root: string, dir: string): boolean {
  const rel = relative(resolve(root), resolve(dir));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Allowlist of env var NAMES a package manager legitimately needs. Everything
 * else is dropped — including credential-bearing vars like DATABASE_URL and
 * MONGODB_URI whose NAME carries no secret keyword. An allowlist is strictly
 * safer than a denylist: a newly added secret var can never leak just because
 * we forgot to blocklist its name. Compared case-insensitively.
 */
const CHILD_ENV_ALLOW = new Set<string>(
  [
    // POSIX + cross-platform runtime essentials
    "PATH",
    "PATHEXT",
    "HOME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "TERM",
    "TMPDIR",
    "TMP",
    "TEMP",
    "NODE_ENV",
    "NO_COLOR",
    "FORCE_COLOR",
    "CI",
    // Windows runtime essentials
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "SYSTEMDRIVE",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "COMMONPROGRAMFILES",
    "COMMONPROGRAMFILES(X86)",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "USERNAME",
    "COMPUTERNAME",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER",
    "OS",
    "ALLUSERSPROFILE",
  ].map((n) => n.toUpperCase()),
);

/** Matches a credential-bearing URL/DSN: scheme://user:pass@host (e.g. postgres). */
const CREDENTIAL_URL = /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]*:[^/@\s]*@/i;

/** True when a value looks like it embeds inline credentials in a URL/DSN. */
export function looksLikeCredentialUrl(value: string): boolean {
  return CREDENTIAL_URL.test(value.trim());
}

/** Remove any PATH entry that resolves inside the workspace. */
function sanitizePathValue(pathValue: string, workspaceRoot: string): string {
  return pathValue
    .split(delimiter)
    .filter((p) => p && !isPathInside(workspaceRoot, p))
    .join(delimiter);
}

/**
 * Build the child-process env from the safe-name allowlist, drop any
 * credential-URL values, and strip workspace dirs from PATH. Exported so the
 * "no inherited secrets" boundary can be tested directly.
 */
export function sanitizeChildEnv(
  env: NodeJS.ProcessEnv = process.env,
  workspaceRoot?: string,
): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (!CHILD_ENV_ALLOW.has(k.toUpperCase())) continue; // allowlist by name
    if (looksLikeCredentialUrl(v)) continue; // belt-and-suspenders on value
    clean[k] = v;
  }
  if (workspaceRoot) {
    for (const k of Object.keys(clean)) {
      if (k.toUpperCase() === "PATH" && clean[k]) {
        clean[k] = sanitizePathValue(clean[k]!, workspaceRoot);
      }
    }
  }
  return clean;
}

/**
 * Matches any caller-supplied form of the hardening flags (incl. `=false` and
 * any casing, e.g. `--Ignore-Scripts=false`). Case-insensitive so a mixed-case
 * variant can't survive the strip.
 */
const HARDENING_FLAG = /^--ignore-(scripts|pnpmfile).*$/i;

/**
 * Package installs execute lifecycle scripts (pre/postinstall) from the target
 * package.json — untrusted model output. Append `--ignore-scripts` to install/ci
 * so no generated hook runs. npm, pnpm and yarn all honor it. Additionally, pnpm
 * loads a project-controlled `.pnpmfile.cjs` during resolution that
 * `--ignore-scripts` does NOT disable, so pnpm installs also get
 * `--ignore-pnpmfile`.
 *
 * SUBSTRING-SAFE: a naive `includes("--ignore-scripts")` check can be defeated by
 * a caller passing `--ignore-scripts=false` (a different token). So we STRIP every
 * `--ignore-scripts*`/`--ignore-pnpmfile*` variant from the incoming args first,
 * then append the canonical flags LAST — no caller value can override them.
 * Idempotent.
 */
export function hardenArgs(bin: string, args: string[]): string[] {
  const first = args[0] ?? "";
  const isInstall = first === "install" || first === "ci";
  if (!isInstall) return args;
  const stripped = args.filter((a) => !HARDENING_FLAG.test(a));
  const out = [...stripped, "--ignore-scripts"];
  if (bin === "pnpm") out.push("--ignore-pnpmfile");
  return out;
}

/** Executable extensions to probe when resolving a package manager on PATH. */
const PM_EXT = process.platform === "win32" ? ["", ".cmd", ".exe", ".bat"] : [""];

/**
 * Resolve a package-manager binary to an ABSOLUTE path, searching only PATH
 * directories that lie OUTSIDE the workspace. This prevents a planted
 * `pnpm.cmd`/`npm.cmd` inside the generated project from shadowing the real
 * tool (cmd.exe would otherwise resolve the workspace copy from cwd first).
 * Returns null if no trusted binary is found.
 */
export function resolvePmBinary(
  bin: string,
  workspaceRoot: string,
  pathEnv: string = process.env.PATH ?? "",
): string | null {
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    if (isPathInside(workspaceRoot, dir)) continue; // never resolve from workspace
    for (const ext of PM_EXT) {
      const candidate = join(resolve(dir), bin + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export interface RunCommandOptions {
  workspaceRoot: string;
  /**
   * Approval to execute model-authored scripts/binaries (test, build, run,
   * typecheck, npx). The server passes config.allowUntrustedScripts, which
   * defaults to TRUE (real execution is the product default); hermetic tests
   * leave it unset/false so they never spawn package managers.
   */
  allowScriptExecution?: boolean;
  /**
   * Cooperative cancellation. When provided and it returns true, the command is
   * refused before spawning; if it flips true mid-run, the child is force-killed
   * instead of running to completion / the 120s timeout.
   */
  shouldCancel?: () => boolean;
  timeoutMs?: number;
}

/** Quote a Windows token if it contains a space (our args are metachar-free). */
function winQuote(token: string): string {
  return /\s/.test(token) ? `"${token}"` : token;
}

/**
 * Spawn the resolved absolute binary. On POSIX we pass the absolute path with
 * no shell (cwd/PATH are never consulted for the executable). On Windows we
 * invoke cmd.exe with the quoted absolute path and verbatim args — because the
 * command is a full path, cmd runs it directly instead of searching cwd/PATH.
 */
function spawnPm(
  absBin: string,
  runArgs: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
) {
  if (process.platform === "win32") {
    const comspec = process.env.COMSPEC || "cmd.exe";
    // cmd /S /C strips the FIRST and LAST quote character from the line, so a
    // bin path quoted for its spaces ("C:\Program Files\nodejs\npm.cmd" ci)
    // arrives UNQUOTED and cmd runs 'C:\Program'. The canonical fix is one
    // extra outer quote pair, which /S consumes, leaving the inner quoting
    // intact. This single bug made every npm/pnpm verification on this
    // machine fail before the workspace was ever exercised — feeding the QA
    // critic a useless error it then embellished into phantom code blockers.
    const line = `"${[absBin, ...runArgs].map(winQuote).join(" ")}"`;
    return spawn(comspec, ["/d", "/s", "/c", line], {
      cwd,
      shell: false,
      windowsVerbatimArguments: true,
      env,
    });
  }
  return spawn(absBin, runArgs, { cwd, shell: false, env });
}

/**
 * Run a command subject to the allowlist, workspace jail, and the
 * script-execution gate. Returns a structured result instead of throwing on
 * non-zero exit, so the orchestrator can feed failures to QA/repair.
 */
export async function runCommand(
  req: CommandRequest,
  opts: RunCommandOptions,
): Promise<CommandResult> {
  const command = `${req.bin} ${req.args.join(" ")}`.trim();
  const refuse = (reason: string): CommandResult => ({
    command,
    allowed: false,
    executed: false,
    exitCode: null,
    stdout: "",
    stderr: "",
    reason,
  });

  if (!isAllowed(req.bin, req.args)) {
    return refuse(`Command not in allowlist: ${command}`);
  }

  if (!isInsideWorkspace(opts.workspaceRoot, req.cwd)) {
    return refuse("Refused: command cwd is outside the workspace boundary.");
  }

  // SCRIPT GATE: only hermetic tests run with this off; the product default
  // is real execution (allowlist + workspace jail remain the safety boundary).
  if (isScriptExecuting(req.bin, req.args) && !opts.allowScriptExecution) {
    return refuse(
      `Refused: '${command}' executes untrusted project code and script ` +
        `execution is disabled (ALLOW_UNTRUSTED_SCRIPTS=0).`,
    );
  }

  // Cancellation may have been requested between the gate and the spawn.
  if (opts.shouldCancel?.()) {
    return refuse("Refused: run cancelled before command spawn.");
  }

  // Injects --ignore-scripts on installs so untrusted lifecycle hooks can't run.
  const runArgs = hardenArgs(req.bin, req.args);
  if (process.platform === "win32" && !argsAreShellSafe(req.bin, runArgs)) {
    return refuse("Refused: command arguments contain unsafe characters.");
  }

  // Resolve the PM to an absolute path OUTSIDE the workspace (no shadowing).
  const absBin = resolvePmBinary(req.bin, opts.workspaceRoot);
  if (!absBin) {
    return refuse(
      `Refused: '${req.bin}' not found on a trusted PATH outside the workspace.`,
    );
  }

  // Sanitized env: allowlisted names only, credential URLs dropped, workspace
  // removed from PATH — a generated project can't read secrets or shadow tools.
  const env = sanitizeChildEnv(process.env, opts.workspaceRoot);

  return new Promise<CommandResult>((resolveP) => {
    const child = spawnPm(absBin, runArgs, req.cwd, env);
    let stdout = "";
    let stderr = "";
    let cancelled = false;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
    }, opts.timeoutMs ?? 120_000);
    // Poll for a cancel request and force-kill the child if it arrives, so a
    // cancelled run does not keep a child alive until it finishes / times out.
    const cancelPoll = opts.shouldCancel
      ? setInterval(() => {
          if (opts.shouldCancel!()) {
            cancelled = true;
            child.kill("SIGKILL");
          }
        }, 200)
      : null;
    const cleanup = () => {
      clearTimeout(timeout);
      if (cancelPoll) clearInterval(cancelPoll);
    };

    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      cleanup();
      resolveP({
        command,
        allowed: true,
        executed: false,
        exitCode: null,
        stdout,
        stderr: String(err),
        reason: "spawn error",
      });
    });
    child.on("close", (code) => {
      cleanup();
      if (cancelled) {
        resolveP({
          command,
          allowed: true,
          executed: false,
          exitCode: code,
          stdout: stdout.slice(-8000),
          stderr: stderr.slice(-8000),
          reason: "Cancelled: child process killed on cancel request.",
        });
        return;
      }
      resolveP({
        command,
        allowed: true,
        executed: true,
        exitCode: code,
        stdout: stdout.slice(-8000),
        stderr: stderr.slice(-8000),
      });
    });
  });
}
