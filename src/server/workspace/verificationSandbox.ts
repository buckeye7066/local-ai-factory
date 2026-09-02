import { randomUUID } from "node:crypto";
import { resolve, relative, isAbsolute, sep } from "node:path";

export type VerificationSandboxConfig = {
  image: string;
  stateRoot: string;
};

export type VerificationSandboxPlan = {
  containerName: string;
  dockerArgs: string[];
  network: "bridge" | "none";
};

const SAFE_IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,254}$/;
const SAFE_CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;

function pathWithin(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  );
}

function validateMountPath(value: string, label: string): string {
  const absolute = resolve(value);
  if (/[,\u0000\r\n]/.test(absolute)) {
    throw new Error(
      `${label} contains a character Docker --mount cannot encode.`,
    );
  }
  if (resolve(absolute, "..") === absolute) {
    throw new Error(`${label} cannot be a filesystem root.`);
  }
  return absolute;
}

export function verificationSandboxConfig(
  env: NodeJS.ProcessEnv = process.env,
): VerificationSandboxConfig | null {
  const image = env.FACTORY_VERIFICATION_SANDBOX_IMAGE?.trim() ?? "";
  const stateRoot = env.FACTORY_VERIFICATION_SANDBOX_STATE_ROOT?.trim() ?? "";
  if (!image && !stateRoot) return null;
  if (!image || !stateRoot) {
    throw new Error(
      "Verification sandbox configuration requires both " +
        "FACTORY_VERIFICATION_SANDBOX_IMAGE and " +
        "FACTORY_VERIFICATION_SANDBOX_STATE_ROOT.",
    );
  }
  if (!SAFE_IMAGE.test(image)) {
    throw new Error("Verification sandbox image has an invalid reference.");
  }
  return { image, stateRoot };
}

export function verificationNetwork(
  bin: string,
  args: readonly string[],
): "bridge" | "none" {
  const first = args[0] ?? "";
  if (
    ["npm", "pnpm", "yarn"].includes(bin) &&
    ["install", "ci", "rebuild"].includes(first)
  ) {
    return "bridge";
  }
  if (
    (bin === "python" || bin === "python3") &&
    args[0] === "-m" &&
    args[1] === "pip" &&
    args[2] === "install"
  ) {
    return "bridge";
  }
  if (
    bin === "npx" &&
    args[0] === "--no-install" &&
    ((args[1] === "prisma" && args[2] === "generate") ||
      (args[1] === "playwright" &&
        args[2] === "install" &&
        args[3] === "chromium"))
  ) {
    return "bridge";
  }
  return "none";
}

export function buildVerificationSandboxPlan(input: {
  workspaceRoot: string;
  cwd: string;
  stateRoot: string;
  image: string;
  bin: string;
  args: readonly string[];
  containerName?: string;
  uid?: number;
  gid?: number;
}): VerificationSandboxPlan {
  if (!SAFE_IMAGE.test(input.image)) {
    throw new Error("Verification sandbox image has an invalid reference.");
  }
  const workspaceRoot = validateMountPath(
    input.workspaceRoot,
    "Workspace root",
  );
  const cwd = resolve(input.cwd);
  const stateRoot = validateMountPath(input.stateRoot, "Sandbox state root");
  if (!pathWithin(workspaceRoot, cwd)) {
    throw new Error("Verification cwd is outside the workspace root.");
  }
  if (
    pathWithin(workspaceRoot, stateRoot) ||
    pathWithin(stateRoot, workspaceRoot)
  ) {
    throw new Error(
      "Sandbox state and generated workspace mounts must not overlap.",
    );
  }

  const containerName =
    input.containerName ?? `factory-verification-${randomUUID()}`;
  if (!SAFE_CONTAINER_NAME.test(containerName)) {
    throw new Error("Verification sandbox container name is invalid.");
  }

  const uid = input.uid ?? 65532;
  const gid = input.gid ?? 65532;
  if (
    !Number.isSafeInteger(uid) ||
    uid < 0 ||
    !Number.isSafeInteger(gid) ||
    gid < 0
  ) {
    throw new Error(
      "Verification sandbox uid/gid must be non-negative integers.",
    );
  }

  const network = verificationNetwork(input.bin, input.args);
  const dockerArgs = [
    "run",
    "--rm",
    "--name",
    containerName,
    "--pull",
    "never",
    "--init",
    "--read-only",
    "--network",
    network,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--pids-limit",
    "1024",
    "--memory",
    "5g",
    "--memory-swap",
    "5g",
    "--cpus",
    "2",
    "--ulimit",
    "nofile=4096:4096",
    "--shm-size",
    "512m",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=1073741824",
    "--tmpfs",
    "/run:rw,nosuid,nodev,size=67108864",
    "--user",
    `${uid}:${gid}`,
    "--workdir",
    "/workspace",
    "--mount",
    `type=bind,src=${cwd},dst=/workspace,rw`,
    "--mount",
    `type=bind,src=${stateRoot},dst=/sandbox-state,rw`,
    "--env",
    "HOME=/sandbox-state/home",
    "--env",
    "XDG_CACHE_HOME=/sandbox-state/cache",
    "--env",
    "COREPACK_HOME=/sandbox-state/corepack",
    "--env",
    "PNPM_HOME=/sandbox-state/pnpm",
    "--env",
    "npm_config_cache=/sandbox-state/npm",
    "--env",
    "YARN_CACHE_FOLDER=/sandbox-state/yarn",
    "--env",
    "PIP_CACHE_DIR=/sandbox-state/pip",
    "--env",
    "PLAYWRIGHT_BROWSERS_PATH=/sandbox-state/playwright",
    "--env",
    "PIP_DISABLE_PIP_VERSION_CHECK=1",
    "--env",
    "PIP_NO_INPUT=1",
    "--env",
    "PIP_USER=1",
    "--env",
    "PIP_BREAK_SYSTEM_PACKAGES=1",
    "--env",
    "CI=true",
    "--env",
    "NO_COLOR=1",
    "--env",
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    input.image,
    input.bin,
    ...input.args,
  ];

  return { containerName, dockerArgs, network };
}
