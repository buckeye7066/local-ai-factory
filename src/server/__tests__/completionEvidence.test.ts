import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProductSpec, QaReport } from "../../shared/schemas.js";
import {
  assessPlatformCompatibility,
  carryForwardPlatformEvidence,
  enforceCompletionQa,
  platformStampForExecutedCommand,
  scanCompletionGaps,
  withProductionAcceptanceCriteria,
} from "../workspace/completionEvidence.js";
import { FactoryCheckpointSchema } from "../orchestrator/checkpoint.js";

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

  it("never promotes Chromium execution through target names found only in static config", () => {
    const root = workspace("chromium-is-not-all-platforms");
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
    const chromiumOnly = assessPlatformCompatibility(root, [
      {
        command: "npx playwright test --project=chromium",
        exitCode: 0,
        isBrowser: true,
        directEvidenceValid: true,
        outputTail: "chromium passed",
      },
    ]);
    expect(chromiumOnly.webkit.verified).toBe(false);
    expect(chromiumOnly.ios.verified).toBe(false);
    expect(chromiumOnly.android.verified).toBe(false);
  });

  it("keeps successful browser targets distinct and accepts explicit runner stamps", () => {
    const root = workspace("target-specific-browser-evidence");
    put(
      root,
      "package.json",
      JSON.stringify({ dependencies: { react: "18", vite: "6" } }),
    );
    const webkitOnly = assessPlatformCompatibility(root, [
      {
        command: "npx playwright test --project=webkit",
        exitCode: 0,
        isBrowser: true,
        directEvidenceValid: true,
      },
    ]);
    expect(webkitOnly.webkit.verified).toBe(true);
    expect(webkitOnly.ios.verified).toBe(false);
    expect(webkitOnly.android.verified).toBe(false);

    const stamped = assessPlatformCompatibility(root, [
      {
        command: "browser-matrix shard 3",
        exitCode: 0,
        isBrowser: true,
        directEvidenceValid: true,
        verifiedTargets: ["ios", "android"],
      },
    ]);
    expect(stamped.webkit.verified).toBe(false);
    expect(stamped.ios.verified).toBe(true);
    expect(stamped.android.verified).toBe(true);
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

    const installOnly = assessPlatformCompatibility(
      root,
      [{ command: "npm ci", exitCode: 0, hostPlatform: "win32" }],
      "linux",
    );
    expect(installOnly.windows.verified).toBe(false);
  });

  it("stamps production command evidence and preserves it through exact-tree resume", () => {
    const windows = {
      command: "pnpm test",
      exitCode: 0,
      outputTail: "all tests passed",
      ...platformStampForExecutedCommand(
        { command: "pnpm test", exitCode: 0, outputTail: "all tests passed" },
        "win32",
      ),
    };
    expect(windows.hostPlatform).toBe("win32");
    const carried = carryForwardPlatformEvidence(
      [windows],
      { "src/app.ts": "digest-a" },
      { "src/app.ts": "digest-a" },
      "darwin",
    );
    expect(carried).toEqual([windows]);
    expect(
      carryForwardPlatformEvidence(
        [windows],
        { "src/app.ts": "digest-a" },
        { "src/app.ts": "digest-b" },
        "darwin",
      ),
    ).toEqual([]);

    const resumed = FactoryCheckpointSchema.parse(
      JSON.parse(
        JSON.stringify({
          schemaVersion: 3,
          runId: crypto.randomUUID(),
          idea: "Ship cross-platform",
          options: {},
          files: [],
          verification: {
            executed: [
              {
                ...windows,
                isBrowser: true,
                verifiedTargets: ["webkit", "ios"],
              },
            ],
            fileDigests: { "src/app.ts": "digest-a" },
          },
          updatedAt: Date.now(),
        }),
      ),
    );
    expect(resumed.verification?.executed[0]).toMatchObject({
      hostPlatform: "win32",
      verifiedTargets: ["webkit", "ios"],
    });
  });

  it("rejects debug-only native builds and requires release, archive, test, or a trusted stamp", () => {
    const root = workspace("native-production-evidence");
    put(root, "android/app/build.gradle", "plugins { id 'com.android.application' }");
    put(root, "ios/App.xcodeproj/project.pbxproj", "// project");
    const debugOnly = assessPlatformCompatibility(root, [
      { command: "./gradlew assembleDebug", exitCode: 0, hostPlatform: "linux" },
      { command: "xcodebuild -scheme App build", exitCode: 0, hostPlatform: "darwin" },
    ]);
    expect(debugOnly.android.verified).toBe(false);
    expect(debugOnly.ios.verified).toBe(false);

    const outputMentionsOnly = assessPlatformCompatibility(root, [
      {
        command: "./gradlew tasks",
        exitCode: 0,
        hostPlatform: "linux",
        outputTail: "assembleRelease bundleRelease",
      },
      {
        command: "pnpm test",
        exitCode: 0,
        hostPlatform: "darwin",
        outputTail: "documentation mentions xcodebuild archive",
      },
    ]);
    expect(outputMentionsOnly.android.verified).toBe(false);
    expect(outputMentionsOnly.ios.verified).toBe(false);

    const production = assessPlatformCompatibility(root, [
      { command: "./gradlew assembleRelease", exitCode: 0, hostPlatform: "linux" },
      {
        command: "xcodebuild -scheme App archive",
        exitCode: 0,
        hostPlatform: "darwin",
      },
    ]);
    expect(production.android.verified).toBe(true);
    expect(production.ios.verified).toBe(true);
  });
});
