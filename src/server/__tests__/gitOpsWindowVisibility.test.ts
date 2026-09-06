import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));

import { gh, git } from "../workspace/gitOps.js";

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
}

describe("background repository command windows", () => {
  let child: ReturnType<typeof fakeChild>;

  beforeEach(() => {
    child = fakeChild();
    spawn.mockReset().mockReturnValue(child);
  });

  afterEach(() => {
    vi.useRealTimers();
    child.stdout.destroy();
    child.stderr.destroy();
  });

  for (const [bin, run] of [
    ["git", git],
    ["gh", gh],
  ] as const) {
    it(`hides ${bin} without changing argv, pipes, or lifetime`, async () => {
      const args = ["status", "path with spaces & symbols"];
      const cwd = "C:\\Projects\\My Workspace";
      const pending = run(args, cwd);
      child.stdout.write("  visible in application logs\n");
      child.stderr.write("  diagnostic output\n");
      child.emit("close", 0);

      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledWith(bin, args, {
        cwd,
        shell: false,
        windowsHide: true,
      });
      expect(child.kill).not.toHaveBeenCalled();
      await expect(pending).resolves.toEqual({
        code: 0,
        stdout: "visible in application logs",
        stderr: "diagnostic output",
        spawnError: null,
      });
    });

    it(`still reports a ${bin} startup failure`, async () => {
      const pending = run(["--version"], ".");
      child.emit("error", new Error("executable unavailable"));
      child.emit("close", -1);

      await expect(pending).resolves.toEqual({
        code: null,
        stdout: "",
        stderr: "",
        spawnError: "executable unavailable",
      });
    });
  }

  it("keeps nonzero exits and diagnostics visible to the caller", async () => {
    const pending = git(["status"], ".");
    child.stderr.write("fatal: not a git repository\n");
    child.emit("close", 128);

    await expect(pending).resolves.toEqual({
      code: 128,
      stdout: "",
      stderr: "fatal: not a git repository",
      spawnError: null,
    });
  });

  it("preserves the existing timeout rather than detaching the command", async () => {
    vi.useFakeTimers();
    const pending = git(["status"], ".", 25);
    await vi.advanceTimersByTimeAsync(25);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.emit("close", null);

    await expect(pending).resolves.toEqual({
      code: null,
      stdout: "",
      stderr: "",
      spawnError: null,
    });
  });
});
