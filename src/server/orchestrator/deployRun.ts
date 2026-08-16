import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecResult } from "../workspace/gitOps.js";

/**
 * deployRun.ts — the from-scratch twin of releaseRun.ts (owner order
 * 2026-08-15): "It should be able to open a new repo for a new program,
 * vercel, railway, etc." A new program is not in production as a repo nobody
 * can visit — delivery finishes by putting it on a real host and PROVING the
 * URL answers.
 *
 * Target choice is mechanical, from the app's own shape:
 *   - package.json with a `start` script → a server → Railway
 *     (init → up --detach → domain → probe).
 *   - otherwise, an index.html anywhere obvious → a static/frontend app →
 *     Vercel (link --yes → deploy --prod --yes → probe).
 *   - neither → honestly not deployable by this stage; the reason says why.
 *
 * The SAME evidence gate as releaseRun applies upstream (grounded QA green +
 * tests executed green) — the caller enforces it. "Deployed" is claimed ONLY
 * after this stage observes the live URL answering (<500) with its own HTTP
 * probe; a deploy whose URL never answered in the window is reported as
 * "deployed but unverified", never as live. Deploy failures never fail the
 * run — the repo is delivered either way.
 *
 * Windows note: railway/vercel npm installs are .cmd/.ps1 shims; spawning
 * those through cmd.exe is the quote-strip trap that caused real fabrication
 * cascades here. So the CLIs are invoked as `node <resolved-cli.js>` with
 * shell:false — no cmd.exe anywhere.
 */

export interface DeployInput {
  workspacePath: string;
  appName: string | null;
  runId: string;
  execImpl?: ExecFn;
  /** Injectable CLI resolution for tests (default: resolveNpmCli). */
  cliPathImpl?: (relEntry: string) => string | null;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  /** Max time to wait for the deployed URL to answer. */
  probeTimeoutMs?: number;
}

export interface DeployResult {
  deployed: boolean;
  /** Live URL when one was obtained (even if unverified). */
  url: string | null;
  target: "railway" | "vercel" | null;
  /** True only when the URL was observed answering (<500) by our probe. */
  verified: boolean;
  reason: string;
}

export type ExecFn = (
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
) => Promise<ExecResult>;

const defaultExec: ExecFn = (bin, args, cwd, timeoutMs) =>
  new Promise((resolveP) => {
    const child = spawn(bin, args, { cwd, shell: false });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolveP({ code: null, stdout, stderr, spawnError: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveP({
        code,
        stdout: stdout.trim(),
        stderr: stderr.slice(-4000).trim(),
        spawnError: null,
      });
    });
  });

/** Resolve a global-npm CLI to its real JS entry so it runs via `node`. */
export function resolveNpmCli(relEntry: string): string | null {
  const roots = [
    process.env.APPDATA ? join(process.env.APPDATA, "npm", "node_modules") : null,
    "/usr/local/lib/node_modules",
    "/usr/lib/node_modules",
  ].filter((r): r is string => r != null);
  for (const root of roots) {
    const p = join(root, relEntry);
    if (existsSync(p)) return p;
  }
  return null;
}

const RAILWAY_ENTRY = join("@railway", "cli", "bin", "railway.js");
const VERCEL_ENTRY = join("vercel", "dist", "vc.js");

/** Mechanical target choice from the app's own shape. Exported for tests. */
export function chooseTarget(workspacePath: string): {
  target: "railway" | "vercel" | null;
  reason: string;
} {
  const pkgPath = join(workspacePath, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        scripts?: Record<string, string>;
      };
      if (pkg.scripts?.start) {
        return { target: "railway", reason: "package.json has a start script (server app)" };
      }
    } catch {
      /* unreadable package.json falls through to the static checks */
    }
  }
  for (const candidate of ["index.html", "public/index.html", "dist/index.html"]) {
    if (existsSync(join(workspacePath, candidate))) {
      return { target: "vercel", reason: `static/frontend app (${candidate})` };
    }
  }
  return {
    target: null,
    reason:
      "no start script and no index.html — this stage cannot pick a host for the app's shape",
  };
}

const URL_RE = /https:\/\/[^\s"']+/;

async function probe(
  url: string,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetchImpl(url, { redirect: "follow" });
      if (res.status < 500) return true;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) return false;
    await sleep(15_000);
  }
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "factory-app"
  );
}

export async function deployRun(input: DeployInput): Promise<DeployResult> {
  const exec = input.execImpl ?? defaultExec;
  const fetchImpl = input.fetchImpl ?? fetch;
  const sleep =
    input.sleepImpl ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const probeTimeoutMs = input.probeTimeoutMs ?? 8 * 60_000;
  const cwd = input.workspacePath;
  const name = slugify(input.appName ?? input.runId.slice(0, 8));

  const chosen = chooseTarget(cwd);
  if (!chosen.target) {
    return { deployed: false, url: null, target: null, verified: false, reason: chosen.reason };
  }

  const resolveCli = input.cliPathImpl ?? resolveNpmCli;
  const entry = resolveCli(chosen.target === "railway" ? RAILWAY_ENTRY : VERCEL_ENTRY);
  if (!entry) {
    return {
      deployed: false,
      url: null,
      target: chosen.target,
      verified: false,
      reason: `${chosen.target} CLI is not installed globally (npm i -g ${
        chosen.target === "railway" ? "@railway/cli" : "vercel"
      })`,
    };
  }
  const cli = (args: string[], timeoutMs: number) =>
    exec(process.execPath, [entry, ...args], cwd, timeoutMs);

  const failText = (r: ExecResult) =>
    r.spawnError ?? `${r.stderr || r.stdout || "no output"} (exit ${r.code})`;

  let url: string | null = null;

  if (chosen.target === "railway") {
    const init = await cli(["init", "--name", name], 120_000);
    // An already-linked workspace dir reports an existing project — not fatal.
    if (init.code !== 0 && !/already|exists/i.test(init.stderr + init.stdout)) {
      return {
        deployed: false, url: null, target: "railway", verified: false,
        reason: `railway init failed: ${failText(init)}`,
      };
    }
    const up = await cli(["up", "--detach"], 300_000);
    if (up.code !== 0) {
      return {
        deployed: false, url: null, target: "railway", verified: false,
        reason: `railway up failed: ${failText(up)}`,
      };
    }
    const domain = await cli(["domain"], 120_000);
    url = URL_RE.exec(domain.stdout + " " + domain.stderr)?.[0] ?? null;
    if (!url) {
      return {
        deployed: true, url: null, target: "railway", verified: false,
        reason: `deployed to Railway but no domain was obtained: ${failText(domain)}`,
      };
    }
  } else {
    const link = await cli(["link", "--yes", "--project", name], 120_000);
    if (link.code !== 0) {
      return {
        deployed: false, url: null, target: "vercel", verified: false,
        reason: `vercel link failed: ${failText(link)}`,
      };
    }
    const deploy = await cli(["deploy", "--prod", "--yes"], 600_000);
    if (deploy.code !== 0) {
      return {
        deployed: false, url: null, target: "vercel", verified: false,
        reason: `vercel deploy failed: ${failText(deploy)}`,
      };
    }
    url = URL_RE.exec(deploy.stdout + " " + deploy.stderr)?.[0] ?? null;
    if (!url) {
      return {
        deployed: true, url: null, target: "vercel", verified: false,
        reason: "vercel deploy succeeded but printed no production URL",
      };
    }
  }

  const alive = await probe(url, fetchImpl, sleep, probeTimeoutMs);
  return {
    deployed: true,
    url,
    target: chosen.target,
    verified: alive,
    reason: alive
      ? `live at ${url} (observed answering)`
      : `deployed but unverified — ${url} did not answer (<500) within the probe window`,
  };
}
