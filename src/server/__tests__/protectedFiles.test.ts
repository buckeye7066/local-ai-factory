import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  assessProtectedHostWrite,
  exportedSymbols,
  isFactoryOverlayPath,
  _resetProtectedFilesCache,
} from "../workspace/protectedFiles.js";

const workspaces: string[] = [];
function gitWorkspace(files: Record<string, string>): string {
  const path = mkdtempSync(join(tmpdir(), "factory-protected-"));
  workspaces.push(path);
  for (const [rel, contents] of Object.entries(files)) {
    const absolute = join(path, rel);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", path, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "host");
  return path;
}
afterEach(() => {
  _resetProtectedFilesCache();
  for (const path of workspaces.splice(0)) {
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

const HOST_MANIFEST = JSON.stringify({
  name: "grant-flow",
  scripts: Object.fromEntries(
    Array.from({ length: 87 }, (_, i) => [`script${i}`, "echo ok"]),
  ),
});

describe("assessProtectedHostWrite", () => {
  it("refuses the a8a9c84a stub: a 192-byte replacement of a 10KB tracked package.json", () => {
    const ws = gitWorkspace({
      "package.json": HOST_MANIFEST,
      "package-lock.json": "{}",
    });
    const stub =
      '{"name":"grant-flow","private":true,"type":"module","scripts":{"test":"vitest run"}}';
    const verdict = assessProtectedHostWrite(ws, "package.json", stub);
    expect(verdict.refused).toBe(true);
    expect(verdict.reason).toMatch(/dependency-map entries/);
  });

  it("ALLOWS additive package.json edits (adding a dependency must keep working)", () => {
    const ws = gitWorkspace({ "package.json": HOST_MANIFEST });
    const grown = HOST_MANIFEST.replace(
      '"name"',
      '"devDependencies":{"axe-core":"^4.9.0"},"name"',
    );
    expect(assessProtectedHostWrite(ws, "package.json", grown).refused).toBe(false);
  });

  it.each([
    [
      "changes the test script",
      (manifest: Record<string, any>) => {
        manifest.scripts.test = "echo src/generated.test.ts";
      },
    ],
    [
      "adds a pretest hook",
      (manifest: Record<string, any>) => {
        manifest.scripts.pretest = "node rewrite-test-config.js";
      },
    ],
    [
      "removes workspaces",
      (manifest: Record<string, any>) => {
        delete manifest.workspaces;
      },
    ],
    [
      "adds inline test discovery config",
      (manifest: Record<string, any>) => {
        manifest.vitest = { include: ["src/generated.test.ts"] };
      },
    ],
  ])("refuses package.json verification laundering: %s", (_name, mutate) => {
    const host = {
      name: "host",
      workspaces: ["apps/*"],
      scripts: {
        test: "npm run lint && npm run typecheck && npm run unit",
        unit: "vitest run",
        lint: "eslint .",
        typecheck: "tsc --noEmit",
      },
      dependencies: { react: "19" },
    };
    const before = JSON.stringify(host);
    const changed = structuredClone(host) as Record<string, any>;
    mutate(changed);
    const after = JSON.stringify(changed);
    expect(after.length).toBeGreaterThan(before.length * 0.8);
    const ws = gitWorkspace({ "package.json": before });
    expect(assessProtectedHostWrite(ws, "package.json", after).refused).toBe(true);
  });

  it("refuses every generated write to tracked lockfiles", () => {
    const ws = gitWorkspace({
      "package.json": HOST_MANIFEST,
      "package-lock.json": "{}",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    });
    for (const lock of ["package-lock.json", "pnpm-lock.yaml"]) {
      const verdict = assessProtectedHostWrite(ws, lock, "anything");
      expect(verdict.refused, lock).toBe(true);
      expect(verdict.reason).toMatch(/derived artifacts/);
    }
  });

  it("refuses replacing a tracked root tool config, and the new-variant hijack beside it", () => {
    const ws = gitWorkspace({
      "package.json": HOST_MANIFEST,
      "vitest.config.js": "export default {}\n",
    });
    expect(
      assessProtectedHostWrite(
        ws,
        "vitest.config.js",
        "export default { hijacked: true }",
      ).refused,
    ).toBe(true);
    const hijack = assessProtectedHostWrite(
      ws,
      "vitest.config.ts",
      "export default {}",
    );
    expect(hijack.refused).toBe(true);
    expect(hijack.reason).toMatch(/take precedence/);
  });

  it("allows a root tool config for a tool the host does NOT use, and non-root configs", () => {
    const ws = gitWorkspace({ "package.json": HOST_MANIFEST });
    expect(
      assessProtectedHostWrite(ws, "playwright.config.ts", "export default {}").refused,
    ).toBe(false);
    expect(
      assessProtectedHostWrite(ws, "packages/sub/vitest.config.ts", "export default {}")
        .refused,
    ).toBe(false);
  });

  it("refuses edits to tracked package-level test configuration", () => {
    const ws = gitWorkspace({
      "packages/web/vitest.config.ts":
        "export default { test: { include: ['src/**/*.test.ts'] } };",
    });
    expect(
      assessProtectedHostWrite(
        ws,
        "packages/web/vitest.config.ts",
        "export default { test: { include: ['src/generated.test.ts'] } };",
      ).refused,
    ).toBe(true);
  });

  it("is inert for non-git (new-app) workspaces", () => {
    const path = mkdtempSync(join(tmpdir(), "factory-protected-nogit-"));
    workspaces.push(path);
    writeFileSync(join(path, "package.json"), HOST_MANIFEST);
    expect(assessProtectedHostWrite(path, "package.json", "{}").refused).toBe(false);
  });
});

const BR = String.fromCharCode(10);

describe("tracked source files keep their exports (slice 40c4c51d class)", () => {
  it("refuses an ESM->CJS rewrite that drops every export", () => {
    const repo = gitWorkspace({
      "auth.js": [
        "export const AUTH_COOKIE = 'ss_token';",
        "export function cookieOptions() { return {}; }",
        "export function signToken(u) { return u; }",
      ].join(BR),
    });
    const verdict = assessProtectedHostWrite(
      repo,
      "auth.js",
      [
        "const jwt = require('jsonwebtoken');",
        "module.exports = { authenticate };",
      ].join(BR),
    );
    expect(verdict.refused).toBe(true);
    expect(verdict.reason).toMatch(/drops 3 export/i);
    expect(verdict.reason).toMatch(/cookieOptions/);
  });

  it("allows an additive edit that keeps every export", () => {
    const repo = gitWorkspace({
      "auth.js": "export function cookieOptions() { return {}; }",
    });
    const verdict = assessProtectedHostWrite(
      repo,
      "auth.js",
      [
        "export function cookieOptions() { return { secure: true }; }",
        "export function newHelper() {}",
      ].join(BR),
    );
    expect(verdict.refused).toBe(false);
  });

  it("compares CJS exports on equal footing (no false refusal)", () => {
    const repo = gitWorkspace({ "util.js": "module.exports = { alpha, beta };" });
    const verdict = assessProtectedHostWrite(
      repo,
      "util.js",
      ["exports.alpha = alpha;", "exports.beta = beta;", "exports.gamma = gamma;"].join(
        BR,
      ),
    );
    expect(verdict.refused).toBe(false);
  });

  it("recognizes default exports but ignores exports hidden in comments", () => {
    expect(exportedSymbols("export default function App(){}")).toContain("default");
    expect(exportedSymbols("/* export default function App(){} */")).not.toContain(
      "default",
    );
  });

  it("refuses a new shadow extension variant beside tracked source", () => {
    const repo = gitWorkspace({
      "App.jsx": "export default function App(){ return null; }",
    });
    const verdict = assessProtectedHostWrite(
      repo,
      "App.tsx",
      "export default function App(){ return <Profile />; }",
    );
    expect(verdict.refused).toBe(true);
    expect(verdict.reason).toMatch(/App\.jsx/);
    expect(verdict.reason).toMatch(/shadow extension variant/);
  });

  it("refuses nested and CommonJS-TypeScript shadow variants", () => {
    const repo = gitWorkspace({
      "src/vite.config.js": "export default {};",
      "src/App.ts": "export default function App(){ return null; }",
    });
    expect(
      assessProtectedHostWrite(repo, "src/vite.config.ts", "export default {};")
        .refused,
    ).toBe(true);
    expect(
      assessProtectedHostWrite(repo, "src/App.cts", "export default function App(){}")
        .refused,
    ).toBe(true);
  });

  it("refuses a new eslint.config.ts beside a tracked eslint.config.js", () => {
    const repo = gitWorkspace({
      "eslint.config.js": "export default [];",
    });
    const verdict = assessProtectedHostWrite(
      repo,
      "eslint.config.ts",
      "export default [];",
    );
    expect(verdict.refused).toBe(true);
    expect(verdict.reason).toMatch(/eslint\.config\.js/);
    expect(verdict.reason).toMatch(/shadow extension variant/);
  });

  it("does not accept export decoys inside strings, templates, or regex literals", () => {
    for (const decoy of [
      'const note = "export const auth";',
      "const note = `export const auth`;",
      "const note = /export const auth/;",
    ]) {
      expect(exportedSymbols(decoy)).not.toContain("auth");
    }
    expect(exportedSymbols("export type Auth = { id: string };")).toContain("Auth");
  });

  it("keeps protection active when the tracked-path index exceeds one MiB", () => {
    const ws = gitWorkspace({ "vitest.config.js": "export default {};\n" });
    const blob = execFileSync("git", ["-C", ws, "hash-object", "-w", "--stdin"], {
      input: "x",
      encoding: "utf8",
    }).trim();
    const entries = Array.from({ length: 10_000 }, (_, index) => {
      const path = `bulk/${String(index).padStart(5, "0")}-${"x".repeat(110)}.ts`;
      return `100644 blob ${blob}\t${path}\0`;
    }).join("");
    execFileSync("git", ["-C", ws, "update-index", "-z", "--index-info"], {
      input: entries,
      maxBuffer: 4 * 1024 * 1024,
    });
    const listing = execFileSync("git", ["-C", ws, "ls-files", "-z"], {
      maxBuffer: 4 * 1024 * 1024,
    });
    expect(listing.byteLength).toBeGreaterThan(1024 * 1024);
    _resetProtectedFilesCache();
    expect(
      assessProtectedHostWrite(ws, "vitest.config.ts", "export default {};").refused,
    ).toBe(true);
  });

  it("leaves brand-new source files alone", () => {
    const repo = gitWorkspace({ "auth.js": "export const A = 1;" });
    expect(assessProtectedHostWrite(repo, "brandNew.js", "// anything").refused).toBe(
      false,
    );
  });
  it("preserves each export-star source independently", () => {
    const ws = gitWorkspace({
      "src/index.ts": "export * from './a';\nexport * from './b';\n",
    });
    const verdict = assessProtectedHostWrite(
      ws,
      "src/index.ts",
      "export * from './a';\n",
    );
    expect(verdict.refused).toBe(true);
    expect(verdict.reason).toMatch(/export/);
  });

  it.each(["cts", "mts"])("protects tracked eslint.config.%s", (ext) => {
    const path = `eslint.config.${ext}`;
    const ws = gitWorkspace({ [path]: "export default [{ rules: {} }];\n" });
    expect(assessProtectedHostWrite(ws, path, "export default [];\n").refused).toBe(
      true,
    );
  });

  it("refuses a Python test-config precedence shadow", () => {
    const ws = gitWorkspace({
      "pyproject.toml": "[tool.pytest.ini_options]\naddopts = '-q'\n",
    });
    const verdict = assessProtectedHostWrite(
      ws,
      "pytest.ini",
      "[pytest]\ntestpaths = generated_only\n",
    );
    expect(verdict.refused).toBe(true);
    expect(verdict.reason).toMatch(/Python test configuration|pytest discovery/i);
  });

  it("refuses a new lockfile that would switch package managers", () => {
    const ws = gitWorkspace({
      "package-lock.json": '{"lockfileVersion":3}\n',
      "package.json": '{"name":"host"}\n',
    });
    const verdict = assessProtectedHostWrite(ws, "yarn.lock", "# shadow\n");
    expect(verdict.refused).toBe(true);
    expect(verdict.reason).toMatch(/lockfile|derived artifact/i);
  });

  it("refreshes its tracked-file baseline when an in-place repo HEAD advances", () => {
    const ws = gitWorkspace({ "src/old.ts": "export const old = 1;\n" });
    expect(
      assessProtectedHostWrite(
        ws,
        "src/old.ts",
        "export const old = 1;\nexport const more = 2;\n",
      ).refused,
    ).toBe(false);

    writeFileSync(join(ws, "src", "new.ts"), "export const keep = 1;\n");
    execFileSync("git", ["-C", ws, "add", "src/new.ts"]);
    execFileSync("git", [
      "-C",
      ws,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "-m",
      "advance",
    ]);

    const verdict = assessProtectedHostWrite(ws, "src/new.ts", "const removed = 1;\n");
    expect(verdict.refused).toBe(true);
    expect(verdict.reason).toMatch(/drops.*export/i);
  });
});

describe("factory overlay names (GrantFlow extend ba870e71)", () => {
  it("classifies _gh_*, root _restore_*, and *_from_<sha>*", () => {
    expect(isFactoryOverlayPath("_gh_0179.sql")).toBe(true);
    expect(isFactoryOverlayPath("_gh_CreateInvoice.jsx")).toBe(true);
    expect(isFactoryOverlayPath("scratch/_gh_main_server.js")).toBe(true);
    expect(isFactoryOverlayPath("_restore_server_from_2a77487.js")).toBe(true);
    expect(isFactoryOverlayPath("notes_from_alice.md")).toBe(false);
    expect(isFactoryOverlayPath("src/App.jsx")).toBe(false);
  });

  it("refuses overlay writes even in a non-git (new-app) workspace", () => {
    const path = mkdtempSync(join(tmpdir(), "factory-protected-nogit-"));
    workspaces.push(path);
    const verdict = assessProtectedHostWrite(
      path,
      "_gh_main_client.js",
      "export default 1\n",
    );
    expect(verdict.refused).toBe(true);
    expect(verdict.reason).toMatch(/overlay/);
  });

  it("refuses a tracked host client.js / App.jsx shrink the same way as package.json", () => {
    const fatClient = `${"export const api = {};\n".repeat(80)}export function keep() {}\n`;
    const fatApp = `${"import X from './x';\n".repeat(40)}export default function App() { return null }\n`;
    const ws = gitWorkspace({
      "src/api/client.js": fatClient,
      "src/App.jsx": fatApp,
    });
    const clientStub = assessProtectedHostWrite(
      ws,
      "src/api/client.js",
      "export const api = {};\n",
    );
    expect(clientStub.refused).toBe(true);
    expect(clientStub.reason).toMatch(/collapse the host spine/);
    const appStub = assessProtectedHostWrite(
      ws,
      "src/App.jsx",
      "export default function App() { return <div/> }\n",
    );
    expect(appStub.refused).toBe(true);
    const grown = assessProtectedHostWrite(
      ws,
      "src/api/client.js",
      `${fatClient}\nexport const extra = 1;\n`,
    );
    expect(grown.refused).toBe(false);
  });
});
