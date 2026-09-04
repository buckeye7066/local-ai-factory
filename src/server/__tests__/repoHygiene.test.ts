import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(process.cwd());

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
}

describe("repository hygiene", () => {
  it("tracks no backup snapshots", () => {
    const backups = trackedFiles().filter((path) => /\.bak-/i.test(path));
    expect(backups).toEqual([]);
  });

  it("uses one authoritative pnpm lockfile", () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
      packageManager?: string;
    };
    expect(pkg.packageManager).toMatch(/^pnpm@/);
    expect(existsSync(resolve(ROOT, "pnpm-lock.yaml"))).toBe(true);
    expect(existsSync(resolve(ROOT, "package-lock.json"))).toBe(false);
    expect(existsSync(resolve(ROOT, "npm-shrinkwrap.json"))).toBe(false);
    expect(existsSync(resolve(ROOT, "yarn.lock"))).toBe(false);
  });

  it("does not track failed proof receipts as current evidence", () => {
    const failed: string[] = [];
    for (const path of trackedFiles().filter((name) =>
      /^docs\/evidence\/.*-proof\.json$/i.test(name),
    )) {
      const data = JSON.parse(readFileSync(resolve(ROOT, path), "utf8")) as {
        ok?: unknown;
      };
      if (data.ok !== true) failed.push(path);
    }
    expect(failed).toEqual([]);
  });

  it("contains no hard-coded Windows user-home path in executable source", () => {
    const offenders: string[] = [];
    const executable = trackedFiles().filter(
      (path) =>
        /^(?:src|scripts|\.github)\//.test(path) &&
        /\.(?:ts|tsx|js|mjs|cjs|ps1|cmd|ya?ml)$/i.test(path),
    );
    for (const path of executable) {
      const text = readFileSync(resolve(ROOT, path), "utf8");
      const normalized = text.replaceAll("\\\\", "\\");
      const windowsUsersRoot = ["C:", "Users"].join("\\") + "\\";
      if (normalized.toLowerCase().includes(windowsUsersRoot.toLowerCase())) {
        offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("does not publish the retired OpenAI model as a runtime default", () => {
    const publicRuntimeGuidance = [
      ".env.example",
      "README.md",
      "PROJECT-BRIEF.md",
      "scripts/phone/phone.env.example",
      ".github/workflows/factory-deck-cloud.yml",
      ".github/workflows/purpose-foundry-cloud.yml",
    ];
    const offenders = publicRuntimeGuidance.filter((path) =>
      readFileSync(resolve(ROOT, path), "utf8").includes("gpt-5.5"),
    );
    expect(offenders).toEqual([]);
  });

  it("recursively assigns code owners to the entire GitHub control plane", () => {
    const codeowners = readFileSync(resolve(ROOT, ".github/CODEOWNERS"), "utf8");
    expect(codeowners).toContain("/.github/** @buckeye7066");
    expect(codeowners).not.toMatch(/^\/\.github\/(?:workflows|ISSUE_TEMPLATE)\/$/m);
  });

  it("publishes the immutable Anthropic fallback snapshot consistently", () => {
    const publicRuntimeGuidance = [".env.example", "README.md", "PROJECT-BRIEF.md"];
    const flexibleHaiku = /claude-haiku-4-5(?!-\d{8})/;
    const offenders = publicRuntimeGuidance.filter((path) =>
      flexibleHaiku.test(readFileSync(resolve(ROOT, path), "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
