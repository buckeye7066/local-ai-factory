import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// The UI is a pure local SPA. It talks to the local backend (default :5179)
// through a dev proxy so the browser never needs to know the backend port,
// and — critically — never receives API keys (those live only on the server).
export default defineConfig({
  root: fileURLToPath(new URL("./src/ui", import.meta.url)),
  plugins: [react()],
  server: {
    // 5190, not 5180: Docker Desktop publishes 5180 machine-wide for
    // family-stewardship-navigator's web container (com.docker.backend owns
    // it), so Factory Deck's dev UI could never bind while Docker ran — the
    // exact "PORT HELD BY A PROTECTED PROCESS" class EVA reported nightly for
    // are-we-mice/mind-over-math on 3001.
    port: 5190,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:5179",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: fileURLToPath(new URL("./dist/ui", import.meta.url)),
    emptyOutDir: true,
  },
});
