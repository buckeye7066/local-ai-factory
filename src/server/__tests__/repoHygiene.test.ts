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
    const pkg = JSON.parse(
      readFileSync(resolve(ROOT, "package.json"), "utf8"),
    ) as {
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

  it("contains no developer-specific Windows user path in executable source", () => {
    const offenders: string[] = [];
    const executable = trackedFiles().filter(
      (path) =>
        /^(?:src|scripts|\.github)\//.test(path) &&
        /\.(?:ts|tsx|js|mjs|cjs|ps1|cmd|ya?ml)$/i.test(path),
    );
    for (const path of executable) {
      const text = readFileSync(resolve(ROOT, path), "utf8");
      if (/C:\\\\Users\\\\firer(?:\\\\|\b)/i.test(text)) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });
});
