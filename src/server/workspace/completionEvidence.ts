import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { FileBuild, ProductSpec, QaReport } from "../../shared/schemas.js";
import { MAX_CONTEXT_FILE_CHARS, MAX_CONTEXT_TOTAL_CHARS } from "./contextLimits.js";
import { readWorkspaceFile } from "./fileWriter.js";

/**
 * Deterministic completion evidence used by both the repair loop and the final
 * production-readiness receipt. Model prose is never allowed to declare a
 * placeholder, TODO, stubbed route, or missing platform run "done".
 */

export const COMPLETION_ACCEPTANCE_CRITERIA = Object.freeze([
  "[COMPLETION] Production source contains no TODO, FIXME, not-implemented, coming-soon, or placeholder behavior; every required path is implemented, wired, and directly tested.",
  "[PLATFORM-WEB] When a browser UI is present, its essential workflows pass in desktop Safari/WebKit, mobile Safari, and an Android Chrome profile.",
  "[PLATFORM-DESKTOP] When a desktop or command-line product is present, installation, launch, and the essential workflow pass on Windows and macOS.",
  "[PLATFORM-MOBILE] When native mobile targets are present, production builds and essential workflows pass on both Android and iOS.",
] as const);

export function withProductionAcceptanceCriteria(spec: ProductSpec): ProductSpec {
  const acceptanceCriteria = [...spec.acceptanceCriteria];
  for (const criterion of COMPLETION_ACCEPTANCE_CRITERIA) {
    if (!acceptanceCriteria.includes(criterion)) acceptanceCriteria.push(criterion);
  }
  return { ...spec, acceptanceCriteria };
}

export type CompletionGapKind =
  | "unfinished-marker"
  | "unimplemented-path"
  | "placeholder-experience"
  | "scan-incomplete";

export type CompletionGap = {
  path: string;
  line: number;
  kind: CompletionGapKind;
  excerpt: string;
};

const SKIP_DIRS = new Set([
  ".git",
  ".factory",
  ".next",
  ".nuxt",
  ".output",
  ".turbo",
  ".venv",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "generated",
  "node_modules",
  "out",
  "target",
  "vendor",
]);

const SOURCE_EXTENSION =
  /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|kts|swift|dart|scala|sc|lua|r|fs|fsx|vb|c|cc|cpp|h|hpp|cs|php|sh|bash|zsh|ps1|psm1|sql|graphql|gql|vue|svelte|html?)$/i;
const NON_PRODUCT_PATH =
  /(^|\/)(?:__tests__|tests?|specs?|fixtures?|mocks?|examples?|docs?|scripts?\/fixtures?)(\/|$)|^(?:scripts?|tools?)\/|(?:^|\/)(?:test_[^/]+|[^/]+\.(?:test|spec))\.[^.]+$|(?:^|\/)(?:vitest|jest|playwright|vite)(?:\.[\w-]+)?\.config\.[cm]?[jt]s$|(?:^|\/)(?:tsconfig(?:\.[\w-]+)?\.json|eslint\.config\.[cm]?[jt]s)$/i;
const GENERATED_FILE = /\.(?:min|bundle)\.[^.]+$/i;
const MAX_SOURCE_FILES = 15_000;
const MAX_SOURCE_BYTES = 1_000_000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_GAPS = 500;

const unfinishedWord = "TO" + "DO";
const fixmeWord = "FIX" + "ME";
const unfinishedMarker = new RegExp(
  `\\b(?:${unfinishedWord}|${fixmeWord}|IMPLEMENT[ _-]?ME|TBD)\\b`,
  "i",
);
const unimplementedPath = new RegExp(
  [
    "raise\\s+Not" + "Implemented(?:Error|Exception)?",
    "throw\\s+(?:new\\s+)?(?:Not" +
      "Implemented(?:Error|Exception)?|UnimplementedError)",
    "throw\\s+new\\s+(?:Error|UnsupportedOperationException)\\s*\\(\\s*[\\\"'`]\\s*(?:not\\s+implemented|" +
      unfinishedWord +
      "|stub(?:bed)?)",
    "\\b(?:to" + "do|unimplemented)!\\s*\\(",
    "(?:status|sendStatus)\\s*\\(\\s*501\\s*\\)",
  ].join("|"),
  "i",
);
const placeholderExperience = new RegExp(
  `\\b(?:coming\\s+soon|under\\s+construction|lorem\\s+ipsum|replace\\s+me|${unfinishedWord}:)\\b`,
  "i",
);

function normalized(path: string): string {
  return path.replace(/\\/g, "/");
}

type WalkResult = {
  files: string[];
  incomplete: CompletionGap[];
};

function productSourceFiles(root: string): WalkResult {
  const files: string[] = [];
  const incomplete: CompletionGap[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      incomplete.push({
        path: normalized(relative(root, dir)) || ".",
        line: 0,
        kind: "scan-incomplete",
        excerpt: `Unreadable directory: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      const rel = normalized(relative(root, absolute));
      let info;
      try {
        info = lstatSync(absolute);
      } catch {
        incomplete.push({
          path: rel,
          line: 0,
          kind: "scan-incomplete",
          excerpt: "Path could not be inspected.",
        });
        continue;
      }
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name.toLowerCase())) pending.push(absolute);
        continue;
      }
      if (
        !info.isFile() ||
        !SOURCE_EXTENSION.test(rel) ||
        NON_PRODUCT_PATH.test(rel) ||
        GENERATED_FILE.test(rel) ||
        rel.endsWith(".d.ts")
      ) {
        continue;
      }
      files.push(absolute);
      if (files.length > MAX_SOURCE_FILES) {
        incomplete.push({
          path: "(completion scan)",
          line: 0,
          kind: "scan-incomplete",
          excerpt: `Production source inventory exceeded ${MAX_SOURCE_FILES} files.`,
        });
        return { files: files.slice(0, MAX_SOURCE_FILES), incomplete };
      }
    }
  }
  return { files, incomplete };
}

function lineGap(path: string, line: string, lineNumber: number): CompletionGap | null {
  const excerpt = line.trim().slice(0, 240);
  if (unfinishedMarker.test(line)) {
    return { path, line: lineNumber, kind: "unfinished-marker", excerpt };
  }
  if (unimplementedPath.test(line)) {
    return { path, line: lineNumber, kind: "unimplemented-path", excerpt };
  }
  if (placeholderExperience.test(line)) {
    return { path, line: lineNumber, kind: "placeholder-experience", excerpt };
  }
  return null;
}

export function scanCompletionGaps(workspacePath: string): CompletionGap[] {
  const inventory = productSourceFiles(workspacePath);
  const gaps = [...inventory.incomplete];
  let totalBytes = 0;
  for (const absolute of inventory.files) {
    const path = normalized(relative(workspacePath, absolute));
    let size = 0;
    try {
      size = statSync(absolute).size;
    } catch {
      gaps.push({
        path,
        line: 0,
        kind: "scan-incomplete",
        excerpt: "Production source size could not be read.",
      });
      continue;
    }
    if (size > MAX_SOURCE_BYTES) {
      gaps.push({
        path,
        line: 0,
        kind: "scan-incomplete",
        excerpt: `Production source exceeds the ${MAX_SOURCE_BYTES}-byte inspection limit.`,
      });
      continue;
    }
    totalBytes += size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      gaps.push({
        path: "(completion scan)",
        line: 0,
        kind: "scan-incomplete",
        excerpt: `Production source exceeded the ${MAX_TOTAL_BYTES}-byte aggregate inspection limit.`,
      });
      break;
    }
    let source: string;
    try {
      source = readFileSync(absolute, "utf8");
    } catch {
      gaps.push({
        path,
        line: 0,
        kind: "scan-incomplete",
        excerpt: "Production source could not be read as UTF-8.",
      });
      continue;
    }
    if (source.includes("\0")) continue;
    const lines = source.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const gap = lineGap(path, lines[index]!, index + 1);
      if (gap) gaps.push(gap);
      if (gaps.length >= MAX_GAPS) {
        gaps.push({
          path: "(completion scan)",
          line: 0,
          kind: "scan-incomplete",
          excerpt: `At least ${MAX_GAPS} unfinished production paths remain; output was capped.`,
        });
        return gaps;
      }
    }
  }
  return gaps;
}

export type CompletionRepairContext = {
  files: FileBuild["files"];
  refusals: Array<{ path: string; reason: string }>;
};

/**
 * Read only existing product-source files named by the deterministic gap scan,
 * and only when every byte fits in the repair agent's real context.
 *
 * The scan is not write authority. This independently checks the current
 * product-source inventory, uses the contained no-symlink reader, re-confirms
 * the unfinished behavior, and fails closed on unsafe or incomplete input.
 */
export async function loadCompletionRepairContext(
  workspacePath: string,
  gaps: CompletionGap[],
): Promise<CompletionRepairContext> {
  const inventory = productSourceFiles(workspacePath);
  const eligible = new Set(
    inventory.files.map((absolute) => normalized(relative(workspacePath, absolute))),
  );
  const requested = [...new Set(gaps.map((gap) => normalized(gap.path)))].sort();
  const files: FileBuild["files"] = [];
  const refusals: Array<{ path: string; reason: string }> = [];
  let totalChars = 0;

  for (const path of requested) {
    const pathGaps = gaps.filter((gap) => normalized(gap.path) === path);
    if (pathGaps.some((gap) => gap.kind === "scan-incomplete")) {
      refusals.push({
        path,
        reason: `completion repair source is unreadable or incomplete: ${pathGaps
          .map((gap) => gap.excerpt)
          .join("; ")}`,
      });
      continue;
    }
    if (!eligible.has(path)) {
      refusals.push({
        path,
        reason:
          "completion repair source was not an inspected product-source file (tests, config, tooling, generated, unseen, and escaping paths are forbidden)",
      });
      continue;
    }

    let contents: string;
    try {
      contents = await readWorkspaceFile(workspacePath, path);
    } catch (error) {
      refusals.push({
        path,
        reason: `completion repair source could not be read safely: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      continue;
    }
    if (contents.includes("\0")) {
      refusals.push({ path, reason: "completion repair source is not UTF-8 text" });
      continue;
    }
    if (contents.length > MAX_CONTEXT_FILE_CHARS) {
      refusals.push({
        path,
        reason: `completion repair source exceeds the ${MAX_CONTEXT_FILE_CHARS}-character per-file context limit`,
      });
      continue;
    }
    if (totalChars + contents.length > MAX_CONTEXT_TOTAL_CHARS) {
      refusals.push({
        path,
        reason: `completion repair sources exceed the ${MAX_CONTEXT_TOTAL_CHARS}-character aggregate context limit`,
      });
      continue;
    }
    const stillIncomplete = contents
      .split(/\r?\n/)
      .some((line, index) => lineGap(path, line, index + 1) !== null);
    if (!stillIncomplete) {
      refusals.push({
        path,
        reason:
          "completion repair source changed after scanning and no longer contains the scanned unfinished behavior",
      });
      continue;
    }
    totalChars += contents.length;
    files.push({
      path,
      purpose:
        "Implement the deterministic unfinished production behavior in this existing source file without changing unrelated host code.",
      contents,
      edits: [],
    });
  }
  return { files, refusals };
}

export function enforceCompletionQa<T extends QaReport>(
  qa: T,
  gaps: CompletionGap[],
): T {
  if (gaps.length === 0) return qa;
  const listed = gaps
    .slice(0, 20)
    .map((gap) => `${gap.path}${gap.line ? `:${gap.line}` : ""} (${gap.kind})`)
    .join(", ");
  return {
    ...qa,
    passed: false,
    summary: `IMPLEMENTATION INCOMPLETE: ${gaps.length} deterministic completion gap(s) remain. ${qa.summary}`,
    issues: [
      {
        severity: "high",
        title: `${gaps.length} placeholder or unfinished production path(s) remain`,
        detail: listed,
        file: gaps[0]?.path ?? null,
        repairInstruction:
          "Implement each named production path with real behavior, wire it into the app, and add direct executable acceptance coverage. Do not delete a required feature or replace the marker with vague prose to silence this gate.",
      },
      ...qa.issues,
    ],
  };
}

export type PlatformTarget = "windows" | "webkit" | "macos" | "ios" | "android";
export type PlatformTargetEvidence = {
  applicable: boolean;
  verified: boolean;
  evidence: string[];
};
export type PlatformCompatibilityEvidence = Record<
  PlatformTarget,
  PlatformTargetEvidence
>;

export type ExecutedPlatformCommand = {
  command: string;
  exitCode: number | null;
  /** Stamp imported CI evidence with the OS that actually executed it. */
  hostPlatform?: NodeJS.Platform;
  isTest?: boolean;
  isBrowser?: boolean;
  /** Targets this successful invocation directly exercised. */
  verifiedTargets?: PlatformTarget[];
  directEvidenceValid?: boolean;
  outputTail?: string;
};

const BROWSER_TARGET_PATTERNS: Record<"webkit" | "ios" | "android", RegExp> = {
  webkit: /\bwebkit\b|Desktop Safari/i,
  ios: /\b(?:iPhone|iPad|Mobile Safari|iOS)\b/i,
  android: /\b(?:Pixel|Android|Mobile Chrome)\b/i,
};

const ANDROID_PRODUCTION_EVIDENCE =
  /(?:gradlew?|capacitor|cordova|expo)[^\n]*(?:assembleRelease|bundleRelease|testRelease|connectedAndroidTest|lintRelease|android[^\n]*(?:release|test))|android[^\n]*(?:assembleRelease|bundleRelease|testRelease|connectedAndroidTest|lintRelease)/i;
const IOS_PRODUCTION_EVIDENCE =
  /xcodebuild[^\n]*(?:archive|test|build-for-testing|test-without-building|-configuration\s+Release)|(?:capacitor|cordova|expo)[^\n]*ios[^\n]*(?:release|archive|test)/i;
const EXECUTABLE_VERIFICATION_COMMAND =
  /(?:^|\s|:)(?:test|build|lint|typecheck|check|verify)(?:\s|$|:)|\b(?:pytest|vitest|jest|playwright|xcodebuild)\b|\b(?:cargo|dotnet|swift)\s+(?:test|build)\b|\bgradlew?\b[^\n]*(?:assemble|bundle|test|lint)/i;

/** Stamp target evidence at the command-runner boundary, never from config. */
export function platformStampForExecutedCommand(
  entry: Omit<ExecutedPlatformCommand, "hostPlatform" | "verifiedTargets">,
  hostPlatform: NodeJS.Platform = process.platform,
): Pick<ExecutedPlatformCommand, "hostPlatform" | "verifiedTargets"> {
  const browserText = `${entry.command}\n${entry.outputTail ?? ""}`;
  const verifiedTargets: PlatformTarget[] = [];
  if (
    entry.exitCode === 0 &&
    entry.isBrowser === true &&
    entry.directEvidenceValid !== false
  ) {
    for (const targetName of ["webkit", "ios", "android"] as const) {
      if (BROWSER_TARGET_PATTERNS[targetName].test(browserText))
        verifiedTargets.push(targetName);
    }
  }
  if (entry.exitCode === 0 && entry.isBrowser !== true) {
    if (ANDROID_PRODUCTION_EVIDENCE.test(entry.command))
      verifiedTargets.push("android");
    if (hostPlatform === "darwin" && IOS_PRODUCTION_EVIDENCE.test(entry.command)) {
      verifiedTargets.push("ios");
    }
  }
  return {
    hostPlatform,
    ...(verifiedTargets.length > 0 ? { verifiedTargets } : {}),
  };
}

/** Preserve other-OS evidence only when it covers these exact deliverable bytes. */
export function carryForwardPlatformEvidence<T extends ExecutedPlatformCommand>(
  executed: T[],
  priorDigests: Record<string, string> | undefined,
  currentDigests: Record<string, string>,
  currentHost: NodeJS.Platform = process.platform,
): T[] {
  const priorEntries = Object.entries(priorDigests ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const currentEntries = Object.entries(currentDigests).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const sameTree =
    priorEntries.length > 0 &&
    priorEntries.length === currentEntries.length &&
    priorEntries.every(
      ([path, digest], index) =>
        currentEntries[index]?.[0] === path && currentEntries[index]?.[1] === digest,
    );
  if (!sameTree) return [];
  return executed.filter(
    (entry) => entry.hostPlatform !== undefined && entry.hostPlatform !== currentHost,
  );
}

function packageSignals(workspacePath: string): {
  web: boolean;
  nativeMobile: boolean;
  desktopOrCli: boolean;
} {
  const files: string[] = [];
  const pending = [workspacePath];
  while (pending.length > 0 && files.length < 8_000) {
    const dir = pending.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      const rel = normalized(relative(workspacePath, absolute));
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name.toLowerCase())) pending.push(absolute);
      } else if (entry.isFile()) {
        files.push(rel);
      }
    }
  }

  const packageJson = files.filter((path) => /(^|\/)package\.json$/i.test(path));
  const manifests: Record<string, unknown>[] = [];
  for (const path of packageJson.slice(0, 40)) {
    try {
      const raw = readFileSync(join(workspacePath, path), "utf8");
      if (raw.length <= 500_000) manifests.push(JSON.parse(raw));
    } catch {
      // An unreadable manifest cannot create positive compatibility evidence.
    }
  }
  const packageNames = new Set<string>();
  for (const manifest of manifests) {
    for (const field of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      const dependencies = manifest[field];
      if (dependencies !== null && typeof dependencies === "object") {
        for (const name of Object.keys(dependencies)) {
          packageNames.add(name.toLowerCase());
        }
      }
    }
  }
  const hasPackage = (...names: string[]) =>
    names.some((name) => packageNames.has(name));
  const web =
    hasPackage(
      "react-dom",
      "next",
      "vue",
      "nuxt",
      "svelte",
      "@sveltejs/kit",
      "@angular/core",
      "astro",
      "preact",
      "solid-js",
      "lit",
    ) || files.some((path) => /(^|\/)(?:public\/)?index\.html$/i.test(path));
  const nativeMobile =
    files.some((path) => /^(?:android|ios)\//i.test(path)) ||
    files.some((path) => /(^|\/)capacitor\.config\.[cm]?[jt]s$/i.test(path)) ||
    hasPackage("react-native", "expo", "@capacitor/core", "cordova");
  const packageCli = manifests.some((manifest) => {
    const bin = manifest.bin;
    return typeof bin === "string" || (bin !== null && typeof bin === "object");
  });
  const desktopOrCli =
    packageCli ||
    hasPackage("electron", "@tauri-apps/api") ||
    files.some((path) => /^src-tauri\//i.test(path)) ||
    files.some(
      (path) =>
        /(^|\/)pyproject\.toml$/i.test(path) && /(^|\/)(?:cli|bin)\//i.test(path),
    );

  return { web, nativeMobile, desktopOrCli };
}

function target(
  applicable: boolean,
  verified: boolean,
  evidence: string[],
): PlatformTargetEvidence {
  return {
    applicable,
    verified: applicable ? verified : true,
    evidence: applicable ? evidence : ["not applicable to detected product surfaces"],
  };
}

export function assessPlatformCompatibility(
  workspacePath: string,
  executed: ExecutedPlatformCommand[],
  hostPlatform: NodeJS.Platform = process.platform,
): PlatformCompatibilityEvidence {
  const signals = packageSignals(workspacePath);
  const successful = executed.filter((entry) => entry.exitCode === 0);
  const ranOn = (entry: ExecutedPlatformCommand, platform: NodeJS.Platform) =>
    (entry.hostPlatform ?? hostPlatform) === platform;
  const platformPassed = (platform: NodeJS.Platform) => {
    const commands = executed.filter((entry) => ranOn(entry, platform));
    const verificationRan = commands.some(
      (entry) =>
        entry.isTest === true || EXECUTABLE_VERIFICATION_COMMAND.test(entry.command),
    );
    return verificationRan && commands.every((entry) => entry.exitCode === 0);
  };
  const platformEvidence = (platform: NodeJS.Platform) =>
    successful
      .filter((entry) => ranOn(entry, platform))
      .map((entry) => entry.command)
      .slice(0, 8);
  const successfulBrowsers = successful.filter(
    (entry) => entry.isBrowser === true && entry.directEvidenceValid !== false,
  );
  const browserTargetEvidence = (platformTarget: PlatformTarget, pattern: RegExp) =>
    successfulBrowsers.filter((entry) => {
      if (entry.verifiedTargets?.includes(platformTarget)) return true;
      return pattern.test(`${entry.command}\n${entry.outputTail ?? ""}`);
    });
  // Static Playwright/project configuration establishes what ought to run, but
  // never proves that target ran. Only successful target-specific executions
  // (or an explicit verifiedTargets stamp from an imported runner) count.
  const webkitBrowserEvidence = browserTargetEvidence(
    "webkit",
    BROWSER_TARGET_PATTERNS.webkit,
  );
  const iosBrowserEvidence = browserTargetEvidence("ios", BROWSER_TARGET_PATTERNS.ios);
  const androidBrowserEvidence = browserTargetEvidence(
    "android",
    BROWSER_TARGET_PATTERNS.android,
  );
  const androidNativeEvidence = successful.filter(
    (entry) =>
      entry.isBrowser !== true &&
      (entry.verifiedTargets?.includes("android") === true ||
        ANDROID_PRODUCTION_EVIDENCE.test(entry.command)),
  );
  const androidNativePass = androidNativeEvidence.length > 0;
  const iosNativeEvidence = successful.filter(
    (entry) =>
      ranOn(entry, "darwin") &&
      entry.isBrowser !== true &&
      (entry.verifiedTargets?.includes("ios") === true ||
        IOS_PRODUCTION_EVIDENCE.test(entry.command)),
  );
  const iosNativePass = iosNativeEvidence.length > 0;

  const webkitOk = signals.web && webkitBrowserEvidence.length > 0;
  const iosWebOk = signals.web && iosBrowserEvidence.length > 0;
  const androidWebOk = signals.web && androidBrowserEvidence.length > 0;
  const iosOk = (!signals.web || iosWebOk) && (!signals.nativeMobile || iosNativePass);
  const androidOk =
    (!signals.web || androidWebOk) && (!signals.nativeMobile || androidNativePass);

  return {
    windows: target(
      signals.desktopOrCli,
      platformPassed("win32"),
      platformPassed("win32") ? platformEvidence("win32") : [],
    ),
    webkit: target(
      signals.web,
      webkitOk,
      webkitOk ? webkitBrowserEvidence.map((entry) => entry.command).slice(0, 8) : [],
    ),
    macos: target(
      signals.desktopOrCli,
      platformPassed("darwin"),
      platformPassed("darwin") ? platformEvidence("darwin") : [],
    ),
    ios: target(
      signals.web || signals.nativeMobile,
      iosOk,
      iosOk
        ? [
            ...iosBrowserEvidence.map((entry) => entry.command),
            ...iosNativeEvidence.map((entry) => entry.command),
          ].slice(0, 8)
        : [],
    ),
    android: target(
      signals.web || signals.nativeMobile,
      androidOk,
      androidOk
        ? [
            ...androidBrowserEvidence.map((entry) => entry.command),
            ...androidNativeEvidence.map((entry) => entry.command),
          ].slice(0, 8)
        : [],
    ),
  };
}
