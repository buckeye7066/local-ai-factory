import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { ProductSpec, QaReport } from "../../shared/schemas.js";

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
  /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|kts|swift|c|cc|cpp|h|hpp|cs|php|vue|svelte|html?)$/i;
const NON_PRODUCT_PATH =
  /(^|\/)(?:__tests__|tests?|specs?|fixtures?|mocks?|examples?|docs?|scripts?\/fixtures?)(\/|$)|(?:^|\/)(?:test_[^/]+|[^/]+\.(?:test|spec))\.[^.]+$/i;
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
    "Not" + "Implemented(?:Error|Exception)?",
    "raise\\s+Not" + "ImplementedError",
    "throw\\s+new\\s+Error\\s*\\(\\s*[\\\"'`]\\s*(?:not\\s+implemented|" +
      unfinishedWord +
      "|stub(?:bed)?)",
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
  isBrowser?: boolean;
  directEvidenceValid?: boolean;
  outputTail?: string;
};

function packageSignals(workspacePath: string): {
  web: boolean;
  nativeMobile: boolean;
  desktopOrCli: boolean;
  proofText: string;
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
  const manifestText = JSON.stringify(manifests).toLowerCase();
  const web =
    /\b(?:react|vue|vite|next|svelte|angular|astro)\b/.test(manifestText) ||
    files.some((path) =>
      /(^|\/)index\.html$|(^|\/)src\/(?:app|main)\.[cm]?[jt]sx?$/i.test(path),
    );
  const nativeMobile =
    files.some((path) => /^(?:android|ios)\//i.test(path)) ||
    files.some((path) => /(^|\/)capacitor\.config\.[cm]?[jt]s$/i.test(path)) ||
    /\b(?:react-native|expo|@capacitor\/core|cordova)\b/.test(manifestText);
  const packageCli = manifests.some((manifest) => {
    const bin = manifest.bin;
    return typeof bin === "string" || (bin !== null && typeof bin === "object");
  });
  const desktopOrCli =
    packageCli ||
    /\b(?:electron|@tauri-apps\/api)\b/.test(manifestText) ||
    files.some((path) => /^src-tauri\//i.test(path)) ||
    files.some(
      (path) =>
        /(^|\/)pyproject\.toml$/i.test(path) && /(^|\/)(?:cli|bin)\//i.test(path),
    );

  const proofFiles = files.filter((path) =>
    /playwright|(?:^|\/)(?:e2e|tests?)\/|\.github\/workflows|capacitor|gradle|xcodeproj/i.test(
      path,
    ),
  );
  const proofParts: string[] = [];
  for (const path of proofFiles.slice(0, 200)) {
    try {
      const absolute = join(workspacePath, path);
      const size = statSync(absolute).size;
      if (size <= 250_000)
        proofParts.push(`${path}\n${readFileSync(absolute, "utf8")}`);
    } catch {
      // Missing proof is not positive evidence.
    }
  }
  return { web, nativeMobile, desktopOrCli, proofText: proofParts.join("\n") };
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
  const genericPass = successful.length > 0 && successful.length === executed.length;
  const browserPass = successful.some(
    (entry) => entry.isBrowser === true && entry.directEvidenceValid !== false,
  );
  const browserEvidence = successful
    .filter((entry) => entry.isBrowser)
    .map((entry) => entry.command)
    .slice(0, 8);
  const browserText = `${signals.proofText}\n${successful
    .map((entry) => `${entry.command}\n${entry.outputTail ?? ""}`)
    .join("\n")}`;
  const webkitConfigured = /\bwebkit\b|Desktop Safari/i.test(browserText);
  const iosConfigured = /\b(?:iPhone|iPad|Mobile Safari|iOS)\b/i.test(browserText);
  const androidConfigured = /\b(?:Pixel|Android|Mobile Chrome)\b/i.test(browserText);
  const androidNativePass = successful.some((entry) =>
    /(?:gradlew?|capacitor|cordova|expo).*android|android.*(?:assemble|test|build)/i.test(
      `${entry.command}\n${entry.outputTail ?? ""}`,
    ),
  );
  const iosNativePass =
    hostPlatform === "darwin" &&
    successful.some((entry) =>
      /xcodebuild|(?:capacitor|cordova|expo).*ios|ios.*(?:build|test)/i.test(
        `${entry.command}\n${entry.outputTail ?? ""}`,
      ),
    );

  const webkitOk = signals.web && browserPass && webkitConfigured;
  const iosWebOk = signals.web && browserPass && webkitConfigured && iosConfigured;
  const androidWebOk = signals.web && browserPass && androidConfigured;
  const iosOk = (!signals.web || iosWebOk) && (!signals.nativeMobile || iosNativePass);
  const androidOk =
    (!signals.web || androidWebOk) && (!signals.nativeMobile || androidNativePass);

  return {
    windows: target(
      signals.desktopOrCli,
      hostPlatform === "win32" && genericPass,
      hostPlatform === "win32" && genericPass
        ? successful.map((entry) => entry.command).slice(0, 8)
        : [],
    ),
    webkit: target(signals.web, webkitOk, webkitOk ? browserEvidence : []),
    macos: target(
      signals.desktopOrCli,
      hostPlatform === "darwin" && genericPass,
      hostPlatform === "darwin" && genericPass
        ? successful.map((entry) => entry.command).slice(0, 8)
        : [],
    ),
    ios: target(
      signals.web || signals.nativeMobile,
      iosOk,
      iosOk ? browserEvidence : [],
    ),
    android: target(
      signals.web || signals.nativeMobile,
      androidOk,
      androidOk ? browserEvidence : [],
    ),
  };
}
