/**
 * GrantFlow operational memory bridge.
 *
 * Shared memory is the Obsidian AI Bus, never a second per-app database.
 * This CLI is safe to run at process start; programmatic callers may import
 * recall() and remember() before/after non-trivial AI or agent work.
 */
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

const APP = process.env.OBSIDIAN_MEMORY_APP?.trim() || process.env.npm_package_name?.trim() || path.basename(process.cwd());
const VAULT = process.env.AIBUS_VAULT?.trim() || String.raw`G:\\Obsidian Vault`;
const SCRIPT = process.env.OBSIDIAN_MEMORY_AIBUS_PATH?.trim() || path.join(VAULT, "AI Bus", "aibus.py");
const PYTHON = process.env.OBSIDIAN_MEMORY_PYTHON?.trim() || process.env.PYTHON?.trim() || "python";
const BLOCKED = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:api[_-]?key|secret|token|password|authorization)\b\s*[:=]/i,
  /\b(?:sk|rk|ghp|github_pat)_[A-Za-z0-9_-]{12,}/,
  /\b(?:\d[ -]*?){13,19}\b/,
];

export function runAibus(args, { timeoutMs = 30_000, runner } = {}) {
  if (runner) return runner(args);
  return new Promise((resolve) => {
    if (!existsSync(SCRIPT)) return resolve({ ok: false, code: "aibus_unavailable", detail: `AI Bus engine not found at ${SCRIPT}` });
    let stdout = "", stderr = "", settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    let child;
    try { child = spawn(PYTHON, [SCRIPT, ...args], { shell: false, windowsHide: true }); }
    catch (error) { return finish({ ok: false, code: "aibus_spawn_failed", detail: String(error?.message || error) }); }
    const timer = setTimeout(() => { child.kill(); finish({ ok: false, code: "aibus_timeout", detail: "AI Bus timed out" }); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); finish({ ok: false, code: "aibus_spawn_failed", detail: String(error?.message || error) }); });
    child.on("close", (status) => {
      clearTimeout(timer);
      finish(status === 0 ? { ok: true, output: stdout.trim() } : { ok: false, code: "aibus_failed", detail: (stderr || stdout || `exit ${status}`).trim().slice(0, 500) });
    });
  });
}

export async function recall(query, { limit = 8, runner } = {}) {
  const clean = String(query ?? "").trim();
  if (!clean) return { ok: false, code: "empty_query", detail: "A recall query is required." };
  const result = await runAibus(["recall", "--limit", String(Math.max(1, Math.min(25, Number(limit) || 8))), APP, ...clean.split(/\s+/)], { runner });
  return result.ok ? { ok: true, query: clean, results: result.output || "(nothing in the vault matches)" } : result;
}

export async function remember({ title, content, tag = "project", runner } = {}) {
  const heading = String(title ?? "").trim(), body = String(content ?? "").trim();
  if (!heading || !body) return { ok: false, code: "empty_memory", detail: "A title and non-empty project lesson are required." };
  if (heading.length + body.length > 4_000 || BLOCKED.some((pattern) => pattern.test(heading + "\n" + body))) {
    return { ok: false, code: "unsafe_memory", detail: "Shared memory rejects sensitive, secret-bearing, or oversized content." };
  }
  const result = await runAibus(["note", "--from", process.env.OBSIDIAN_MEMORY_AGENT?.trim() || APP, "--title", `[${APP}] ${heading}`, "--tag", String(tag || "project"), body], { runner });
  return result.ok ? { ok: true, title: heading, detail: result.output } : result;
}

export async function health({ runner } = {}) {
  const result = await recall("continuity decisions blockers", { limit: 1, runner });
  return result.ok ? { ok: true, reachable: true, vault: VAULT, script: SCRIPT } : { ok: false, reachable: false, vault: VAULT, script: SCRIPT, code: result.code, detail: result.detail };
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  const [command = "startup", ...arguments_] = process.argv.slice(2);
  const result = command === "note"
    ? await remember({ title: arguments_[0], content: arguments_.slice(1).join(" ") })
    : command === "recall"
      ? await recall(arguments_.join(" "))
      : await health();
  if (command === "startup") {
    console[result.ok ? "info" : "warn"](`[obsidian-memory] ${result.ok ? "recall available" : `unavailable: ${result.detail}`}`);
    process.exitCode = 0;
  } else {
    console.log(JSON.stringify(result));
    process.exitCode = result.ok ? 0 : 1;
  }
}
