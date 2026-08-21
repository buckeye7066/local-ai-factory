import { afterAll, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  linkSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { applyEdits, resolveGeneratedWrite } from "../workspace/applyEdits.js";
import { writeWorkspaceFile } from "../workspace/fileWriter.js";
import {
  inspectTargetFiles,
  mentionedPaths,
  readTargetFiles,
} from "../workspace/targetFiles.js";

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

  it("refuses an edit whose replacement closes a comment not opened within it", () => {
    const src = "const a = 1;\nconst b = 2;\n";
    // The replacement `*/ ... /*` would close a block comment from before the anchor
    // and open a new one, commenting out everything that follows.
    const out = applyEdits(src, [{ find: "const b = 2;", replace: "*/ evil(); /*" }]);
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/closes a block comment/i);
  });

  it("allows balanced block-comment delimiters in the correct order", () => {
    const src = "const a = 1;\nconst b = 2;\n";
    const out = applyEdits(src, [{ find: "const b = 2;", replace: "/* note */ const b = 3;" }]);
    expect(out.ok).toBe(true);
    expect(out.contents).toContain("const b = 3;");
  });
});

describe("resolveGeneratedWrite — the blind-rewrite engine is gone", () => {
  it("refuses a whole-file source rewrite even when named exports survive", () => {
    const root = workspace({ "services/api/src/middleware/auth.js": AUTH_JS });
    const rewrite = AUTH_JS.replace("sameSite: 'lax'", "sameSite: 'none'");
    const res = resolveGeneratedWrite(root, "services/api/src/middleware/auth.js", {
      contents: rewrite,
      edits: [],
    });
    expect(res.contents).toBeNull();
    expect(res.reason).toMatch(/anchored edits/i);
  });

  it("refuses a default-export App rewrite whose routes could disappear invisibly", () => {
    const root = workspace({
      "src/App.tsx": "export default function App(){ return <Routes />; }",
    });
    const res = resolveGeneratedWrite(root, "src/App.tsx", {
      contents: "export default function App(){ return <NewPanel />; }",
      edits: [],
    });
    expect(res.contents).toBeNull();
    expect(res.reason).toMatch(/whole-file replacement/i);
  });

  it("refuses a whole-file rewrite disguised as one giant anchored edit", () => {
    const current =
      "export default function App(){ return <ExistingRoutes />; }";
    const root = workspace({ "src/App.jsx": current });
    const res = resolveGeneratedWrite(root, "src/App.jsx", {
      contents: "",
      edits: [
        {
          find: current,
          replace: "export default function App(){ return <Broken />; }",
        },
      ],
    });
    expect(res.contents).toBeNull();
    expect(res.reason).toMatch(/more than half|whole-file rewrite/i);
  });

  it("refuses whole-file replacement for source extensions outside JS/TS", () => {
    const root = workspace({ "native/main.cpp": "int main(){ return 0; }" });
    const res = resolveGeneratedWrite(root, "native/main.cpp", {
      contents: "int main(){ launchMissiles(); }",
      edits: [],
    });
    expect(res.contents).toBeNull();
    expect(res.reason).toMatch(/whole-file replacement/i);
  });

  it("bounds replacement text and cross-edit block-comment tricks", () => {
    const original = "a".repeat(1_000);
    expect(
      applyEdits(original, [{ find: "aaaaa", replace: "b".repeat(600) }]),
    ).toMatchObject({ ok: false });
    expect(
      applyEdits("const a = 1;\nconst b = 2;\n", [
        { find: "const a = 1;", replace: "const a = 1; /*" },
        { find: "const b = 2;", replace: "*/ const b = 2;" },
      ]),
    ).toMatchObject({ ok: false });
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

  it("allows explicit initialization of an existing zero-byte file", () => {
    const root = workspace({ "src/empty.ts": "" });
    const res = resolveGeneratedWrite(root, "src/empty.ts", {
      contents: "export const initialized = true;\n",
      edits: [],
    });
    expect(res.contents).toContain("initialized");
    expect(res.edited).toBe(true);
  });

  it("treats only ENOENT as new and refuses an unreadable existing file", () => {
    const root = workspace({ "src/secret.ts": "export const secret = 1;\n" });
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    const res = resolveGeneratedWrite(
      root,
      "src/secret.ts",
      { contents: "export const overwritten = true;", edits: [] },
      () => {
        throw denied;
      },
    );
    expect(res.contents).toBeNull();
    expect(res.reason).toMatch(/could not be read safely|only ENOENT/i);
  });

  it("requires anchored edits for existing docs and data too", () => {
    const root = workspace({ "docs/notes.md": "old" });
    const res = resolveGeneratedWrite(root, "docs/notes.md", {
      contents: "new",
      edits: [],
    });
    expect(res.contents).toBeNull();
    expect(res.reason).toMatch(/whole-file replacement/i);
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

describe("file writer physical containment", () => {
  it.skipIf(process.platform === "win32")(
    "does not follow a symlinked parent outside the workspace",
    async () => {
      const root = workspace({});
      const outside = mkdtempSync(join(tmpdir(), "factory-edits-outside-"));
      dirs.push(outside);
      symlinkSync(outside, join(root, "linked"), "dir");

      await expect(
        writeWorkspaceFile(root, "linked/escaped.ts", "owned"),
      ).rejects.toThrow(/symlink|workspace|contain/i);
      expect(() => readFileSync(join(outside, "escaped.ts"), "utf8")).toThrow();
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not truncate a hard-linked inode outside the workspace",
    async () => {
      const root = workspace({});
      const outside = join(root, "..", `factory-hardlink-${Date.now()}.ts`);
      dirs.push(outside);
      writeFileSync(outside, "sentinel");
      linkSync(outside, join(root, "linked.ts"));
      await expect(
        writeWorkspaceFile(root, "linked.ts", "overwritten"),
      ).rejects.toThrow(/hard-linked/i);
      expect(readFileSync(outside, "utf8")).toBe("sentinel");
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not overwrite a symlinked final target",
    async () => {
      const root = workspace({});
      const outside = join(root, "..", `factory-outside-${Date.now()}.ts`);
      dirs.push(outside);
      writeFileSync(outside, "sentinel");
      symlinkSync(outside, join(root, "alias.ts"), "file");
      await expect(
        writeWorkspaceFile(root, "alias.ts", "overwritten"),
      ).rejects.toThrow(/symlink|workspace|contain/i);
      expect(readFileSync(outside, "utf8")).toBe("sentinel");
    },
  );
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

  it("maps requested App.tsx to the host's unique real App.jsx", () => {
    const root = workspace({
      "src/App.jsx": "export default function App(){ return null; }",
      "src/main.jsx": "import App from './App';",
    });
    const plan = {
      tasks: [
        {
          order: 1,
          category: "frontend" as const,
          title: "Wire the profile",
          detail: "Update src/App.tsx to render the profile",
        },
      ],
    };
    const found = readTargetFiles(
      root,
      plan,
      "",
      ["src/App.jsx", "src/main.jsx"],
    );
    expect(found.map((f) => f.path)).toEqual(["src/App.jsx"]);
    expect(found[0]!.contents).toContain("function App");
  });

  it("ignores traversal-shaped path tokens without aborting the run", () => {
    const root = workspace({ "src/App.jsx": "export default function App(){}" });
    const plan = {
      tasks: [
        {
          order: 1,
          category: "frontend" as const,
          title: "Bad path",
          detail: "Update foo/../../outside.ts",
        },
      ],
    };
    expect(() =>
      readTargetFiles(root, plan, "", ["src/App.jsx"]),
    ).not.toThrow();
    expect(readTargetFiles(root, plan, "", ["src/App.jsx"])).toEqual([]);
  });

  it("reports an existing target that cannot fit safely in context", () => {
    const root = workspace({ "src/large.ts": "x".repeat(24_001) });
    const plan = {
      tasks: [
        {
          order: 1,
          category: "frontend" as const,
          title: "Update large file",
          detail: "Edit src/large.ts",
        },
      ],
    };
    const inspected = inspectTargetFiles(root, plan, "", ["src/large.ts"]);
    expect(inspected.files).toEqual([]);
    expect(inspected.omitted).toEqual([
      {
        path: "src/large.ts",
        reason: "file exceeds the per-file context limit",
      },
    ]);
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

  it("grounds exact extensionless integration points", () => {
    const root = workspace({ Dockerfile: "FROM node:20\n" });
    const plan = {
      tasks: [
        {
          order: 1,
          category: "backend" as const,
          title: "Update Dockerfile",
          detail: "Add the production build step to Dockerfile",
        },
      ],
    };
    expect(readTargetFiles(root, plan, "", ["Dockerfile"])).toEqual([
      { path: "Dockerfile", contents: "FROM node:20\n" },
    ]);
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
