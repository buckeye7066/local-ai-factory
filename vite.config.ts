import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

function port(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!/^\d{1,5}$/.test(value) || !Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return parsed;
}

/** Dedicated test ports never change the normal developer defaults. */
export function developmentServerConfig(env: Record<string, string | undefined> = process.env) {
  const uiPort = port(env.FACTORY_UI_PORT, 5190, "FACTORY_UI_PORT");
  const apiPort = port(env.FACTORY_API_PROXY_PORT, 5179, "FACTORY_API_PROXY_PORT");
  if (uiPort === apiPort) throw new Error("Factory UI and API ports must differ");
  return {
    port: uiPort,
    host: "127.0.0.1",
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
      },
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL("./src/ui", import.meta.url)),
  plugins: [react()],
  // 5190 remains the UI default: 5180 is occupied by Docker on the workstation.
  // EVA pins both this UI and its API proxy explicitly instead of killing an
  // existing service or accepting a response from the wrong process.
  server: developmentServerConfig(),
  build: {
    outDir: fileURLToPath(new URL("./dist/ui", import.meta.url)),
    emptyOutDir: true,
  },
});
