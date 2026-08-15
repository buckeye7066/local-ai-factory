import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verificationCommandsForWorkspace } from "../workspace/verificationCommands.js";
import { isAllowed } from "../workspace/commandRunner.js";

const workspaces: string[] = [];

function workspace(): string {
  const path = mkdtempSync(join(tmpdir(), "factory-verify-"));
  workspaces.push(path);
  return path;
}

afterEach(() => {
  for (const path of workspaces.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("verificationCommandsForWorkspace", () => {
  it("uses Python verification for IPlay-shaped repositories", () => {
    const path = workspace();
    writeFileSync(join(path, "requirements.txt"), "numpy>=1.26\n");
    writeFileSync(join(path, "iplay.pyw"), "print('ok')\n");
    writeFileSync(join(path, "test_sync.py"), "def test_ok(): assert True\n");

    expect(verificationCommandsForWorkspace(path)).toEqual([
      {
        bin: "python",
        args: [
          "-m",
          "pip",
          "install",
          "--disable-pip-version-check",
          "-r",
          "requirements.txt",
        ],
        isTest: false,
      },
      {
        bin: "python",
        args: ["-m", "compileall", "-q", "."],
        isTest: false,
      },
      { bin: "python", args: ["-m", "pytest", "-q"], isTest: true },
    ]);
  });

  it("replays explicit script-style Python tests from GitHub Actions", () => {
    const path = workspace();
    mkdirSync(join(path, ".github", "workflows"), { recursive: true });
    mkdirSync(join(path, "iplay"), { recursive: true });
    writeFileSync(join(path, "requirements.txt"), "numpy>=1.26\n");
    writeFileSync(join(path, "test_root.py"), "print('root ok')\n");
    writeFileSync(join(path, "iplay", "test_suite.py"), "print('suite ok')\n");
    writeFileSync(join(path, "iplay", "test_camera.py"), "raise SystemExit(1)\n");
    writeFileSync(
      join(path, ".github", "workflows", "test.yml"),
      [
        "steps:",
        "  - run: |",
        "      python3.11 test_root.py",
        "      python iplay/test_suite.py",
        "      python3.11 test_root.py",
      ].join("\n"),
    );

    const commands = verificationCommandsForWorkspace(path);
    expect(commands.filter((command) => command.isTest)).toEqual([
      { bin: "python", args: ["test_root.py"], isTest: true },
      { bin: "python", args: ["iplay/test_suite.py"], isTest: true },
    ]);
    expect(commands).not.toContainEqual({
      bin: "python",
      args: ["-m", "pytest", "-q"],
      isTest: true,
    });
  });

  it("keeps JavaScript verification and supports polyglot repositories", () => {
    const path = workspace();
    writeFileSync(join(path, "package.json"), "{}\n");
    writeFileSync(join(path, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    writeFileSync(join(path, "pyproject.toml"), "[project]\nname='mixed'\n");

    const commands = verificationCommandsForWorkspace(path);
    expect(commands.map((command) => command.bin)).toEqual([
      "pnpm",
      "pnpm",
      "python",
      "python",
    ]);
    expect(commands.filter((command) => command.isTest)).toHaveLength(2);
  });

  it("returns no commands for an unknown stack", () => {
    const path = workspace();
    writeFileSync(join(path, "README.md"), "# notes\n");
    expect(verificationCommandsForWorkspace(path)).toEqual([]);
  });
});

describe("Python command sandbox", () => {
  it("allows only the fixed verification entrypoints", () => {
    expect(isAllowed("python", ["-m", "compileall", "-q", "."])).toBe(true);
    expect(isAllowed("python", ["-m", "pytest", "-q"])).toBe(true);
    expect(isAllowed("python3", ["-m", "unittest", "discover"])).toBe(true);
    expect(
      isAllowed("python", [
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        "-r",
        "requirements.txt",
      ]),
    ).toBe(true);

    expect(isAllowed("python", ["test_sync.py"])).toBe(true);
    expect(isAllowed("python", ["iplay/test_scenes.py"])).toBe(true);
    expect(isAllowed("python", ["../test_escape.py"])).toBe(false);
    expect(isAllowed("python", ["malicious.py"])).toBe(false);
    expect(isAllowed("python", ["-m", "http.server"])).toBe(false);
    expect(isAllowed("python", ["-m", "pip", "install", "attacker-package"])).toBe(
      false,
    );
  });
});
