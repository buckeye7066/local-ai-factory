/**
 * extendedAdapterMissing.test.ts — the failure this whole design exists for.
 *
 * FlexFactor's first draft guarded the CLI routes with a PATH probe and
 * imported an adapter module that did not exist. Both binaries ARE on PATH on
 * this machine, so the filter ADMITTED the routes and the run raised
 * ModuleNotFoundError on selection — an unbuildable route reaching the
 * rotator, failing at call time, and burning a cooldown on a pool that was
 * never broken.
 *
 * So the rule is: admit only what is provably BUILDABLE, and report
 * unbuildable as a NAMED REASON rather than an exception — one broken adapter
 * must never take the whole catalog filter down with it.
 *
 * This file breaks the adapter on purpose and asserts both halves of that.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-missing-test-"));
  vi.stubEnv("AITIME_STATE_DIR", dir);
  vi.stubEnv("AI_ROTATE", "on");
  vi.stubEnv("AI_ROTATE_PIN", "");
  vi.stubEnv("FACTORY_ROTATION_EXTENSIONS", "1");
  vi.stubEnv("FACTORY_CURSOR_BASE_URL", "http://127.0.0.1:3000/v1");
});

afterEach(() => {
  vi.doUnmock("../providers/cliProvider.js");
  vi.resetModules();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Make the CLI adapter unloadable, exactly as a deleted file would. */
async function withBrokenCliAdapter() {
  vi.resetModules();
  // Resolve the adapter to a module that does not exist on disk. This is a
  // REAL resolution failure — the same one a deleted cliProvider.ts produces —
  // rather than a hand-thrown Error that could accidentally take a nicer path.
  vi.doMock(
    "../providers/cliProvider.js",
    async () =>
      // @ts-expect-error deliberately unresolvable — the failure under test.
      await import("../providers/__deleted_cli_adapter__.js"),
  );
  return {
    ext: await import("../providers/extendedTransports.js"),
    rot: await import("../rotation/rotatingProvider.js"),
    ait: await import("../rotation/aitimeRotation.js"),
  };
}

function writeCatalog(rows: Array<Record<string, unknown>>): void {
  fs.writeFileSync(
    path.join(dir, "routes.json"),
    JSON.stringify({ schema: 1, generated_at: new Date().toISOString(), routes: rows }),
  );
}

function httpRow(id: string, pool: string): Record<string, unknown> {
  return {
    id,
    backend: id.split("/")[0],
    model: id.split("/")[1],
    wire_model: id.split("/")[1],
    api: "openai",
    base_url: "https://example.invalid/v1",
    pool,
    auth_env: "",
    auth_kind: "none",
    cost_class: "free-tier",
    tier: "frontier",
    enabled: true,
  };
}

function cliRow(api: "claude-code" | "codex-cli"): Record<string, unknown> {
  return {
    id: `${api}/${api}-cli`,
    backend: api,
    model: `${api}-cli`,
    wire_model: `${api}-cli`,
    api,
    base_url: "",
    pool: `${api}:plan`,
    auth_env: "",
    auth_kind: "none",
    cost_class: "subscription",
    tier: "frontier",
    enabled: true,
  };
}

describe("a missing/broken CLI adapter", () => {
  it("is reported as a NAMED reason, never thrown", async () => {
    const { ext } = await withBrokenCliAdapter();
    for (const api of ["claude-code", "codex-cli"]) {
      expect(() => ext.extendedRouteUnusableReason({ api })).not.toThrow();
      const reason = ext.extendedRouteUnusableReason({ api });
      // The reason NAMES the failure. (The literal resolver text is not
      // asserted: vitest rewrites a mock-load failure with its own wording.
      // The unrewritten "Cannot find module" proof is the real file-deletion
      // run recorded in the commit message.)
      expect(reason).toMatch(/adapter unavailable \(/);
      expect(reason).toMatch(/^cli|^claude-code|^codex-cli/);
    }
  });

  it("does not take its SIBLING adapter down: Cursor still evaluates", async () => {
    const { ext } = await withBrokenCliAdapter();
    expect(ext.extendedRouteUnusableReason({ api: "cursor" })).toBe("");
    // ...and Cursor is still contributed as a pool.
    const { routes } = ext.synthesizeExtendedRoutes();
    expect(routes.map((r) => r.api)).toEqual(["cursor"]);
  });

  it("EXCLUDES the CLI routes while every other route still evaluates", async () => {
    const { ext, rot, ait } = await withBrokenCliAdapter();
    writeCatalog([
      cliRow("claude-code"),
      cliRow("codex-cli"),
      httpRow("groq/llama-3.3", "groq:free-tier"),
      httpRow("cerebras/qwen", "cerebras:free-tier"),
    ]);
    const built = ait.buildRotator("factory-deck");
    expect(built).not.toBeNull();

    const messages: string[] = [];
    const filtered = rot.filterRoutableCatalog(built!, "", (_k, m) => {
      messages.push(m);
    });
    expect(filtered).not.toBeNull();
    const ids = filtered!.catalog.routes.map((r) => r.id).sort();

    // The unbuildable routes never reach the rotator...
    expect(ids).not.toContain("claude-code/claude-code-cli");
    expect(ids).not.toContain("codex-cli/codex-cli-cli");
    // ...the healthy HTTP routes are untouched...
    expect(ids).toContain("groq/llama-3.3");
    expect(ids).toContain("cerebras/qwen");
    // ...and the working sibling adapter is still admitted.
    expect(ids).toContain("cursor/cursor-default");

    // The exclusion is LOUD and NAMED — never a silent drop.
    const log = messages.join("\n");
    expect(log).toMatch(/extended transport\(s\) not admitted/);
    expect(log).toMatch(/adapter unavailable \(/);

    // And the surviving catalog is genuinely routable: it must not have been
    // reduced to nothing by one broken adapter.
    expect(filtered!.catalog.enabled().length).toBeGreaterThanOrEqual(3);
    void ext;
  });
});
