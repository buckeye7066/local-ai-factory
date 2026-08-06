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
    port: 5180,
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
