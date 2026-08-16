import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { applyEdits, resolveGeneratedWrite } from "../workspace/applyEdits.js";
import { mentionedPaths, readTargetFiles } from "../workspace/targetFiles.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const BR = String.fromCharCode(10);

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "factory-edits-"));
  dirs.push(root);
  for (const [rel, contents] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }
  return root;
}

/** The real auth.js shape a slice destroyed by rewriting it from its filename. */
const AUTH_JS = [
  "export const AUTH_COOKIE = 'ss_token';",
  "export function cookieOptions() { return { sameSite: 'lax' }; }",
  "export function signToken(u) { return u; }",
  "export function requirePremium(req, res, next) { next(); }",
].join(BR);

describe("applyEdits", () => {
  it("replaces the quoted text and leaves everything else byte-identical", () => {
    const out = applyEdits(AUTH_JS, [
      { find: "sameSite: 'lax'", replace: "sameSite: 'none', secure: true" },
    ]);
    expect(out.ok).toBe(true);
    expect(out.contents).toContain("sameSite: 'none', secure: true");
    // every original export survives — the whole point
    for (const name of ["AUTH_COOKIE", "cookieOptions", "signToken", "requirePremium"]) {
      expect(out.contents).toContain(name);
    }
  });

  it("refuses an anchor that does not exist, saying so precisely", () => {
    const out = applyEdits(AUTH_JS, [{ find: "sameSite: 'strict'", replace: "x" }]);
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/not found/i);
  });

  it("refuses an ambiguous anchor rather than editing the wrong one", () => {
    const src = ["const a = 1;", "const a = 1;"].join(BR);
    const out = applyEdits(src, [{ find: "const a = 1;", replace: "const a = 2;" }]);
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/more than once/i);
  });

  it("applies several edits in order", () => {
    const out = applyEdits(AUTH_JS, [
      { find: "'ss_token'", replace: "'sess'" },
      { find: "return u;", replace: "return String(u);" },
    ]);
    expect(out.ok).toBe(true);
    expect(out.contents).toContain("'sess'");
    expect(out.contents).toContain("String(u)");
  });
});

describe("resolveGeneratedWrite — the blind-rewrite engine is gone", () => {
  it("accepts an informed whole-file rewrite (the export guard is what stops destruction)", () => {
    const root = workspace({ "services/api/src/middleware/auth.js": AUTH_JS });
    const rewrite = AUTH_JS.replace("sameSite: 'lax'", "sameSite: 'none'");
    const res = resolveGeneratedWrite(root, "services/api/src/middleware/auth.js", {
      contents: rewrite,
      edits: [],
    });
    expect(res.contents).toContain("sameSite: 'none'");
    expect(res.edited).toBe(true);
  });

  it("refuses an EMPTY replacement — that deletes a file by accident", () => {
    const root = workspace({ "src/a.js": AUTH_JS });
    const res = resolveGeneratedWrite(root, "src/a.js", { contents: "   ", edits: [] });
    expect(res.contents).toBeNull();
    expect(res.reason).toMatch(/empty replacement/i);
  });

  it("accepts edits against the file's REAL contents", () => {
    const root = workspace({ "src/App.jsx": AUTH_JS });
    const res = resolveGeneratedWrite(root, "src/App.jsx", {
      contents: "",
      edits: [{ find: "signToken(u)", replace: "signToken(user)" }],
    });
    expect(res.contents).toContain("signToken(user)");
    expect(res.contents).toContain("requirePremium");
    expect(res.edited).toBe(true);
  });

  it("allows full contents for a genuinely new file", () => {
    const root = workspace({ "src/App.jsx": AUTH_JS });
    const res = resolveGeneratedWrite(root, "src/components/Brand.jsx", {
      contents: "export const Brand = () => null;",
      edits: [],
    });
    expect(res.contents).toBe("export const Brand = () => null;");
    expect(res.edited).toBe(false);
  });

  it("still allows replacing an existing non-source file (docs, data)", () => {
    const root = workspace({ "docs/notes.md": "old" });
    const res = resolveGeneratedWrite(root, "docs/notes.md", { contents: "new", edits: [] });
    expect(res.contents).toBe("new");
  });

  it("reports a failed anchor instead of writing anything", () => {
    const root = workspace({ "src/a.js": AUTH_JS });
    const res = resolveGeneratedWrite(root, "src/a.js", {
      contents: "",
      edits: [{ find: "does not exist", replace: "x" }],
    });
    expect(res.contents).toBeNull();
    expect(res.reason).toMatch(/not found/i);
  });
});

describe("targetFiles — the builder is given real code to quote", () => {
  it("finds paths named by the plan and reads them", () => {
    const root = workspace({
      "apps/web/src/App.jsx": "export const App = () => null;",
      "apps/web/src/components/Nav.jsx": "export const Nav = () => null;",
    });
    const plan = {
      tasks: [
        {
          order: 1,
          category: "frontend" as const,
          title: "Wire the shell",
          detail: "Update apps/web/src/App.jsx and apps/web/src/components/Nav.jsx",
        },
      ],
    };
    const files = readTargetFiles(root, plan, "", []);
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual(["apps/web/src/App.jsx", "apps/web/src/components/Nav.jsx"]);
    expect(files[0].contents).toContain("export const");
  });

  it("skips files the plan names that do not exist yet (those get created)", () => {
    const root = workspace({ "src/a.js": "export const a = 1;" });
    const plan = {
      tasks: [
        { order: 1, category: "frontend" as const, title: "t", detail: "create src/brand/New.jsx" },
      ],
    };
    expect(readTargetFiles(root, plan, "", [])).toEqual([]);
  });

  it("extracts path-shaped tokens and ignores prose", () => {
    const plan = {
      tasks: [
        {
          order: 1,
          category: "backend" as const,
          title: "Fix login",
          detail: "touch services/api/src/middleware/auth.js but not the words api or src",
        },
      ],
    };
    expect(mentionedPaths(plan)).toEqual(["services/api/src/middleware/auth.js"]);
  });
});
