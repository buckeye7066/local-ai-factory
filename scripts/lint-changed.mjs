#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const SHA_RX = /^[0-9a-f]{40}$/i;
const ZERO_SHA_RX = /^0+$/;
const SOURCE_RX = /^src\/.*\.(?:ts|tsx|css)$/i;

function git(args) {
  return spawnSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function usableCommit(value) {
  if (!SHA_RX.test(value) || ZERO_SHA_RX.test(value)) return false;
  return git(["cat-file", "-e", `${value}^{commit}`]).status === 0;
}

function baseCommit() {
  const baseWasSupplied = Object.hasOwn(process.env, "LINT_BASE_SHA");
  const requested = String(process.env.LINT_BASE_SHA ?? "").trim();
  if (baseWasSupplied) {
    // A zero/missing/unfetched event SHA must never shrink the lint scope to
    // HEAD^. Multi-commit pushes would otherwise hide formatting introduced in
    // earlier commits. Returning null makes changedSourceFiles lint every
    // tracked source file: slower, but fail-closed and deterministic.
    return usableCommit(requested) ? requested : null;
  }
  const parent = git(["rev-parse", "HEAD^"]);
  return parent.status === 0 ? parent.stdout.trim() : null;
}

function changedSourceFiles(base) {
  const args = base
    ? ["diff", "--name-only", "--diff-filter=ACMR", "-z", `${base}...HEAD`]
    : ["ls-files", "-z"];
  const result = git(args);
  if (result.status !== 0) {
    process.stderr.write(result.stderr || "Could not determine changed files.\n");
    process.exit(result.status ?? 1);
  }
  return result.stdout
    .split("\0")
    .filter((path) => SOURCE_RX.test(path) && existsSync(resolve(path)));
}

const files = changedSourceFiles(baseCommit());
if (files.length === 0) {
  console.log("No changed TypeScript/TSX/CSS files require formatting checks.");
  process.exit(0);
}

const prettierBin = resolve("node_modules", "prettier", "bin", "prettier.cjs");
if (!existsSync(prettierBin)) {
  console.error(
    "Prettier is not installed; run the pinned package-manager install first.",
  );
  process.exit(1);
}

for (let offset = 0; offset < files.length; offset += 50) {
  const batch = files.slice(offset, offset + 50);
  const result = spawnSync(process.execPath, [prettierBin, "--check", ...batch], {
    cwd: process.cwd(),
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
