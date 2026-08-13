import { describe, it, expect, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeExistingCodebase } from "../workspace/analyzeExistingCodebase.js";

const cleanupPaths: string[] = [];
afterAll(async () => {
  await Promise.all(cleanupPaths.map((p) => rm(p, { recursive: true, force: true })));
});

describe("analyzeExistingCodebase", () => {
  it("detects a React + Express + TypeScript stack from package.json and guesses the app name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "factory-analyze-"));
    cleanupPaths.push(dir);
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "future-u",
        dependencies: { react: "^18.0.0", express: "^4.0.0" },
        devDependencies: { typescript: "^5.0.0", vitest: "^3.0.0" },
      }),
    );
    await writeFile(join(dir, "README.md"), "# FutureU\nA K-12 homeschool platform.");
    await mkdir(join(dir, "client", "src"), { recursive: true });
    await writeFile(
      join(dir, "client", "src", "App.jsx"),
      "export default function App(){}",
    );
    await mkdir(join(dir, "node_modules", "react"), { recursive: true });
    await writeFile(join(dir, "node_modules", "react", "index.js"), "// dep");

    const analysis = await analyzeExistingCodebase(dir);

    expect(analysis.appNameGuess).toBe("future-u");
    expect(analysis.detectedStack).toContain("React");
    expect(analysis.detectedStack).toContain("Express");
    expect(analysis.detectedStack).toContain("TypeScript");
    expect(analysis.readmeExcerpt).toContain("K-12 homeschool platform");
    // node_modules excluded from the scanned tree.
    expect(analysis.fileTree.some((f) => f.includes("node_modules"))).toBe(false);
    expect(analysis.fileTree).toContain("client/src/App.jsx");
    expect(analysis.stackSummary).toContain("React");
  });

  it("falls back to the directory name when no manifest is found", async () => {
    const dir = await mkdtemp(join(tmpdir(), "factory-analyze-bare-"));
    cleanupPaths.push(dir);
    await writeFile(join(dir, "notes.txt"), "just some notes");

    const analysis = await analyzeExistingCodebase(dir);
    expect(analysis.appNameGuess.length).toBeGreaterThan(0);
    expect(analysis.detectedStack).toEqual([]);
    expect(analysis.manifestExcerpts).toEqual([]);
  });

  it("detects a client/ + server/ split package.json layout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "factory-analyze-split-"));
    cleanupPaths.push(dir);
    await mkdir(join(dir, "client"), { recursive: true });
    await mkdir(join(dir, "server"), { recursive: true });
    await writeFile(
      join(dir, "client", "package.json"),
      JSON.stringify({ dependencies: { react: "^18" } }),
    );
    await writeFile(
      join(dir, "server", "package.json"),
      JSON.stringify({ dependencies: { express: "^4" } }),
    );

    const analysis = await analyzeExistingCodebase(dir);
    expect(analysis.manifestExcerpts.map((m) => m.path)).toEqual(
      expect.arrayContaining(["client/package.json", "server/package.json"]),
    );
    expect(analysis.detectedStack).toEqual(
      expect.arrayContaining(["React", "Express"]),
    );
  });
});
