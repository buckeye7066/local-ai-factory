/**
 * extendedTransports.test.ts — the CLI / Cursor rotation pools.
 *
 * The properties pinned here are the ones that cost real time when they were
 * absent (see providers/cliProvider.ts and providers/extendedTransports.ts):
 *
 *   - the prompt goes over STDIN, never argv;
 *   - every call is BOUNDED and expiry kills the child;
 *   - it FAILS CLOSED — missing binary, non-zero exit, EMPTY output;
 *   - it REFUSES TO RECURSE;
 *   - rotation stays FREE/flat-rate only;
 *   - the run's DIRECTED WORK THEME reaches the CLI, so a rotated call stays
 *     on the same task;
 *   - and a route is admitted ONLY when its adapter is provably BUILDABLE,
 *     with a NAMED REASON when it is not — one broken adapter must not take
 *     the whole catalog filter down.
 *
 * The CLI tests drive REAL subprocesses through a shim binary, so the
 * transport (stdin piping, cmd.exe shim handling on Windows, exit codes,
 * tree-kill on timeout) is exercised rather than mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CliUnavailable,
  argvFor,
  assertLiteralArgv,
  cliBinaryFor,
  extensionsEnabled,
  makeCliProvider,
  runCli,
} from "../providers/cliProvider.js";
import {
  CursorUnavailable,
  makeCursorRoute,
} from "../providers/cursorRouteProvider.js";
import {
  extendedRouteUnusableReason,
  isCliRoute,
  isExtendedApi,
  synthesizeExtendedRoutes,
} from "../providers/extendedTransports.js";
import { buildRotator, StateStore } from "../rotation/aitimeRotation.js";
import {
  RotatingProvider,
  filterRoutableCatalog,
} from "../rotation/rotatingProvider.js";
import { ThemedProvider, withWorkTheme } from "../orchestrator/workTheme.js";

let dir: string;

/** Where a shim records exactly what it received on stdin. */
function capturePath(): string {
  return path.join(dir, "stdin-capture.txt");
}

/**
 * Write a fake CLI. `body` is Node source; the shim records stdin to
 * {@link capturePath} first so tests can assert what the child really got.
 *
 * On Windows the shim is a `.cmd`, which is how npm actually installs `codex`
 * — so this exercises the cmd.exe branch of the spawner rather than a
 * convenient .exe that would hide it.
 */
function writeShim(name: string, body: string): string {
  const js = path.join(dir, `${name}.mjs`);
  fs.writeFileSync(
    js,
    `import fs from "node:fs";
let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { data += c; });
process.stdin.on("end", () => {
  try { fs.writeFileSync(${JSON.stringify(capturePath())}, data); } catch {}
  ${body}
});
// A shim that is never given stdin must still finish.
setTimeout(() => process.stdin.emit("end"), 4000).unref?.();
`,
    "utf8",
  );
  if (process.platform === "win32") {
    const cmd = path.join(dir, `${name}.cmd`);
    fs.writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${js}" %*\r\n`, "utf8");
    return cmd;
  }
  const sh = path.join(dir, name);
  fs.writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`, "utf8");
  fs.chmodSync(sh, 0o755);
  return sh;
}

const ECHO = `process.stdout.write(data); process.exit(0);`;
const EMPTY = `process.exit(0);`;
const FAIL = `process.stderr.write("shim refused"); process.exit(3);`;
const HANG = `setTimeout(() => process.exit(0), 30000);`;

function useShim(api: "claude-code" | "codex-cli", body: string): string {
  const bin = writeShim(api.replace(/[^a-z]/g, ""), body);
  vi.stubEnv(
    `FACTORY_CLI_BIN_${api.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}`,
    bin,
  );
  return bin;
}

function cliRow(api: "claude-code" | "codex-cli", pool: string) {
  return {
    id: `${api}/${api}-cli`,
    backend: api,
    backend_label: api,
    model: `${api}-cli`,
    wire_model: `${api}-cli`,
    api,
    base_url: "",
    pool,
    auth_env: "",
    auth_kind: "none",
    cost_class: "subscription",
    tier: "frontier",
    enabled: true,
  };
}

function writeCatalog(rows: Array<Record<string, unknown>>): void {
  fs.writeFileSync(
    path.join(dir, "routes.json"),
    JSON.stringify({ schema: 1, generated_at: new Date().toISOString(), routes: rows }),
  );
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "extended-transports-test-"));
  vi.stubEnv("AITIME_STATE_DIR", dir);
  vi.stubEnv("AI_ROTATE", "on");
  vi.stubEnv("AI_ROTATE_PIN", "");
  vi.stubEnv("FACTORY_ROTATION_EXTENSIONS", "1");
  vi.stubEnv("FACTORY_CURSOR_BASE_URL", "");
  // Point both CLIs at a path that does not exist, so PATH is never consulted
  // and the suite can never reach the REAL `claude` / `codex` binaries. This
  // is not hypothetical: the first run of this file spent 60s waiting on a
  // genuine Claude Code turn ("Could you clarify what you want me to do with
  // 'SYS p'?") because an empty override fell through to PATH. Real-binary
  // coverage is deliberate and lives in its own describe block below.
  vi.stubEnv("FACTORY_CLI_BIN_CLAUDE_CODE", path.join(dir, "__no_cli__"));
  vi.stubEnv("FACTORY_CLI_BIN_CODEX_CLI", path.join(dir, "__no_cli__"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

// --------------------------------------------------------------------------
describe("CLI transport — the prompt goes over stdin, never argv", () => {
  it("argv carries fixed literal flags only", () => {
    expect(argvFor("claude-code")).toEqual(["-p", "--output-format", "text"]);
    expect(argvFor("codex-cli")).toEqual(["exec", "--skip-git-repo-check", "-"]);
    for (const api of ["claude-code", "codex-cli"]) {
      expect(() => assertLiteralArgv(argvFor(api))).not.toThrow();
    }
  });

  it("refuses free text as an argument — the WinPS/cmd.exe quote trap", () => {
    expect(() =>
      assertLiteralArgv(["--append-system-prompt", 'Theme: "fix X"']),
    ).toThrow(CliUnavailable);
    expect(() => assertLiteralArgv(["-p", "a prompt with spaces"])).toThrow(
      /prompt text goes over stdin/,
    );
  });

  it("the real child receives the prompt on stdin", async () => {
    const bin = useShim("claude-code", ECHO);
    const out = await runCli("claude-code", bin, "COUNT THE RIVETS", {
      timeoutMs: 30_000,
    });
    expect(out).toContain("COUNT THE RIVETS");
    expect(fs.readFileSync(capturePath(), "utf8")).toContain("COUNT THE RIVETS");
  });
});

describe("CLI transport — bounded, fails closed, refuses to recurse", () => {
  it("expiry kills the child and raises instead of hanging", async () => {
    const bin = useShim("claude-code", HANG);
    const started = Date.now();
    await expect(runCli("claude-code", bin, "p", { timeoutMs: 1500 })).rejects.toThrow(
      /exceeded 2s and was killed|exceeded 1s and was killed/,
    );
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it("EMPTY output is an error, never a plausible empty result", async () => {
    const bin = useShim("claude-code", EMPTY);
    await expect(
      runCli("claude-code", bin, "p", { timeoutMs: 30_000 }),
    ).rejects.toThrow(/returned no output/);
  });

  it("a non-zero exit is an error and carries the tail", async () => {
    const bin = useShim("codex-cli", FAIL);
    await expect(runCli("codex-cli", bin, "p", { timeoutMs: 30_000 })).rejects.toThrow(
      /exited 3: shim refused/,
    );
  });

  it("a missing binary is refused at construction, not at call time", () => {
    vi.stubEnv("FACTORY_CLI_BIN_CLAUDE_CODE", path.join(dir, "does-not-exist.cmd"));
    expect(cliBinaryFor("claude-code")).toBeNull();
    expect(() => makeCliProvider({ api: "claude-code" })).toThrow(
      /not installed or not on PATH/,
    );
  });

  it("refuses to recurse when a CLI-provider marker is already set", async () => {
    const bin = useShim("claude-code", ECHO);
    vi.stubEnv("FACTORY_CLI_PROVIDER_ACTIVE", "1");
    await expect(
      runCli("claude-code", bin, "p", { timeoutMs: 30_000 }),
    ).rejects.toThrow(/nested agents would fan out/);
  });

  it("honours FlexFactor's marker too — the tools share this machine", async () => {
    const bin = useShim("claude-code", ECHO);
    vi.stubEnv("FLEXFACTOR_CLI_PROVIDER_ACTIVE", "1");
    await expect(
      runCli("claude-code", bin, "p", { timeoutMs: 30_000 }),
    ).rejects.toThrow(/FLEXFACTOR_CLI_PROVIDER_ACTIVE/);
  });

  it("stamps its own marker into the child, so the child cannot re-enter", async () => {
    const bin = useShim(
      "claude-code",
      `process.stdout.write("marker=" + (process.env.FACTORY_CLI_PROVIDER_ACTIVE || "unset")); process.exit(0);`,
    );
    const out = await runCli("claude-code", bin, "p", { timeoutMs: 30_000 });
    expect(out).toBe("marker=1");
  });

  it("is off unless the extensions switch is set", () => {
    vi.stubEnv("FACTORY_ROTATION_EXTENSIONS", "0");
    expect(extensionsEnabled()).toBe(false);
    expect(() => makeCliProvider({ api: "claude-code" })).toThrow(
      /FACTORY_ROTATION_EXTENSIONS/,
    );
  });
});

// --------------------------------------------------------------------------
describe("buildability admission — a PATH hit is not proof", () => {
  it("admits a CLI route only when the provider actually constructs", () => {
    useShim("claude-code", ECHO);
    expect(extendedRouteUnusableReason({ api: "claude-code" })).toBe("");
    vi.stubEnv("FACTORY_CLI_BIN_CLAUDE_CODE", path.join(dir, "gone.cmd"));
    expect(extendedRouteUnusableReason({ api: "claude-code" })).toMatch(
      /not installed or not on PATH/,
    );
  });

  it("Cursor is excluded with a named reason when no endpoint is configured", () => {
    expect(() => makeCursorRoute({ api: "cursor" })).toThrow(CursorUnavailable);
    expect(extendedRouteUnusableReason({ api: "cursor" })).toMatch(
      /FACTORY_CURSOR_BASE_URL/,
    );
    vi.stubEnv("FACTORY_CURSOR_BASE_URL", "http://127.0.0.1:3000/v1");
    expect(extendedRouteUnusableReason({ api: "cursor" })).toBe("");
  });

  it("never throws — every failure comes back as a reason string", () => {
    for (const api of ["claude-code", "codex-cli", "cursor", "openai", ""]) {
      expect(() => extendedRouteUnusableReason({ api })).not.toThrow();
    }
    // A non-extended api is simply not this filter's business.
    expect(extendedRouteUnusableReason({ api: "openai" })).toBe("");
    expect(isExtendedApi("cursor")).toBe(true);
    expect(isCliRoute("cursor")).toBe(false);
    expect(isCliRoute("codex-cli")).toBe(true);
  });

  it("an unbuildable CLI route never reaches the rotator", () => {
    vi.stubEnv("FACTORY_CLI_BIN_CLAUDE_CODE", path.join(dir, "gone.cmd"));
    writeCatalog([
      cliRow("claude-code", "anthropic:max-plan"),
      {
        id: "groq/llama",
        backend: "groq",
        model: "llama",
        wire_model: "llama",
        api: "openai",
        base_url: "https://groq.example.invalid/v1",
        pool: "groq:free-tier",
        auth_env: "",
        auth_kind: "none",
        cost_class: "free-tier",
        tier: "frontier",
        enabled: true,
      },
    ]);
    const built = buildRotator("factory-deck");
    expect(built).not.toBeNull();
    const messages: string[] = [];
    const filtered = filterRoutableCatalog(built!, "", (_k, m) => {
      messages.push(m);
    });
    const ids = filtered!.catalog.routes.map((r) => r.id);
    expect(ids).not.toContain("claude-code/claude-code-cli");
    // The healthy route still evaluates — a rejection must never be a
    // catalog-wide outage.
    expect(ids).toContain("groq/llama");
    expect(messages.join("\n")).toMatch(/extended transport\(s\) not admitted/);
    expect(messages.join("\n")).toMatch(/not installed or not on PATH/);
  });
});

// --------------------------------------------------------------------------
describe("pool synthesis — rotate POOLS, not model names", () => {
  it("contributes only the pools this process can build, and says why not", () => {
    useShim("claude-code", ECHO);
    const { routes, skipped } = synthesizeExtendedRoutes();
    const byApi = Object.fromEntries(routes.map((r) => [r.api, r]));
    expect(byApi["claude-code"]).toBeDefined();
    // Cursor has no endpoint configured in this test env — excluded, LOUDLY.
    expect(routes.some((r) => r.api === "cursor")).toBe(false);
    expect(Object.values(skipped).join(" ")).toMatch(/FACTORY_CURSOR_BASE_URL/);
  });

  it("the Claude Code CLI shares the Max-plan LEDGER, not a private pool", () => {
    useShim("claude-code", ECHO);
    useShim("codex-cli", ECHO);
    const pools = Object.fromEntries(
      synthesizeExtendedRoutes().routes.map((r) => [r.api, r.pool]),
    );
    // One subscription = one pool. A private pool would tell the rotator it
    // had two independent ledgers and drain the single real one twice as fast.
    expect(pools["claude-code"]).toBe("anthropic:max-plan");
    // The Codex plan really is a ledger nothing else in the catalog reaches.
    expect(pools["codex-cli"]).toBe("codex:plan");
  });

  it("synthesized routes are flat-rate, never paid-metered", () => {
    useShim("claude-code", ECHO);
    useShim("codex-cli", ECHO);
    vi.stubEnv("FACTORY_CURSOR_BASE_URL", "http://127.0.0.1:3000/v1");
    const { routes } = synthesizeExtendedRoutes();
    expect(routes).toHaveLength(3);
    for (const r of routes) expect(r.cost_class).toBe("subscription");
  });

  it("contributes nothing at all when the extensions switch is off", () => {
    useShim("claude-code", ECHO);
    vi.stubEnv("FACTORY_ROTATION_EXTENSIONS", "0");
    const { routes, skipped } = synthesizeExtendedRoutes();
    expect(routes).toHaveLength(0);
    expect(Object.values(skipped).join(" ")).toMatch(/FACTORY_ROTATION_EXTENSIONS/);
  });
});

// --------------------------------------------------------------------------
describe("rotation over the CLI pools", () => {
  function provider(app = "factory-deck", signal?: AbortSignal): RotatingProvider {
    const built = buildRotator(app);
    if (!built) throw new Error("no rotator for test");
    const filtered = filterRoutableCatalog(built, "", () => {});
    if (!filtered) throw new Error("nothing routable for test");
    return new RotatingProvider(filtered, {
      fccDelegate: null,
      fccBaseUrl: "",
      tier: "frontier",
      signal,
    });
  }

  it("a rotated call is really served by the CLI subprocess", async () => {
    useShim("claude-code", ECHO);
    writeCatalog([cliRow("claude-code", "anthropic:max-plan")]);
    const out = await provider().generateText({
      system: "SYS",
      prompt: "BUILD THE THING",
    });
    expect(out.text).toContain("BUILD THE THING");
    expect(out.provider).toBe("free");
    // The pool was credited in the SHARED ledger, like any other pool.
    expect(new StateStore().read().pools["anthropic:max-plan"].calls).toBe(1);
  });

  it("the run's DIRECTED WORK THEME reaches the CLI child", async () => {
    useShim("claude-code", ECHO);
    writeCatalog([cliRow("claude-code", "anthropic:max-plan")]);
    const themed = new ThemedProvider(provider());
    await withWorkTheme(
      {
        theme: "Lorain Assembly: ship the rivet counter",
        issue: "rivetCount.test.ts is red",
        constraints: ["Never edit dist/"],
      },
      () => themed.generateText({ system: "SYS", prompt: "p" }),
    );
    const seen = fs.readFileSync(capturePath(), "utf8");
    expect(seen).toContain("DIRECTED WORK THEME");
    expect(seen).toContain("Lorain Assembly: ship the rivet counter");
    expect(seen).toContain("rivetCount.test.ts is red");
    expect(seen).toContain("Never edit dist/");
  });

  it("a failing CLI pool rolls over to another pool instead of erroring out", async () => {
    useShim("claude-code", FAIL);
    useShim("codex-cli", ECHO);
    writeCatalog([
      cliRow("claude-code", "anthropic:max-plan"),
      cliRow("codex-cli", "codex:plan"),
    ]);
    const out = await provider().generateText({ system: "SYS", prompt: "ROLLOVER" });
    expect(out.text).toContain("ROLLOVER");
  });

  it("a PAID CLI route is refused — rotation never promotes a cost class", async () => {
    useShim("claude-code", ECHO);
    writeCatalog([
      { ...cliRow("claude-code", "anthropic:max-plan"), cost_class: "paid-metered" },
    ]);
    await expect(
      provider().generateText({ system: "SYS", prompt: "p" }),
    ).rejects.toThrow();
    expect(fs.existsSync(capturePath())).toBe(false);
  });

  it("an extended route is never POSTed over plain HTTP", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: unknown) => {
        calls.push(String(u));
        return new Response("{}", { status: 200 });
      }),
    );
    useShim("claude-code", ECHO);
    writeCatalog([cliRow("claude-code", "anthropic:max-plan")]);
    await provider().generateText({ system: "SYS", prompt: "p" });
    expect(calls).toEqual([]);
  });

  it("Purpose Foundry rotates over the same pools as Factory Deck", async () => {
    useShim("claude-code", ECHO);
    writeCatalog([cliRow("claude-code", "anthropic:max-plan")]);
    const out = await provider("purpose-foundry").generateText({
      system: "SYS",
      prompt: "FOUNDRY WORK",
    });
    expect(out.text).toContain("FOUNDRY WORK");
  });
});

// --------------------------------------------------------------------------
/**
 * REAL binaries. Everything above proves the shape; this proves the transport
 * against the actual CLIs installed on the machine. It builds the provider the
 * catalog filter would build and executes it — a PATH hit is not proof, so the
 * proof is running the thing.
 *
 * Skipped (not failed) where a CLI is absent: a machine without `codex`
 * installed is a legitimate machine, and this must not turn CI red there.
 */
describe("real CLI binaries on this machine", () => {
  for (const api of ["claude-code", "codex-cli"] as const) {
    it(`${api}: constructs from PATH and answers --version`, async () => {
      // Undo the isolation stub so PATH is consulted for real.
      vi.stubEnv(
        `FACTORY_CLI_BIN_${api.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}`,
        "",
      );
      const resolved = cliBinaryFor(api);
      if (!resolved) {
        console.log(`[skip] ${api} is not installed on this machine`);
        return;
      }
      const provider = makeCliProvider({ api, model: `${api}-cli` });
      expect(provider.binary).toBe(resolved);
      // Flat-rate: a rotated call through this transport bills $0.
      expect(provider.meter).toBe(`${api}:subscription`);
      expect(await provider.ping(45_000)).toBe(true);
    });
  }
});
