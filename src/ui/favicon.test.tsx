/**
 * The favicon must actually ship (owner report 2026-08-16: every page load of
 * the server-served UI on :5179 logged "favicon.ico 404" — the deck icon
 * existed in assets/ but was never wired into the web UI).
 *
 * Two halves, both required:
 *  - public/favicon.ico exists  → Vite copies public/ into dist/ui at build,
 *    so BOTH serving modes (vite dev on :5190, express.static(dist/ui) on the
 *    backend port) answer the browser's automatic /favicon.ico probe.
 *  - index.html links it        → the tab shows the deck icon instead of
 *    relying on the probe fallback.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const uiRoot = dirname(fileURLToPath(import.meta.url));

describe("favicon ships with the UI", () => {
  it("public/favicon.ico exists and is a real file, not an empty stub", () => {
    const ico = resolve(uiRoot, "public", "favicon.ico");
    expect(existsSync(ico)).toBe(true);
    expect(statSync(ico).size).toBeGreaterThan(0);
  });

  it("index.html declares the icon link", () => {
    const html = readFileSync(resolve(uiRoot, "index.html"), "utf8");
    expect(html).toMatch(/<link rel="icon" href="\/favicon\.ico"/);
  });
});
