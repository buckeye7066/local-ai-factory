import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProductSpec, QaReport } from "../../shared/schemas.js";
import {
  assessPlatformCompatibility,
  enforceCompletionQa,
  scanCompletionGaps,
  withProductionAcceptanceCriteria,
} from "../workspace/completionEvidence.js";

const roots: string[] = [];

function workspace(name: string): string {
  const root = join(process.cwd(), `.test-completion-evidence-${name}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}

function put(root: string, path: string, contents: string): void {
  const absolute = join(root, path);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, contents, "utf8");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const spec: ProductSpec = {
  appName: "Complete App",
  tagline: "",
  targetUser: "Owner",
  coreFeatures: ["Core flow"],
  dataModel: [],
  userFlows: ["Finish the task"],
  acceptanceCriteria: ["Core flow works"],
};

const qa: QaReport = { summary: "QA passed", passed: true, issues: [] };

describe("deterministic completion evidence", () => {
  it("adds the non-optional completion and platform acceptance contract idempotently", () => {
    const once = withProductionAcceptanceCriteria(spec);
    const twice = withProductionAcceptanceCriteria(once);
    expect(once.acceptanceCriteria.length).toBeGreaterThan(
      spec.acceptanceCriteria.length,
    );
    expect(twice.acceptanceCriteria).toEqual(once.acceptanceCriteria);
    expect(once.acceptanceCriteria.join(" ")).toMatch(
      /TODO.*WebKit.*Windows.*Android/i,
    );
  });

  it("finds unfinished production behavior while excluding tests and documentation", () => {
    const root = workspace("gaps");
    put(
      root,
      "src/api.ts",
      "export function save() { throw new Error('Not implemented'); }\n",
    );
    put(root, "src/page.tsx", "export const Page = () => <p>Coming soon</p>;\n");
    put(root, "src/mobile.dart", "void save() { throw UnimplementedError(); }\n");
    put(root, "src/store.py", "# TODO persist this\ndef save():\n    return True\n");
    put(root, "tests/api.test.ts", "// TODO test fixture marker\n");
    put(root, "docs/roadmap.md", "TODO later\n");
    const gaps = scanCompletionGaps(root);
    expect(gaps.map((gap) => gap.path).sort()).toEqual([
      "src/api.ts",
      "src/mobile.dart",
      "src/page.tsx",
      "src/store.py",
    ]);
    expect(enforceCompletionQa(qa, gaps)).toMatchObject({ passed: false });
  });

  it("does not convert ordinary input placeholders or handled error types into missing code", () => {
    const root = workspace("input-placeholder");
    put(
      root,
      "src/Search.tsx",
      'export const Search = () => <input placeholder="Search grants" />;\n',
    );
    put(
      root,
      "src/errors.ts",
      "export class NotImplementedError extends Error {}\n" +
        "export const isKnown = (error: unknown) => error instanceof NotImplementedError;\n",
    );
    expect(scanCompletionGaps(root)).toEqual([]);
  });

  it("requires real browser evidence for Safari, iOS, and Android web targets", () => {
    const root = workspace("web-platforms");
    put(
      root,
      "package.json",
      JSON.stringify({ dependencies: { react: "18", vite: "6" } }),
    );
    put(
      root,
      "playwright.config.ts",
      "projects: [{ name: 'webkit' }, { name: 'Mobile Safari', use: devices['iPhone 15'] }, { name: 'Mobile Chrome', use: devices['Pixel 7'] }]",
    );
    const missing = assessPlatformCompatibility(root, []);
    expect(missing.webkit).toMatchObject({ applicable: true, verified: false });
    expect(missing.ios).toMatchObject({ applicable: true, verified: false });
    expect(missing.android).toMatchObject({ applicable: true, verified: false });

    const verified = assessPlatformCompatibility(root, [
      {
        command: "npx playwright test",
        exitCode: 0,
        isBrowser: true,
        directEvidenceValid: true,
        outputTail: "webkit Mobile Safari iPhone 15 Mobile Chrome Pixel 7 passed",
      },
    ]);
    expect(verified.webkit.verified).toBe(true);
    expect(verified.ios.verified).toBe(true);
    expect(verified.android.verified).toBe(true);
  });

  it("keeps desktop operating systems distinct and never infers the unexecuted host", () => {
    const root = workspace("desktop-platforms");
    put(root, "package.json", JSON.stringify({ bin: { app: "./cli.js" } }));
    const command = [{ command: "npm test", exitCode: 0 }];
    const windows = assessPlatformCompatibility(root, command, "win32");
    expect(windows.windows.verified).toBe(true);
    expect(windows.macos.verified).toBe(false);
    const mac = assessPlatformCompatibility(root, command, "darwin");
    expect(mac.windows.verified).toBe(false);
    expect(mac.macos.verified).toBe(true);

    const aggregated = assessPlatformCompatibility(
      root,
      [
        { command: "pnpm test (windows)", exitCode: 0, hostPlatform: "win32" },
        { command: "pnpm test (macos)", exitCode: 0, hostPlatform: "darwin" },
      ],
      "linux",
    );
    expect(aggregated.windows.verified).toBe(true);
    expect(aggregated.macos.verified).toBe(true);
  });
});
