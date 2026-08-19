import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  findUnwiredNewFiles,
  unwiredCaveat,
} from "../workspace/unwiredFiles.js";

const workspaces: string[] = [];
function workspace(): string {
  const path = mkdtempSync(join(tmpdir(), "factory-unwired-"));
  workspaces.push(path);
  return path;
}
afterEach(() => {
  for (const path of workspaces.splice(0)) {
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

function write(root: string, rel: string, contents: string) {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), contents);
}

describe("findUnwiredNewFiles", () => {
  it("names generated files that nothing pre-existing imports — the d687f5fd shape", () => {
    const ws = workspace();
    // Pre-existing app with a router that does NOT know the new pages.
    write(ws, "src/App.jsx", "import Funding from './pages/FundingOpportunities';\n");
    write(ws, "src/pages/FundingOpportunities.jsx", "function OpportunityCard() {}\nexport default 1;\n");
    // Generated: a page wired to nothing, a component wired to nothing, and a
    // generated test importing them (self-wiring — must NOT count as evidence).
    const generated = [
      "src/pages/RepositoryTruth.jsx",
      "src/components/OpportunityCard.jsx",
      "src/tests/grantUiProvenanceAcceptance.test.mjs",
      "backend/modules/matching/engine.ts",
    ];
    write(ws, "src/pages/RepositoryTruth.jsx", "export default 1;\n");
    write(ws, "src/components/OpportunityCard.jsx", "export default 1;\n");
    write(
      ws,
      "src/tests/grantUiProvenanceAcceptance.test.mjs",
      "import '../pages/RepositoryTruth.jsx'; import '../components/OpportunityCard.jsx';\n",
    );
    write(ws, "backend/modules/matching/engine.ts", "export const x = 1;\n");

    const unwired = findUnwiredNewFiles(ws, generated);
    expect(unwired).toEqual([
      "backend/modules/matching/engine.ts",
      "src/components/OpportunityCard.jsx",
      "src/pages/RepositoryTruth.jsx",
    ]);
    // A local FUNCTION named OpportunityCard in a pre-existing file is a name
    // coincidence, not a wire — path-fragment matching must not count it.
    expect(unwired).toContain("src/components/OpportunityCard.jsx");
  });

  it("counts a file as WIRED when a pre-existing file references its module path", () => {
    const ws = workspace();
    write(ws, "src/App.jsx", "import Fresh from './components/FreshnessBadge';\n");
    write(ws, "src/components/FreshnessBadge.jsx", "export default 1;\n");
    expect(findUnwiredNewFiles(ws, ["src/components/FreshnessBadge.jsx"])).toEqual([]);
  });

  it("is silent for new-app runs (no pre-existing code = no wiring claim to check)", () => {
    const ws = workspace();
    write(ws, "src/index.js", "import './app.js';\n");
    write(ws, "src/app.js", "export default 1;\n");
    expect(
      findUnwiredNewFiles(ws, ["src/index.js", "src/app.js"]),
    ).toEqual([]);
  });

  it.each(["cts", "mts"])("reports an unwired generated .%s module", (ext) => {
    const ws = workspace();
    write(ws, "src/App.ts", "export const App = 1;\n");
    const path = `apps/web/src/features/Fresh.${ext}`;
    write(ws, path, "export const Fresh = 1;\n");
    expect(findUnwiredNewFiles(ws, [path])).toEqual([path]);
  });

  it.each(["cts", "mts"])("recognizes a pre-existing .%s referrer", (ext) => {
    const ws = workspace();
    write(ws, `src/router.${ext}`, "import './features/Fresh';\n");
    write(ws, "src/unrelated.js", "export const x = 1;\n");
    write(ws, "src/features/Fresh.mts", "export const Fresh = 1;\n");
    expect(
      findUnwiredNewFiles(ws, ["src/features/Fresh.mts"]),
    ).toEqual([]);
  });

  it("uses a modified host entrypoint as the root of transitive generated wiring", () => {
    const ws = workspace();
    write(ws, "src/App.jsx", "import Fresh from './pages/Fresh';\n");
    write(ws, "src/bootstrap.js", "export const boot = true;\n");
    write(ws, "src/pages/Fresh.mts", "import './ProfileForm'; export default 1;\n");
    write(ws, "src/pages/ProfileForm.tsx", "export default 1;\n");
    expect(
      findUnwiredNewFiles(ws, [
        "src/pages/Fresh.mts",
        "src/pages/ProfileForm.tsx",
      ]),
    ).toEqual([]);
  });

  it("still reports generated modules when the modified host entrypoint does not wire them", () => {
    const ws = workspace();
    write(ws, "src/App.jsx", "export default function App(){ return null; }\n");
    write(ws, "src/pages/Fresh.mts", "export default 1;\n");
    expect(findUnwiredNewFiles(ws, ["src/pages/Fresh.mts"])).toEqual([
      "src/pages/Fresh.mts",
    ]);
  });

  it("does not count comments, strings, or longer module prefixes as wiring", () => {
    const ws = workspace();
    write(
      ws,
      "src/App.tsx",
      [
        "// import './pages/Fresh';",
        "const note = 'pages/Fresh';",
        "import './pages/Freshness';",
      ].join("\n"),
    );
    write(ws, "src/pages/Fresh.tsx", "export default 1;\n");
    expect(findUnwiredNewFiles(ws, ["src/pages/Fresh.tsx"])).toEqual([
      "src/pages/Fresh.tsx",
    ]);
  });

  it("ignores generated docs/configs/tests as candidates", () => {
    const ws = workspace();
    write(ws, "src/main.jsx", "console.log('app');\n");
    expect(
      findUnwiredNewFiles(ws, [
        "docs/RELEASE_REPORT.md",
        "vitest.config.ts",
        "backend/tests/somethingAcceptance.test.mjs",
      ]),
    ).toEqual([]);
  });
});

describe("unwiredCaveat", () => {
  it("names the files, capped, and is null when everything is wired", () => {
    expect(unwiredCaveat([])).toBeNull();
    const caveat = unwiredCaveat(["src/a.jsx", "src/b.jsx"]);
    expect(caveat).toMatch(/UNWIRED SCAFFOLDING: 2 generated source file/);
    expect(caveat).toMatch(/src\/a\.jsx, src\/b\.jsx/);
    const many = unwiredCaveat(Array.from({ length: 15 }, (_, i) => `src/f${i}.jsx`));
    expect(many).toMatch(/\(\+3 more\)/);
  });
});
