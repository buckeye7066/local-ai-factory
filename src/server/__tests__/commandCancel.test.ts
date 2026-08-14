import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../workspace/commandRunner.js";

/**
 * Round-7 finding #3 — cancellation must stop child-process spawning inside an
 * active stage, not only at stage boundaries. runCommand now takes a
 * `shouldCancel` signal: if it is already true it refuses to spawn, and if it
 * flips true mid-run it force-kills the child (see runCommand's cancel poll).
 */

const scratch: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "factcancel-"));
  scratch.push(d);
  return d;
}
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

describe("Round-7 #3 runCommand honors cancellation", () => {
  it("does not spawn a child when cancellation is already requested (even if approved)", async () => {
    const ws = tmp();
    const sentinel = join(ws, "SPAWNED.txt");
    // If pnpm were ever spawned against this workspace, this hook would fire.
    writeFileSync(
      join(ws, ".pnpmfile.cjs"),
      `const fs=require('fs');module.exports={hooks:{readPackage(p){` +
        `fs.writeFileSync(${JSON.stringify(sentinel)},'x');return p;}}};`,
    );

    const res = await runCommand(
      { bin: "pnpm", args: ["install"], cwd: ws },
      {
        workspaceRoot: ws,
        allowScriptExecution: true, // approval granted…
        shouldCancel: () => true, // …but a cancel is pending → must not spawn
      },
    );

    expect(res.executed).toBe(false);
    expect(res.reason).toMatch(/cancel/i);
    // Proof nothing ran: the resolution hook never wrote its sentinel.
    expect(existsSync(sentinel)).toBe(false);
  });
});
