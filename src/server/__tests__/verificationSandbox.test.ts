import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildVerificationSandboxPlan,
  verificationNetwork,
  verificationSandboxConfig,
} from "../workspace/verificationSandbox.js";

const workspaceRoot = resolve(join(tmpdir(), "factory-sandbox-workspaces"));
const workspace = join(workspaceRoot, "generated-app");
const stateRoot = resolve(join(tmpdir(), "factory-sandbox-state"));
const image = "local-ai-factory-verifier:deadbeef";

describe("generated-code verification sandbox", () => {
  it("requires a complete, valid opt-in configuration", () => {
    expect(verificationSandboxConfig({})).toBeNull();
    expect(
      verificationSandboxConfig({
        FACTORY_VERIFICATION_SANDBOX_IMAGE: image,
        FACTORY_VERIFICATION_SANDBOX_STATE_ROOT: stateRoot,
        OPENAI_API_KEY: "must-not-be-consumed",
      }),
    ).toEqual({ image, stateRoot });
    expect(() =>
      verificationSandboxConfig({
        FACTORY_VERIFICATION_SANDBOX_IMAGE: image,
      }),
    ).toThrow(/requires both/i);
    expect(() =>
      verificationSandboxConfig({
        FACTORY_VERIFICATION_SANDBOX_IMAGE: "--privileged",
        FACTORY_VERIFICATION_SANDBOX_STATE_ROOT: stateRoot,
      }),
    ).toThrow(/invalid reference/i);
  });

  it("builds a least-privilege Docker contract with only two writable mounts", () => {
    const plan = buildVerificationSandboxPlan({
      workspaceRoot,
      cwd: workspace,
      stateRoot,
      image,
      bin: "pnpm",
      args: ["test"],
      containerName: "factory-verification-contract",
      uid: 1001,
      gid: 1001,
    });

    expect(plan.network).toBe("none");
    expect(plan.dockerArgs).toContain("--read-only");
    expect(plan.dockerArgs).toContain("--init");
    expect(plan.dockerArgs).not.toContain("--privileged");
    expect(plan.dockerArgs).not.toContain("/var/run/docker.sock");
    expect(plan.dockerArgs).toEqual(
      expect.arrayContaining([
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--network",
        "none",
        "--user",
        "1001:1001",
        "--workdir",
        "/workspace",
      ]),
    );

    const mounts = plan.dockerArgs
      .map((value, index) =>
        plan.dockerArgs[index - 1] === "--mount" ? value : null,
      )
      .filter((value): value is string => value !== null);
    expect(mounts).toEqual([
      `type=bind,src=${workspace},dst=/workspace,rw`,
      `type=bind,src=${stateRoot},dst=/sandbox-state,rw`,
    ]);

    const imageIndex = plan.dockerArgs.indexOf(image);
    expect(plan.dockerArgs.slice(imageIndex)).toEqual([image, "pnpm", "test"]);
    const serialized = JSON.stringify(plan.dockerArgs);
    expect(serialized).not.toMatch(
      /OPENAI|ANTHROPIC|GITHUB_TOKEN|DOCKER_HOST/i,
    );
    expect(plan.dockerArgs).toContain(
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    );
    expect(serialized).not.toMatch(
      /PATH=[^"]*sandbox-state\/(?:pnpm|home\/\.local\/bin)/,
    );
  });

  it("permits network only for dependency bootstrap commands", () => {
    expect(verificationNetwork("pnpm", ["install"])).toBe("bridge");
    expect(
      verificationNetwork("python3", [
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        "-r",
        "requirements.txt",
      ]),
    ).toBe("bridge");
    expect(
      verificationNetwork("npx", ["--no-install", "prisma", "generate"]),
    ).toBe("bridge");
    expect(
      verificationNetwork("npx", [
        "--no-install",
        "playwright",
        "install",
        "chromium",
      ]),
    ).toBe("bridge");
    expect(verificationNetwork("pnpm", ["test"])).toBe("none");
    expect(verificationNetwork("npx", ["--no-install", "vitest", "run"])).toBe(
      "none",
    );
  });

  it("rejects a state mount that overlaps generated workspaces", () => {
    expect(() =>
      buildVerificationSandboxPlan({
        workspaceRoot,
        cwd: workspace,
        stateRoot: join(workspaceRoot, "state"),
        image,
        bin: "pnpm",
        args: ["test"],
      }),
    ).toThrow(/must not overlap/i);
  });
});
