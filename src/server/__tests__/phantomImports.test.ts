import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assessPhantomImports,
  correctPhantomImports,
  declaredDependencies,
  importedPackages,
  nearestDeclared,
} from "../workspace/phantomImports.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs)
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function repo(manifests: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "factory-phantom-"));
  dirs.push(root);
  for (const [rel, pkg] of Object.entries(manifests)) {
    const dir = rel ? join(root, rel) : root;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  }
  return root;
}

const BR = String.fromCharCode(10);

describe("importedPackages", () => {
  it("collects bare specifiers and ignores relative/builtin/url forms", () => {
    const src = [
      "import React from 'react';",
      'import { Link } from "react-router-dom";',
      "import { x } from './local';",
      "const fs = require('node:fs');",
      "const lazy = await import('@scope/pkg/deep');",
    ].join(BR);
    const pkgs = importedPackages(src);
    expect(pkgs).toContain("react");
    expect(pkgs).toContain("react-router-dom");
    expect(pkgs).toContain("@scope/pkg");
    expect(pkgs).toContain("node:fs");
    expect(pkgs).not.toContain("./local");
  });

  it("reads export, import type, and import-equals module specifiers", () => {
    const src = [
      'export { value } from "exported-package";',
      'type External = import("typed-package").External;',
      'import legacy = require("legacy-package");',
    ].join(BR);
    expect(importedPackages(src, "src/example.ts")).toEqual([
      "exported-package",
      "typed-package",
      "legacy-package",
    ]);
  });
});

describe("declaredDependencies", () => {
  it("unions every manifest in a monorepo", () => {
    const root = repo({
      "": { dependencies: { react: "19" } },
      "apps/web": {
        dependencies: { "react-router": "8" },
        devDependencies: { vitest: "3" },
      },
    });
    const deps = declaredDependencies(root);
    expect(deps.has("react")).toBe(true);
    expect(deps.has("react-router")).toBe(true);
    expect(deps.has("vitest")).toBe(true);
  });
});

describe("nearestDeclared", () => {
  it("maps react-router-dom to the declared react-router", () => {
    expect(nearestDeclared("react-router-dom", new Set(["react-router"]))).toBe(
      "react-router",
    );
  });
  it("returns null when nothing is close", () => {
    expect(nearestDeclared("left-pad", new Set(["react"]))).toBeNull();
  });
});

describe("assessPhantomImports (the SermonSmith failure, twice over)", () => {
  it("FIXES react-router-dom to the declared react-router instead of refusing", () => {
    const root = repo({ "": { dependencies: { react: "19", "react-router": "8" } } });
    const verdict = assessPhantomImports(
      root,
      "apps/web/src/App.jsx",
      "import { Link } from 'react-router-dom';",
    );
    expect(verdict.refused).toBe(false);
    expect(verdict.corrected).toContain("'react-router'");
    expect(verdict.corrected).not.toContain("react-router-dom");
    expect(verdict.corrections).toContain("react-router-dom -> react-router");
  });

  it("preserves a deep path while correcting the package", () => {
    const declared = new Set(["react-router"]);
    const out = correctPhantomImports(
      "import { x } from 'react-router-dom/server';",
      declared,
    );
    expect(out.contents).toContain("'react-router/server'");
  });

  it("corrects only the real import and leaves fixture strings unchanged", () => {
    const declared = new Set(["react-router"]);
    const out = correctPhantomImports(
      [
        'import { Link } from "react-router-dom";',
        'const forbiddenPackage = "react-router-dom";',
      ].join(BR),
      declared,
    );
    expect(out.contents).toContain('from "react-router"');
    expect(out.contents).toContain('forbiddenPackage = "react-router-dom"');
  });

  it("still refuses an import with NO declared counterpart (the build must declare it)", () => {
    const root = repo({ "": { dependencies: { react: "19" } } });
    const verdict = assessPhantomImports(root, "src/a.js", "import x from 'left-pad';");
    expect(verdict.refused).toBe(true);
    expect(verdict.reason).toMatch(/no declared counterpart/i);
  });

  it("allows imports the repo declares, plus builtins and relatives", () => {
    const root = repo({ "": { dependencies: { react: "19", "react-router": "8" } } });
    const src = [
      "import React from 'react';",
      "import { Link } from 'react-router';",
      "import fs from 'node:fs';",
      "import { helper } from '../lib/helper.js';",
    ].join(BR);
    expect(assessPhantomImports(root, "apps/web/src/App.jsx", src).refused).toBe(false);
  });

  it("ignores package names and import-like text used as test data", () => {
    const root = repo({
      "": { devDependencies: { vitest: "3" } },
    });
    const src = [
      'import { describe, expect, it } from "vitest";',
      'import { runCommand } from "../src/app.js";',
      'const forbiddenPackages = ["react", "react-dom", "express", "fastify"];',
      'const forbiddenImports = ["from \\"react\\"", "from \'express\'"];',
      '// import Fastify from "fastify";',
      'it("rejects forbidden dependencies", () => {',
      "  expect(forbiddenPackages).toHaveLength(4);",
      "  expect(forbiddenImports).toHaveLength(2);",
      "});",
    ].join(BR);
    expect(importedPackages(src, "tests/app.test.ts")).toEqual(["vitest"]);
    expect(assessPhantomImports(root, "tests/app.test.ts", src).refused).toBe(false);
  });

  it("passes once the build declares the dependency itself (manifests are read from disk)", () => {
    const root = repo({ "": { dependencies: { zod: "3" } } });
    expect(assessPhantomImports(root, "src/a.js", "import z from 'zod';").refused).toBe(
      false,
    );
  });

  it.each(["cts", "mts"])("checks undeclared imports in .%s files", (ext) => {
    const root = repo({ "": { dependencies: { react: "19" } } });
    const verdict = assessPhantomImports(
      root,
      `src/worker.${ext}`,
      "import x from 'left-pad';",
    );
    expect(verdict.refused).toBe(true);
    expect(verdict.reason).toContain("left-pad");
  });

  it("is inert for non-source files and for a workspace with no manifests", () => {
    const root = repo({ "": { dependencies: { react: "19" } } });
    expect(
      assessPhantomImports(root, "README.md", "import x from 'nope';").refused,
    ).toBe(false);
    const bare = mkdtempSync(join(tmpdir(), "factory-phantom-bare-"));
    dirs.push(bare);
    expect(
      assessPhantomImports(bare, "src/a.js", "import x from 'nope';").refused,
    ).toBe(false);
  });
});
