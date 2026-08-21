/**
 * cliProvider.ts — rotation transport backed by a LOCAL, flat-rate CLI.
 *
 * TypeScript sibling of `C:\Users\firer\flexfactor\providers\cli_provider.py`
 * (flexfactor a4a02e0). Same properties, this repo's idiom:
 *
 *     api="claude-code"  ->  the `claude` CLI   (flat-rate subscription)
 *     api="codex-cli"    ->  the `codex` CLI    (flat-rate subscription)
 *
 * WHY THIS EXISTS
 * ---------------
 * Both CLIs are installed and flat-rate on this machine, so every call routed
 * through them is capacity the AI Time catalog cannot otherwise see. They join
 * rotation as POOLS (their own quota ledgers), which is the only thing that
 * actually spreads load — rotating model NAMES inside one pool spreads nothing.
 *
 * WHY IT IS WRITTEN THIS WAY
 * --------------------------
 * 1. THE PROMPT GOES OVER STDIN, NEVER argv. This repo's launchers run under
 *    Windows PowerShell 5.1, which mangles embedded quotes in native
 *    arguments, and `codex` resolves to a `.CMD` shim that must be invoked
 *    through cmd.exe — whose quote-stripping is the documented root cause of
 *    this project's worst fabrication cascade. So argv carries FIXED LITERAL
 *    FLAGS ONLY and {@link assertLiteralArgv} enforces that at run time.
 *    (This is a deliberate divergence from the Python twin, which passes the
 *    system prompt as `--append-system-prompt <text>`: a Python list-form
 *    exec never reaches a shell, a Windows `.CMD` shim always does.)
 *
 * 2. EVERY CALL IS BOUNDED. An unbounded child is the exact shape that froze a
 *    live run for 25+ minutes against a static cost meter. Expiry kills the
 *    process TREE (`taskkill /T` on Windows — a bare kill leaves the real
 *    worker orphaned) and raises, so the rotator rolls over to the next pool.
 *
 * 3. IT FAILS CLOSED. Missing binary, non-zero exit, or EMPTY output all
 *    reject with {@link CliUnavailable}. Nothing here can return a
 *    plausible-looking empty answer that a caller records as completed work.
 *
 * 4. IT REFUSES TO RECURSE. `claude` invoked from inside a CLI-provider call
 *    spawns a nested agent, and one rotation sweep would fan out into dozens.
 *    A marker is stamped into the child's environment and the provider refuses
 *    when it sees its own — or FlexFactor's — marker already set.
 *
 * 5. THE RUN'S WORK THEME RIDES ALONG. `system` is prepended to the piped body
 *    so a rotated CLI call attacks the same open issue as every HTTP route.
 *    ThemedProvider has already stamped the DIRECTED WORK THEME block into
 *    `system` by the time it gets here (see orchestrator/workTheme.ts).
 *
 * SECRETS: no API keys are read, stored or logged — both CLIs carry their own
 * authentication. Only the prompt is handed to the child.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { extensionsEnabled } from "./extensionSwitch.js";

/** The CLI cannot serve this call. The rotator treats it as a route failure. */
export class CliUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUnavailable";
  }
}

/** Which executable serves which catalog api id. */
export const CLI_BINARIES: Readonly<Record<string, string>> = {
  "claude-code": "claude",
  "codex-cli": "codex",
};

export const CLI_APIS: ReadonlySet<string> = new Set(Object.keys(CLI_BINARIES));

/**
 * Environment markers that mean "we are already inside a CLI-provider call".
 * FlexFactor's marker is honoured too: the two tools share this machine, and a
 * FlexFactor sweep shelling out to Factory Deck must not re-enter either.
 */
export const CLI_RECURSION_MARKER = "FACTORY_CLI_PROVIDER_ACTIVE";
const FOREIGN_RECURSION_MARKERS = ["FLEXFACTOR_CLI_PROVIDER_ACTIVE"];

export { extensionsEnabled } from "./extensionSwitch.js";

/**
 * Per-call ceiling. Generous, because a real authoring turn legitimately takes
 * minutes on a flat-rate CLI — but never unbounded.
 */
export function cliTimeoutMs(): number {
  const raw = Number(process.env.FACTORY_CLI_TIMEOUT_MS || "");
  return Number.isFinite(raw) && raw > 0 ? raw : 600_000;
}

/** `FACTORY_CLI_BIN_CLAUDE_CODE` / `FACTORY_CLI_BIN_CODEX_CLI`. */
function binOverrideVar(api: string): string {
  return `FACTORY_CLI_BIN_${api.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}`;
}

/**
 * PATH lookup, PATHEXT-aware — Node has no `shutil.which`. Returns the
 * resolved absolute path or null.
 *
 * A hit here is NOT proof the route is usable; it is one of several conditions
 * {@link makeCliProvider} checks. (The defect this whole module exists to
 * avoid: `claude` and `codex` are both on PATH, so a PATH-only guard admits
 * routes whose adapter does not exist and the failure lands at call time,
 * burning a rotation cooldown.)
 */
export function cliBinaryFor(api: string): string | null {
  const key = String(api || "")
    .trim()
    .toLowerCase();
  const name = CLI_BINARIES[key];
  if (!name) return null;

  const override = (process.env[binOverrideVar(key)] || "").trim();
  if (override) return fs.existsSync(override) ? path.resolve(override) : null;

  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* not here; keep looking */
      }
    }
  }
  return null;
}

/**
 * Non-interactive argv for one CLI. THE PROMPT IS NEVER IN HERE — see the
 * module header. Every element must survive a cmd.exe round trip unchanged.
 */
export function argvFor(api: string): string[] {
  switch (String(api || "").toLowerCase()) {
    case "claude-code":
      // `-p` is print / non-interactive mode; it reads the prompt from stdin.
      return ["-p", "--output-format", "text"];
    case "codex-cli":
      // `exec` is codex's non-interactive one-shot mode; `-` means stdin.
      return ["exec", "--skip-git-repo-check", "-"];
    default:
      throw new CliUnavailable(`no CLI argv defined for api '${api}'`);
  }
}

/**
 * Refuse any argv element that a shell could reinterpret. This is the run-time
 * teeth behind "the prompt goes over stdin": if a future edit ever tries to
 * pass free text as an argument, the call fails loudly here instead of
 * silently sending a mangled prompt through cmd.exe.
 */
export function assertLiteralArgv(argv: readonly string[]): void {
  for (const a of argv) {
    if (!/^[A-Za-z0-9._:\\/=-]+$/.test(a)) {
      throw new CliUnavailable(
        `refusing to pass '${a.slice(0, 40)}' as a CLI argument: only fixed ` +
          `literal flags may ride argv; prompt text goes over stdin`,
      );
    }
  }
}

function recursionGuardEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    [CLI_RECURSION_MARKER]: "1",
    CI: process.env.CI ?? "1",
    NO_COLOR: process.env.NO_COLOR ?? "1",
  };
}

function activeRecursionMarker(): string | null {
  for (const m of [CLI_RECURSION_MARKER, ...FOREIGN_RECURSION_MARKERS]) {
    if (process.env[m]) return m;
  }
  return null;
}

/** Kill the whole child TREE. A bare kill on Windows orphans the real worker. */
function killTree(
  pid: number | undefined,
  child: { kill: (s?: NodeJS.Signals) => boolean },
): void {
  if (process.platform === "win32" && pid) {
    try {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      }).unref();
      return;
    } catch {
      /* fall through to the portable kill */
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
}

export interface CliRunOptions {
  system?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Run one bounded, non-interactive CLI turn and return its stdout.
 *
 * Rejects with {@link CliUnavailable} for every failure mode — missing binary,
 * timeout, non-zero exit, empty output — so no caller can mistake a broken
 * transport for a completed answer.
 */
export async function runCli(
  api: string,
  binary: string,
  prompt: string,
  opts: CliRunOptions = {},
): Promise<string> {
  const marker = activeRecursionMarker();
  if (marker) {
    throw new CliUnavailable(
      `refusing to invoke ${path.basename(binary)}: already inside a CLI-provider ` +
        `call (${marker} is set); nested agents would fan out per rotation step`,
    );
  }

  const argv = argvFor(api);
  assertLiteralArgv(argv);
  const timeoutMs = opts.timeoutMs ?? cliTimeoutMs();
  // The system prompt — which carries the run's DIRECTED WORK THEME — is
  // prepended to the piped body rather than passed as an argument, so a
  // rotated CLI call stays on the run's task without ever touching argv.
  const body = opts.system?.trim() ? `${opts.system.trim()}\n\n${prompt}` : prompt;

  const ext = path.extname(binary).toLowerCase();
  const viaCmd = process.platform === "win32" && (ext === ".cmd" || ext === ".bat");
  const exe = viaCmd ? process.env.ComSpec || "cmd.exe" : binary;
  // Only reached for a .CMD/.BAT shim (npm installs `codex` as one). Safe
  // precisely because assertLiteralArgv has proven every element is a bare
  // flag: there is no free text here for cmd.exe's quote stripping to eat.
  const args = viaCmd ? ["/d", "/s", "/c", `"${binary}" ${argv.join(" ")}`] : argv;

  return await new Promise<string>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(exe, args, {
        env: recursionGuardEnv(),
        windowsHide: true,
        windowsVerbatimArguments: viaCmd,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      reject(
        new CliUnavailable(
          `${path.basename(binary)}: could not start (${
            err instanceof Error ? err.message : String(err)
          })`,
        ),
      );
      return;
    }

    let out = "";
    let errOut = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };

    const timer = setTimeout(() => {
      killTree(child.pid, child);
      finish(() =>
        reject(
          new CliUnavailable(
            `${path.basename(binary)}: exceeded ${Math.round(
              timeoutMs / 1000,
            )}s and was killed`,
          ),
        ),
      );
    }, timeoutMs);

    const onAbort = () => {
      killTree(child.pid, child);
      finish(() =>
        reject(new CliUnavailable(`${path.basename(binary)}: cancelled by the run`)),
      );
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => {
      out += c;
    });
    child.stderr?.on("data", (c: string) => {
      errOut += c;
    });
    child.on("error", (err) =>
      finish(() =>
        reject(new CliUnavailable(`${path.basename(binary)}: ${err.message}`)),
      ),
    );
    child.on("close", (code) => {
      finish(() => {
        const text = out.trim();
        if (code !== 0) {
          const tail = (errOut.trim() || text).slice(-400);
          reject(
            new CliUnavailable(`${path.basename(binary)}: exited ${code}: ${tail}`),
          );
          return;
        }
        if (!text) {
          // An empty answer must never read as a successful empty result.
          reject(new CliUnavailable(`${path.basename(binary)}: returned no output`));
          return;
        }
        resolve(text);
      });
    });

    child.stdin?.on("error", () => {
      /* the child may exit before the body is fully written; `close` decides */
    });
    child.stdin?.end(body, "utf8");
  });
}

/**
 * One catalog route served by a local CLI. Deliberately NOT an `LLMProvider`:
 * rotation owns provider identity ("free"), route selection and reporting, and
 * this object is only the transport for one selected route.
 */
export class CliRouteProvider {
  readonly api: string;
  readonly model: string;
  readonly binary: string;
  /** Cost label. Both CLIs are flat-rate, so a rotated call bills $0. */
  readonly meter: string;
  private readonly timeoutMs: number;

  constructor(api: string, model: string, binary: string, timeoutMs = cliTimeoutMs()) {
    this.api = api;
    this.model = model;
    this.binary = binary;
    this.meter = `${api}:subscription`;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Is the CLI actually runnable? A PATH hit is not proof — this executes it.
   * Bounded like every other call and never throws.
   */
  async ping(timeoutMs = 30_000): Promise<boolean> {
    const ext = path.extname(this.binary).toLowerCase();
    const viaCmd = process.platform === "win32" && (ext === ".cmd" || ext === ".bat");
    const exe = viaCmd ? process.env.ComSpec || "cmd.exe" : this.binary;
    const args = viaCmd
      ? ["/d", "/s", "/c", `"${this.binary}" --version`]
      : ["--version"];
    return await new Promise<boolean>((resolve) => {
      let done = false;
      const settle = (ok: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve(ok);
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(exe, args, {
          env: recursionGuardEnv(),
          windowsHide: true,
          windowsVerbatimArguments: viaCmd,
          stdio: "ignore",
        });
      } catch {
        resolve(false);
        return;
      }
      const t = setTimeout(() => {
        killTree(child.pid, child);
        settle(false);
      }, timeoutMs);
      child.on("error", () => settle(false));
      child.on("close", (code) => settle(code === 0));
    });
  }

  /** One bounded, on-theme turn. `system` carries the DIRECTED WORK THEME. */
  async complete(
    input: { system?: string; prompt: string },
    signal?: AbortSignal,
  ): Promise<string> {
    return await runCli(this.api, this.binary, input.prompt, {
      system: input.system,
      timeoutMs: this.timeoutMs,
      signal,
    });
  }
}

/**
 * Build a provider for one catalog route, or throw {@link CliUnavailable}.
 *
 * This is the CONSTRUCTIBILITY probe the catalog filter relies on: if this
 * throws, the route must never reach the rotator.
 */
export function makeCliProvider(route: {
  api?: string;
  model?: string;
  wire_model?: string;
  cost_class?: string;
}): CliRouteProvider {
  if (!extensionsEnabled()) {
    throw new CliUnavailable(
      "CLI providers are off (set FACTORY_ROTATION_EXTENSIONS=1)",
    );
  }
  const api = String(route.api || "")
    .trim()
    .toLowerCase();
  if (!CLI_APIS.has(api)) {
    throw new CliUnavailable(`'${api}' is not a CLI-backed api`);
  }
  const binary = cliBinaryFor(api);
  if (!binary) {
    throw new CliUnavailable(`${CLI_BINARIES[api]}: not installed or not on PATH`);
  }
  const wire = route.wire_model || route.model || api;
  return new CliRouteProvider(api, wire, binary);
}
