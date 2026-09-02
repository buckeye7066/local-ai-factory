import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  generatedTestsForVerification,
  verificationCommandsForWorkspace,
  verificationPlanForWorkspace,
} from "../workspace/verificationCommands.js";
import { isAllowed } from "../workspace/commandRunner.js";

const workspaces: string[] = [];

function workspace(): string {
  const path = mkdtempSync(join(tmpdir(), "factory-verify-"));
  workspaces.push(path);
  return path;
}

afterEach(() => {
  for (const path of workspaces.splice(0)) {
    rmSync(path, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
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
      { bin: "python", args: ["-m", "pytest", "-q"], isTest: true },
    ]);
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
      "pnpm",
      "python",
      "python",
    ]);
    expect(commands.filter((command) => command.isTest)).toHaveLength(2);
  });

  it("rebuilds native modules after npm/pnpm installs (the skipped-install-scripts class)", () => {
    // GrantFlow run d687f5fd (2026-08-15): npm 11.17's allow-scripts default
    // silently skipped better-sqlite3's install script, so `npm ci` exited 0
    // with NO compiled binding — 20 auth-test failures, a 1080s hang, three
    // paid repair loops patching innocent files, and a final review that
    // blamed the Node version. The rebuild step between install and test is
    // the fix; it must sit BEFORE the test command and never count as a test.
    const npmPath = workspace();
    writeFileSync(join(npmPath, "package.json"), "{}\n");
    writeFileSync(join(npmPath, "package-lock.json"), "{}\n");
    expect(verificationCommandsForWorkspace(npmPath)).toEqual([
      { bin: "npm", args: ["ci"], isTest: false },
      { bin: "npm", args: ["rebuild"], isTest: false },
      { bin: "npm", args: ["test"], isTest: true },
    ]);

    const pnpmPath = workspace();
    writeFileSync(join(pnpmPath, "package.json"), "{}\n");
    writeFileSync(join(pnpmPath, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    expect(verificationCommandsForWorkspace(pnpmPath)).toEqual([
      { bin: "pnpm", args: ["install"], isTest: false },
      { bin: "pnpm", args: ["rebuild"], isTest: false },
      { bin: "pnpm", args: ["test"], isTest: true },
    ]);
  });

  it("honors a declared pnpm manager when compatibility npm and pnpm locks coexist", () => {
    const path = workspace();
    writeFileSync(
      join(path, "package.json"),
      JSON.stringify({ packageManager: "pnpm@10.17.0" }),
    );
    writeFileSync(join(path, "package-lock.json"), "{}\n");
    writeFileSync(join(path, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

    expect(verificationCommandsForWorkspace(path)).toEqual([
      { bin: "pnpm", args: ["install"], isTest: false },
      { bin: "pnpm", args: ["rebuild"], isTest: false },
      { bin: "pnpm", args: ["test"], isTest: true },
    ]);
  });

  it("fails closed when conflicting locks have no declared package manager", () => {
    const path = workspace();
    writeFileSync(join(path, "package.json"), "{}\n");
    writeFileSync(join(path, "package-lock.json"), "{}\n");
    writeFileSync(join(path, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

    expect(verificationCommandsForWorkspace(path)).toEqual([]);
    const plan = verificationPlanForWorkspace(path);
    expect(plan.commands).toEqual([]);
    expect(plan.incomplete).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "package manager",
          reason: expect.stringMatching(/conflicting lockfiles/i),
        }),
      ]),
    );
  });

  it("returns no commands for an unknown stack", () => {
    const path = workspace();
    writeFileSync(join(path, "README.md"), "# notes\n");
    expect(verificationCommandsForWorkspace(path)).toEqual([]);
  });

  it("directly selects every generated Vitest file before the host suite", () => {
    const path = workspace();
    writeFileSync(
      join(path, "package.json"),
      JSON.stringify({
        scripts: {
          test: "vitest run",
          build: "vite build",
          typecheck: "tsc --noEmit",
        },
        devDependencies: { vitest: "3", vite: "6", typescript: "5" },
      }),
    );
    writeFileSync(join(path, "package-lock.json"), "{}\n");
    const plan = verificationPlanForWorkspace(path, {
      generatedTests: [
        {
          path: "src/App.test.tsx",
          contents:
            "import { test, expect } from 'vitest'; test('x',()=>expect(1).toBe(1));",
        },
      ],
    });
    expect(plan.incomplete).toEqual([]);
    const directIndex = plan.commands.findIndex(
      (command) => command.directTestPath === "src/App.test.tsx",
    );
    const hostIndex = plan.commands.findIndex(
      (command) => command.bin === "npm" && command.args[0] === "test",
    );
    expect(directIndex).toBeGreaterThan(-1);
    expect(directIndex).toBeLessThan(hostIndex);
    expect(plan.commands[directIndex]).toMatchObject({
      bin: "npx",
      args: ["--no-install", "vitest", "run", "src/App.test.tsx", "--reporter=json"],
      isTest: true,
      runner: "vitest",
    });
    expect(plan.commands.every((command) => isAllowed(command.bin, command.args))).toBe(
      true,
    );
  });

  it("directly proves tests authored by both Builder and Test Writer", () => {
    const path = workspace();
    writeFileSync(
      join(path, "package.json"),
      JSON.stringify({
        scripts: { test: "vitest run" },
        devDependencies: { vitest: "3" },
      }),
    );
    writeFileSync(join(path, "package-lock.json"), "{}\n");
    const generatedTests = generatedTestsForVerification([
      { path: "src/app.ts", contents: "export const app = true;" },
      {
        path: "test/taskline.test.ts",
        contents: "import { it } from 'vitest'; it('builder', () => {});",
      },
      {
        path: "./test/taskline.acceptance.test.ts",
        contents: "import { it } from 'vitest'; it('acceptance', () => {});",
      },
    ]);

    expect(generatedTests.map((file) => file.path)).toEqual([
      "test/taskline.test.ts",
      "test/taskline.acceptance.test.ts",
    ]);
    const plan = verificationPlanForWorkspace(path, { generatedTests });
    expect(
      plan.commands
        .filter((command) => command.directTestPath)
        .map((command) => command.directTestPath),
    ).toEqual(["test/taskline.test.ts", "test/taskline.acceptance.test.ts"]);
  });

  it("holds UI verification without a declared Playwright harness", () => {
    const path = workspace();
    writeFileSync(
      join(path, "package.json"),
      JSON.stringify({
        scripts: { test: "vitest run", build: "vite build" },
        devDependencies: { vitest: "3" },
      }),
    );
    writeFileSync(join(path, "package-lock.json"), "{}\n");
    const plan = verificationPlanForWorkspace(path, {
      generatedTests: [
        {
          path: "tests/profile.spec.ts",
          contents: "import { test, expect } from '@playwright/test';",
        },
      ],
      uiAcceptanceRequired: true,
    });
    expect(plan.commands.some((command) => command.isBrowser)).toBe(false);
    expect(plan.incomplete.map((item) => item.reason).join("\n")).toMatch(
      /Playwright|browser/i,
    );
  });

  it("does not trust a Playwright harness first observed after builder writes", () => {
    const path = workspace();
    writeFileSync(
      join(path, "package.json"),
      JSON.stringify({
        scripts: { test: "vitest run", build: "vite build" },
        devDependencies: { vitest: "3", "@playwright/test": "1" },
      }),
    );
    writeFileSync(join(path, "package-lock.json"), "{}\n");
    writeFileSync(join(path, "playwright.config.ts"), "export default {};\n");
    const plan = verificationPlanForWorkspace(path, {
      generatedTests: [
        {
          path: "tests/profile.spec.ts",
          contents: "import { test, expect } from '@playwright/test';",
        },
      ],
      uiAcceptanceRequired: true,
      trustedBrowserHarness: false,
    });
    expect(plan.commands.some((command) => command.isBrowser)).toBe(false);
    expect(plan.incomplete.map((item) => item.reason).join("\n")).toMatch(
      /trusted pre-build/i,
    );
  });

  it("plans a direct Playwright journey only with declared dependency and config", () => {
    const path = workspace();
    writeFileSync(
      join(path, "package.json"),
      JSON.stringify({
        scripts: { test: "vitest run", build: "vite build" },
        devDependencies: { vitest: "3", "@playwright/test": "1" },
      }),
    );
    writeFileSync(join(path, "package-lock.json"), "{}\n");
    writeFileSync(join(path, "playwright.config.ts"), "export default {};\n");
    const plan = verificationPlanForWorkspace(path, {
      generatedTests: [
        {
          path: "tests/profile.spec.ts",
          contents: "import { test, expect } from '@playwright/test';",
        },
      ],
      uiAcceptanceRequired: true,
    });
    expect(plan.incomplete).toEqual([]);
    const browserSetupIndex = plan.commands.findIndex(
      (command) =>
        command.bin === "npx" &&
        command.args.join(" ") === "--no-install playwright install chromium",
    );
    const browserTestIndex = plan.commands.findIndex((command) => command.isBrowser);
    expect(browserSetupIndex).toBeGreaterThan(-1);
    expect(browserSetupIndex).toBeLessThan(browserTestIndex);
    expect(plan.commands[browserTestIndex]).toMatchObject({
      args: [
        "--no-install",
        "playwright",
        "test",
        "tests/profile.spec.ts",
        "--reporter=json",
      ],
      directTestPath: "tests/profile.spec.ts",
    });
    expect(plan.commands.every((command) => isAllowed(command.bin, command.args))).toBe(
      true,
    );
  });
});

describe("Python command sandbox", () => {
  it("allows only the fixed verification entrypoints", () => {
    expect(isAllowed("python", ["-m", "compileall", "-q", "."])).toBe(true);
    expect(isAllowed("python", ["-m", "pytest", "-q"])).toBe(true);
    expect(
      isAllowed("python", ["-m", "pytest", "-vv", "tests/calculator_test.py"]),
    ).toBe(true);
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
  it("directly selects idiomatic *_test.py files with parseable verbose output", () => {
    const root = workspace();
    writeFileSync(join(root, "pyproject.toml"), "[tool.pytest.ini_options]\n");
    const plan = verificationPlanForWorkspace(root, {
      generatedTests: [
        {
          path: "tests/calculator_test.py",
          contents: "def test_add():\n    assert 1 + 2 == 3\n",
        },
      ],
    });
    expect(
      plan.commands.find((cmd) => cmd.directTestPath === "tests/calculator_test.py"),
    ).toMatchObject({
      bin: "python",
      args: ["-m", "pytest", "-vv", "tests/calculator_test.py"],
      runner: "pytest",
    });
    expect(plan.commands.every((command) => isAllowed(command.bin, command.args))).toBe(
      true,
    );
  });

  it("never lets a workflow smoke replace the full pytest suite", () => {
    const root = workspace();
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    writeFileSync(join(root, "pyproject.toml"), "[tool.pytest.ini_options]\n");
    writeFileSync(join(root, "test_host.py"), "def test_host(): assert True\n");
    writeFileSync(
      join(root, "test_generated.py"),
      "def test_generated(): assert True\n",
    );
    writeFileSync(
      join(root, ".github", "workflows", "factory.yml"),
      "steps:\n  - run: python test_generated.py\n",
    );
    const plan = verificationPlanForWorkspace(root, {
      generatedTests: [
        {
          path: "test_generated.py",
          contents: "def test_generated(): assert True\n",
        },
      ],
    });
    expect(
      plan.commands.some(
        (cmd) => cmd.bin === "python" && cmd.args.join(" ") === "-m pytest -q",
      ),
    ).toBe(true);
  });
});
