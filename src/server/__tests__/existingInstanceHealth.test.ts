import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { FATAL_EXIT_CODE } from "../exitCodes.js";

const ROOT = resolve(process.cwd());
const TSX_LOADER = pathToFileURL(createRequire(resolve(ROOT, "package.json")).resolve("tsx")).href;

// Exercise the actual entry process, not a source-text or payload-only check.
describe("existing Factory Deck instance health", () => {
  it.each([
    { name: "healthy instance", status: 200, service: "factory-deck", redirect: false, expected: 0 },
    { name: "unhealthy HTTP status", status: 503, service: "factory-deck", redirect: false, expected: FATAL_EXIT_CODE },
    { name: "foreign service", status: 200, service: "other-service", redirect: false, expected: FATAL_EXIT_CODE },
    { name: "redirected health", status: 302, service: "factory-deck", redirect: true, expected: FATAL_EXIT_CODE },
  ])("classifies $name without accepting another endpoint", async (scenario) => {
    const root = mkdtempSync(join(tmpdir(), "factory-existing-health-"));
    const requests: string[] = [];
    const listener = createServer((request, response) => {
      requests.push(request.url ?? "");
      if (scenario.redirect && request.url === "/api/health") {
        response.writeHead(302, { location: "/healthy" });
        response.end();
        return;
      }
      response.writeHead(scenario.redirect ? 200 : scenario.status, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, service: scenario.service }));
    });
    let child: ReturnType<typeof spawn> | undefined;
    let output = "";
    try {
      listener.listen(0, "127.0.0.1");
      await once(listener, "listening");
      const address = listener.address();
      if (!address || typeof address === "string") throw new Error("Missing listener port.");
      child = spawn(process.execPath, ["--import", TSX_LOADER, resolve(ROOT, "src/server/index.ts")], {
        // No owner's .env or durable run data may enter this process test.
        cwd: root,
        env: {
          ...process.env,
          PORT: String(address.port),
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
      const [code, signal] = await once(child, "exit", { signal: AbortSignal.timeout(20_000) });
      expect(signal, output).toBeNull();
      expect(code, output).toBe(scenario.expected);
      expect(requests).toEqual(["/api/health"]);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const stopped = once(child, "exit", { signal: AbortSignal.timeout(5_000) });
        child.kill("SIGKILL");
        await stopped;
      }
      listener.closeAllConnections();
      await new Promise<void>((done, reject) => listener.close((error) => error ? reject(error) : done()));
      rmSync(root, { recursive: true, force: true });
    }
  });
});
