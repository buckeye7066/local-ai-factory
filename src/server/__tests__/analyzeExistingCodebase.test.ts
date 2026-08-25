import { describe, it, expect, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PURPOSE_EVIDENCE_LIMIT,
  analyzeExistingCodebase,
} from "../workspace/analyzeExistingCodebase.js";

const cleanupPaths: string[] = [];
afterAll(async () => {
  await Promise.all(
    cleanupPaths.map((p) =>
      rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
    ),
  );
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
    expect(analysis.purposeEvidence.map((item) => item.kind)).toEqual(
      expect.arrayContaining(["readme", "manifest", "source"]),
    );
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

  it("collects deterministic, bounded route, source, and test behavior evidence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "factory-analyze-evidence-"));
    cleanupPaths.push(dir);
    await mkdir(join(dir, "src", "routes"), { recursive: true });
    await mkdir(join(dir, "src", "stores"), { recursive: true });
    await mkdir(join(dir, "tests"), { recursive: true });
    await writeFile(
      join(dir, "src", "routes", "orders.ts"),
      'router.post("/orders", async (req, res) => {\n  return res.json({ ok: true });\n});\n',
    );
    await writeFile(
      join(dir, "tests", "orders.test.ts"),
      'describe("orders", () => {\n  it("creates an order", () => expect(true).toBe(true));\n});\n',
    );
    await writeFile(
      join(dir, "src", "orderService.ts"),
      "export function createOrder() { return { status: 'draft' }; }\n",
    );
    await writeFile(
      join(dir, "src", "stores", "grantStore.ts"),
      "export function saveGrant(value: string) {\n  localStorage.setItem('grant', value);\n}\n// TODO: sync grants across devices\n",
    );
    await Promise.all(
      Array.from({ length: PURPOSE_EVIDENCE_LIMIT + 5 }, (_, index) =>
        writeFile(
          join(dir, "src", `feature-${String(index).padStart(2, "0")}.ts`),
          `export function feature${index}() { return ${index}; }\n`,
        ),
      ),
    );

    const first = await analyzeExistingCodebase(dir);
    const second = await analyzeExistingCodebase(dir);

    expect(first.purposeEvidence).toEqual(second.purposeEvidence);
    expect(first.purposeEvidence).toHaveLength(PURPOSE_EVIDENCE_LIMIT);
    expect(first.purposeEvidence.map((item) => item.kind)).toEqual(
      expect.arrayContaining(["route", "source", "test"]),
    );
    expect(first.purposeEvidence.map((item) => item.signal)).toEqual(
      expect.arrayContaining([
        "integration, persistence, or data boundary",
        "external integration or persistence behavior",
        "explicit gap, skipped behavior, or unfinished implementation",
      ]),
    );
    expect(first.purposeEvidence.map((item) => item.id)).toEqual(
      Array.from(
        { length: PURPOSE_EVIDENCE_LIMIT },
        (_, index) => `PE-${String(index + 1).padStart(3, "0")}`,
      ),
    );
    expect(
      first.purposeEvidence.every(
        (item) => item.lineStart > 0 && item.lineEnd >= item.lineStart,
      ),
    ).toBe(true);
  });

  it("refuses README and manifest symlinks that escape the repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "factory-analyze-symlink-"));
    const outside = await mkdtemp(join(tmpdir(), "factory-analyze-outside-"));
    cleanupPaths.push(dir, outside);
    const marker = "HOST_SECRET_MUST_NOT_BECOME_EVIDENCE";
    await writeFile(join(outside, "README.md"), marker);
    await writeFile(
      join(outside, "package.json"),
      JSON.stringify({ name: marker, dependencies: { react: "18" } }),
    );
    await symlink(join(outside, "README.md"), join(dir, "README.md"), "file");
    await symlink(outside, join(dir, "client"), "dir");

    const analysis = await analyzeExistingCodebase(dir);

    expect(analysis.readmeExcerpt).toBe("");
    expect(analysis.manifestExcerpts).toEqual([]);
    expect(JSON.stringify(analysis)).not.toContain(marker);
  });

  it("skips oversized repository metadata before reading it into evidence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "factory-analyze-oversized-"));
    cleanupPaths.push(dir);
    const marker = "OVERSIZED_METADATA_MUST_NOT_BECOME_EVIDENCE";
    await writeFile(join(dir, "README.md"), `${marker}${"x".repeat(50 * 1024)}`);
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: marker, padding: "x".repeat(50 * 1024) }),
    );

    const analysis = await analyzeExistingCodebase(dir);

    expect(analysis.readmeExcerpt).toBe("");
    expect(analysis.manifestExcerpts).toEqual([]);
    expect(JSON.stringify(analysis.purposeEvidence)).not.toContain(marker);
  });
});
