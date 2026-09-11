import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Client mistakes must come back as client errors, in JSON, from the REAL
 * server process. Live-test 2026-09-11 found each of these answered as a 500,
 * an Express HTML page, or a 201 for a run that could only die at intake.
 */
const ROOT = resolve(process.cwd());
const TSX_LOADER = pathToFileURL(
  createRequire(resolve(ROOT, "package.json")).resolve("tsx"),
).href;
const TOKEN = "api-client-errors-test-token";

async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  const port = address && typeof address !== "string" ? address.port : 0;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}

let root = "";
let base = "";
let child: ChildProcess | undefined;
let output = "";

async function call(
  path: string,
  init: { method?: string; body?: string } = {},
): Promise<{ status: number; type: string; json: Record<string, unknown> | null }> {
  const response = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: init.body,
  });
  const text = await response.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return {
    status: response.status,
    type: response.headers.get("content-type") ?? "",
    json,
  };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "factory-api-client-errors-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(
    process.execPath,
    ["--import", TSX_LOADER, resolve(ROOT, "src/server/index.ts")],
    {
      // No owner's .env or durable run data may enter this process test.
      cwd: root,
      env: {
        ...process.env,
        PORT: String(port),
        FACTORY_DATA_DIR: join(root, "data"),
        WORKSPACE_ROOT: join(root, "workspaces"),
        FACTORY_BIND_LAN: "0",
        FACTORY_AUTH_TOKEN: TOKEN,
        FACTORY_FREE_ENABLED: "0",
        FACTORY_RESEARCH_ENABLED: "0",
        ANTHROPIC_API_KEY: "",
        OPENAI_API_KEY: "",
        AI_ROTATE: "off",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (chunk) => (output += String(chunk)));
  child.stderr?.on("data", (chunk) => (output += String(chunk)));
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const health = await fetch(`${base}/api/health`);
      if (health.ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${output}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}, 90_000);

afterAll(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const stopped = once(child, "exit", { signal: AbortSignal.timeout(10_000) });
    child.kill("SIGKILL");
    await stopped.catch(() => undefined);
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("API client errors are client errors (actual server process)", () => {
  it("answers malformed JSON with 400 JSON, not 500", async () => {
    const res = await call("/api/runs", { method: "POST", body: "{bad" });
    expect(res.status, output).toBe(400);
    expect(res.json?.error).toEqual(expect.any(String));
  });

  it("answers an unknown /api route with 404 JSON, not an HTML page", async () => {
    const res = await call("/api/definitely-not-a-route");
    expect(res.status).toBe(404);
    expect(res.type).toContain("application/json");
    expect(res.json?.error).toEqual(expect.any(String));
  });

  it("answers resume of a run that does not exist with 404", async () => {
    const res = await call("/api/runs/00000000-0000-4000-8000-000000000000/resume", {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(404);
    expect(res.json?.error).toBe("Run not found.");
  });

  it.each([
    ["GET", "/api/foundry/projects/not-a-uuid"],
    ["POST", "/api/foundry/projects/not-a-uuid/start"],
    ["POST", "/api/foundry/projects/not-a-uuid/stations/repo-rewards/run"],
  ])("answers %s %s for a malformed project id with 404", async (method, path) => {
    const res = await call(path, {
      method,
      body: method === "POST" ? "{}" : undefined,
    });
    expect(res.status).toBe(404);
    expect(res.json?.error).toBe("Purpose Foundry project not found.");
  });

  it("refuses a local-only new app without a project identity BEFORE creating a run", async () => {
    const res = await call("/api/runs", {
      method: "POST",
      body: JSON.stringify({
        idea: "Build a tiny unit converter",
        options: {
          mode: "new",
          newRepo: { name: "unit-converter", createRemote: false },
        },
      }),
    });
    expect(res.status).toBe(400);
    expect(String(res.json?.error)).toContain("options.projectId");
    const runs = await call("/api/runs");
    expect(runs.json?.runs).toEqual([]);
  });

  it("refuses a new app with neither a repository nor a project identity", async () => {
    const res = await call("/api/runs", {
      method: "POST",
      body: JSON.stringify({ idea: "Build a tiny unit converter" }),
    });
    expect(res.status).toBe(400);
    expect(String(res.json?.error)).toContain("options.projectId");
  });

  it("applies the same identity rule to epics before planning spends a model call", async () => {
    const res = await call("/api/epics", {
      method: "POST",
      body: JSON.stringify({
        idea: "Build a tiny unit converter",
        options: { mode: "new" },
      }),
    });
    expect(res.status).toBe(400);
    expect(String(res.json?.error)).toContain("options.projectId");
  });
});
