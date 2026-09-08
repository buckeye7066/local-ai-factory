import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { deliverRun, type DeliveryInput } from "../orchestrator/deliverRun.js";
import { captureFileDigests } from "../workspace/verificationReceipt.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "factory-delivery-recovery-"));
  roots.push(root);
  const remote = join(root, "remote.git"),
    workspace = join(root, "workspace");
  git(root, "init", "--bare", "-q", "-b", "main", remote);
  git(root, "init", "-q", "-b", "main", workspace);
  git(workspace, "config", "user.email", "test@example.com");
  git(workspace, "config", "user.name", "Regression Test");
  await mkdir(join(workspace, ".github", "workflows"), { recursive: true });
  await writeFile(
    join(workspace, ".github", "workflows", "ci.yml"),
    "name: ci\non: [push, pull_request]\njobs: {}\n",
  );
  git(workspace, "add", ".");
  git(workspace, "commit", "-qm", "seed host CI");
  git(workspace, "remote", "add", "origin", remote);
  git(workspace, "push", "-q", "origin", "main");
  const branch = "factory-deck/saved-run";
  git(workspace, "checkout", "-qb", branch);
  await writeFile(join(workspace, "feature.ts"), "export const feature = () => 42;\n");
  const input: DeliveryInput = {
    destination: {
      kind: "existing-repo",
      target: remote,
      branch,
      status: "planned",
      detail: null,
      url: null,
      deliveredAt: null,
    },
    workspacePath: workspace,
    filePaths: ["feature.ts"],
    runId: randomUUID(),
    appName: "Recovery",
    options: {},
    verification: {
      qaPassed: true,
      testStatus: "passing",
      writeRefusals: 0,
      incompleteCommands: 0,
      fileDigests: await captureFileDigests(workspace, ["feature.ts"]),
    },
  };
  return { root, remote, workspace, branch, input };
}

describe("idempotent delivery of verified work", () => {
  it("reuses completed delivery without recreating a branch deleted after merge", async () => {
    const f = await fixture();
    const delivered = await deliverRun(f.input);
    expect(delivered.status).toBe("delivered");
    expect(delivered.branchPushed).toBe(true);
    git(f.remote, "update-ref", "-d", `refs/heads/${f.branch}`);
    const result = await deliverRun({ ...f.input, destination: delivered });
    expect(result.commitSha).toBe(delivered.commitSha);
    expect(result.status).toBe("delivered");
    expect(git(f.remote, "for-each-ref", `refs/heads/${f.branch}`)).toBe("");
    expect(git(f.workspace, "rev-parse", "HEAD")).toBe(delivered.commitSha);
  }, 60_000);

  it("does not let a completed delivery receipt authorize changed workspace bytes", async () => {
    const f = await fixture();
    const delivered = await deliverRun(f.input);
    await writeFile(join(f.workspace, "feature.ts"), "unverified content");
    const result = await deliverRun({ ...f.input, destination: delivered });
    expect(result.status).not.toBe("delivered");
    expect(result.detail).toMatch(/receipt is invalid/);
    expect(git(f.remote, "rev-parse", f.branch)).toBe(delivered.commitSha);
  }, 60_000);

  it("rejects a changed HEAD even when the deliverable file still matches", async () => {
    const f = await fixture();
    const delivered = await deliverRun(f.input);
    await writeFile(join(f.workspace, "unverified.txt"), "not approved");
    git(f.workspace, "add", "unverified.txt");
    git(f.workspace, "commit", "-qm", "unverified change");
    const result = await deliverRun({ ...f.input, destination: delivered });
    expect(result.status).toBe("failed");
    expect(result.detail).toContain("REFUSED");
    expect(git(f.remote, "rev-parse", f.branch)).toBe(delivered.commitSha);
  }, 60_000);

  it("retries a rejected push using the same receipt-bound commit", async () => {
    const f = await fixture();
    const hook = join(f.remote, "hooks", "pre-receive");
    await writeFile(hook, "#!/bin/sh\necho temporarily-unavailable >&2\nexit 1\n", {
      mode: 0o755,
    });
    const failed = await deliverRun(f.input);
    expect(failed.status).toBe("failed");
    const committed = git(f.workspace, "rev-parse", "HEAD");
    await rm(hook);
    const retried = await deliverRun({ ...f.input, destination: failed });
    expect(retried.status).toBe("delivered");
    expect(retried.commitSha).toBe(committed);
    expect(git(f.remote, "rev-parse", f.branch)).toBe(committed);
  }, 60_000);
});
