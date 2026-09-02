import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve, relative, isAbsolute, join, delimiter } from "node:path";
import {
  isJavascriptTestPath,
  isPythonTestPath,
  normalizeSafeRelativePath,
} from "./testPaths.js";
import {
  buildVerificationSandboxPlan,
  verificationSandboxConfig,
} from "./verificationSandbox.js";

/**
 * commandRunner.ts — conservative command execution for UNTRUSTED generated
 * projects.
 *
 * SECURITY BOUNDARY (defense-in-depth — no single flag opens all holes):
 *  - ALLOWLIST: only specific package-manager subcommands may run, and only
 *    inside a workspace directory (never the project root).
 *  - SCRIPT GATE: any allowlisted command is refused unless
 *    `allowScriptExecution` is enabled — including dependency installs. The
 *    server keeps it disabled by default because cwd containment is not an OS
 *    sandbox. An owner may opt in only when Factory Deck itself runs inside a
 *    disposable container/VM with a workspace-only writable mount. An install is
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
 * NOTE: `isInsideWorkspace` remains only a cwd boundary. When
 * FACTORY_VERIFICATION_SANDBOX_IMAGE is configured on Linux, every generated
 * command is additionally executed in a locked-down container with only the
 * workspace and an empty per-run state directory mounted writable.
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
  ["yarn", "run"],
  ["yarn", "test"],
];

/** Python entrypoints Factory Deck itself may schedule for verification. */
const PYTHON_BINS = new Set(["python", "python3"]);

function isSafeDirectPythonTest(arg: string): boolean {
  return isPythonTestPath(arg);
}

function isAllowedPython(args: string[]): boolean {
  if (args.length === 1 && isSafeDirectPythonTest(args[0]!)) return true;
  if (args[0] !== "-m") return false;
  const module = args[1] ?? "";
  if (
    module === "compileall" &&
    args.length === 4 &&
    args[2] === "-q" &&
    args[3] === "."
  ) {
    return true;
  }
  if (module === "pytest" && args.length === 3 && args[2] === "-q") {
    return true;
  }
  if (
    module === "pytest" &&
    args.length === 4 &&
    (args[2] === "-q" || args[2] === "-vv") &&
    isSafeDirectPythonTest(args[3]!)
  ) {
    return true;
  }
  if (module === "unittest" && args.length === 3 && args[2] === "discover") {
    return true;
  }
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

function isSafeDirectJsTest(arg: string): boolean {
  return isJavascriptTestPath(arg);
}

function isSafeVitestRoot(arg: string): boolean {
  if (!arg.startsWith("--root=")) return false;
  return normalizeSafeRelativePath(arg.slice("--root=".length)) !== null;
}

/** Engine-authored local-runner forms only; npx may never download a package. */
export function isAllowedNpxVerification(args: string[]): boolean {
  if (args[0] !== "--no-install") return false;
  const tool = args[1] ?? "";
  if (tool === "prisma") {
    return args.length === 3 && args[2] === "generate";
  }
  if (tool === "tsc") {
    return args.length === 3 && args[2] === "--noEmit";
  }
  if (tool === "vitest") {
    return (
      args.length === 6 &&
      args[2] === "run" &&
      isSafeDirectJsTest(args[3]!) &&
      args[4] === "--reporter=json" &&
      isSafeVitestRoot(args[5]!)
    );
  }
  if (tool === "jest") {
    return (
      args.length === 5 &&
      args[2] === "--runTestsByPath" &&
      isSafeDirectJsTest(args[3]!) &&
      args[4] === "--json"
    );
  }
  if (tool === "playwright") {
    if (args.length === 4 && args[2] === "install" && args[3] === "chromium") {
      return true;
    }
    return (
      args.length === 5 &&
      args[2] === "test" &&
      isSafeDirectJsTest(args[3]!) &&
      args[4] === "--reporter=json"
    );
  }
  return false;
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

const MAX_CAPTURED_OUTPUT = 8_000;

function appendOutputTail(current: string, chunk: Buffer | string): string {
  return (current + chunk.toString()).slice(-MAX_CAPTURED_OUTPUT);
}

export function isAllowed(bin: string, args: string[]): boolean {
  if (PYTHON_BINS.has(bin)) return isAllowedPython(args);
  if (bin === "npx") return isAllowedNpxVerification(args);
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
const SAFE_ARG = /^[A-Za-z0-9._:@\/= -]+$/;

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
   * defaults to FALSE because this module is not an OS sandbox. Enable only
   * when the whole Factory Deck process is externally sandboxed.
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
  return spawn(absBin, runArgs, {
    cwd,
    shell: false,
    env,
    // A separate process group lets timeout/cancellation reap POSIX
    // grandchildren instead of killing only npm/pnpm's immediate wrapper.
    detached: true,
  });
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

  // Sanitized host env: allowlisted names only, credential URLs dropped, and
  // workspace entries removed from PATH.
  const env = sanitizeChildEnv(process.env, opts.workspaceRoot);
  let absBin: string;
  let spawnArgs = runArgs;
  let sandboxContainerName: string | null = null;
  let sandboxDockerBin: string | null = null;
  try {
    const sandbox = verificationSandboxConfig(process.env);
    if (sandbox) {
      if (process.platform !== "linux") {
        return refuse(
          "Refused: the integrated verification sandbox is supported only on Linux.",
        );
      }
      const docker = resolvePmBinary("docker", opts.workspaceRoot);
      if (!docker) {
        return refuse(
          "Refused: Docker was not found on a trusted PATH for sandboxed verification.",
        );
      }
      const plan = buildVerificationSandboxPlan({
        workspaceRoot: opts.workspaceRoot,
        cwd: req.cwd,
        stateRoot: sandbox.stateRoot,
        image: sandbox.image,
        bin: req.bin,
        args: runArgs,
        uid: typeof process.getuid === "function" ? process.getuid() : 65532,
        gid: typeof process.getgid === "function" ? process.getgid() : 65532,
      });
      for (const directory of [
        "home",
        "cache",
        "corepack",
        "pnpm",
        "npm",
        "yarn",
        "pip",
        "playwright",
      ]) {
        mkdirSync(join(resolve(sandbox.stateRoot), directory), {
          recursive: true,
        });
      }
      absBin = docker;
      spawnArgs = plan.dockerArgs;
      sandboxContainerName = plan.containerName;
      sandboxDockerBin = docker;
    } else {
      const trustedBin = resolvePmBinary(req.bin, opts.workspaceRoot);
      if (!trustedBin) {
        return refuse(
          `Refused: '${req.bin}' not found on a trusted PATH outside the workspace.`,
        );
      }
      absBin = trustedBin;
    }
  } catch (error) {
    return refuse(
      `Refused: verification sandbox configuration is invalid: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
  }

  return new Promise<CommandResult>((resolveP) => {
    const child = spawnPm(absBin, spawnArgs, req.cwd, env);
    let stdout = "";
    let stderr = "";
    let cancelled = false;
    // Kill the whole PROCESS TREE, not just the immediate child. On Windows the
    // immediate child is a cmd.exe wrapper: `child.kill("SIGKILL")` terminates
    // cmd while the npm→node grandchildren keep running AND keep the inherited
    // stdio pipes open, so `close` never fires and the "killed" command hangs
    // for as long as the grandchild lives (run d687f5fd: a 120s timeout kill
    // produced a 19.5-minute zombie `npm test`). taskkill /T reaps the tree —
    // the same fix the EVA launcher uses for the identical problem.
    const killTree = () => {
      if (sandboxContainerName && sandboxDockerBin) {
        try {
          spawnSync(sandboxDockerBin, ["kill", sandboxContainerName], {
            stdio: "ignore",
            env,
          });
          spawnSync(sandboxDockerBin, ["rm", "-f", sandboxContainerName], {
            stdio: "ignore",
            env,
          });
        } catch {
          // The Docker client process group is still killed below.
        }
      }
      if (process.platform === "win32" && child.pid) {
        try {
          spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
          });
        } catch {
          child.kill("SIGKILL");
        }
      } else if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else {
        child.kill("SIGKILL");
      }
    };
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      killTree();
    }, opts.timeoutMs ?? 120_000);
    // Poll for a cancel request and force-kill the child if it arrives, so a
    // cancelled run does not keep a child alive until it finishes / times out.
    const cancelPoll = opts.shouldCancel
      ? setInterval(() => {
          if (!cancelled && opts.shouldCancel!()) {
            cancelled = true;
            killTree();
          }
        }, 200)
      : null;
    const cleanup = () => {
      clearTimeout(timeout);
      if (cancelPoll) clearInterval(cancelPoll);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendOutputTail(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendOutputTail(stderr, chunk);
    });
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
      if (timedOut) {
        resolveP({
          command,
          allowed: true,
          executed: false,
          exitCode: code,
          stdout: stdout.slice(-8000),
          stderr: stderr.slice(-8000),
          reason: "Timed out: child process tree was killed.",
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
