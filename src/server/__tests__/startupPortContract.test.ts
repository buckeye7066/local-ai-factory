import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import viteConfig from "../../../vite.config.js";
import { loadConfig } from "../config.js";

const ROOT = resolve(process.cwd());
const temporaryRoots: string[] = [];

async function availableLoopbackPort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolveListen, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolveListen);
  });
  const address = socket.address();
  if (!address || typeof address === "string") {
    socket.close();
    throw new Error("Could not allocate a loopback test port.");
  }
  await new Promise<void>((resolveClose, reject) =>
    socket.close((error) => (error ? reject(error) : resolveClose())),
  );
  return address.port;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    once(child, "exit"),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Factory test listener did not stop.")), 5_000),
    ),
  ]);
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Factory Deck startup port contract", () => {
  it("keeps the declared dev command, UI port, API port, and proxy target aligned", () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const apiPort = loadConfig({}).port;
    const server = viteConfig.server as {
      host?: string;
      port?: number;
      strictPort?: boolean;
      proxy?: Record<string, { target?: string }>;
    };

    expect(pkg.scripts.dev).toContain("node --import tsx src/server/index.ts");
    expect(pkg.scripts.dev).toContain("vite");
    expect(apiPort).toBe(5179);
    expect(server).toMatchObject({ host: "127.0.0.1", port: 5190, strictPort: true });
    expect(server.proxy?.["/api"]?.target).toBe(`http://127.0.0.1:${apiPort}`);
  });

  it("binds the backend to launch_env PORT and answers its readiness URL there", async () => {
    const port = await availableLoopbackPort();
    const root = mkdtempSync(join(tmpdir(), "factory-startup-contract-"));
    temporaryRoots.push(root);
    let output = "";
    const child = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        FACTORY_DATA_DIR: join(root, "data"),
        WORKSPACE_ROOT: join(root, "workspaces"),
        FACTORY_BIND_LAN: "0",
        FACTORY_AUTH_TOKEN: "",
        FACTORY_FREE_ENABLED: "0",
        FACTORY_RESEARCH_ENABLED: "0",
        ANTHROPIC_API_KEY: "",
        OPENAI_API_KEY: "",
        AI_ROTATE: "off",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => (output += String(chunk)));
    child.stderr?.on("data", (chunk) => (output += String(chunk)));

    try {
      const readinessUrl = `http://127.0.0.1:${port}/api/health`;
      let health: { service?: unknown; ok?: unknown } | undefined;
      for (let attempt = 0; attempt < 100 && !health; attempt += 1) {
        if (child.exitCode !== null) {
          throw new Error(
            `Factory exited before readiness (${child.exitCode}): ${output}`,
          );
        }
        try {
          const response = await fetch(readinessUrl, {
            signal: AbortSignal.timeout(500),
          });
          if (response.ok) health = (await response.json()) as typeof health;
        } catch {
          await new Promise((resolveWait) => setTimeout(resolveWait, 50));
        }
      }

      expect(health, output).toMatchObject({ service: "factory-deck", ok: true });
      expect(output).toContain(`backend listening on http://127.0.0.1:${port}`);
    } finally {
      await stop(child);
    }
  });
});
