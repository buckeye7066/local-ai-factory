import { randomUUID } from "node:crypto";
import { resolve, relative, isAbsolute, sep } from "node:path";

export type VerificationSandboxConfig = {
  image: string;
  stateRoot: string;
};

export type HostVerificationSandboxConfig = {
  user: string;
  stateRoot: string;
  windowsLauncher?: string;
  windowsPassword?: string;
};

export type VerificationSandboxPlan = {
  containerName: string;
  dockerArgs: string[];
  network: "bridge" | "none";
};

const SAFE_IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,254}$/;
const SAFE_CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const SAFE_HOST_USER = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const PRIVILEGED_HOST_USERS = new Set([
  "administrator",
  "nobody",
  "root",
  "runneradmin",
  "system",
]);

function pathWithin(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return (
    rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  );
}

function validateMountPath(value: string, label: string): string {
  if (!isAbsolute(value)) {
    throw new Error(`${label} must be absolute.`);
  }
  const absolute = resolve(value);
  if (/[,\u0000\r\n]/.test(absolute)) {
    throw new Error(`${label} contains a character Docker --mount cannot encode.`);
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

/**
 * Cross-platform proof commands run as a dedicated low-privilege OS account.
 * The trusted recorder keeps its checkpoint and transport archive under the
 * runner account, outside this account's writable workspace/state roots.
 */
export function hostVerificationSandboxConfig(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): HostVerificationSandboxConfig | null {
  const user = env.FACTORY_PLATFORM_PROOF_USER?.trim() ?? "";
  const stateRootValue = env.FACTORY_PLATFORM_PROOF_STATE_ROOT?.trim() ?? "";
  const windowsLauncherValue =
    env.FACTORY_PLATFORM_PROOF_WINDOWS_LAUNCHER?.trim() ?? "";
  const windowsPassword = env.FACTORY_PLATFORM_PROOF_WINDOWS_PASSWORD?.trim() ?? "";
  const anyConfigured = Boolean(
    user || stateRootValue || windowsLauncherValue || windowsPassword,
  );
  if (!anyConfigured) return null;
  if (platform !== "win32" && platform !== "darwin") {
    throw new Error(
      "The restricted host-user verification sandbox is supported only on Windows and macOS.",
    );
  }
  if (!user || !stateRootValue) {
    throw new Error(
      "Host verification sandbox configuration requires both " +
        "FACTORY_PLATFORM_PROOF_USER and FACTORY_PLATFORM_PROOF_STATE_ROOT.",
    );
  }
  if (
    !SAFE_HOST_USER.test(user) ||
    PRIVILEGED_HOST_USERS.has(user.toLowerCase()) ||
    [env.USER, env.USERNAME]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLowerCase() === user.toLowerCase())
  ) {
    throw new Error("Host verification sandbox user is invalid or privileged.");
  }
  const stateRoot = validateMountPath(
    stateRootValue,
    "Host verification sandbox state root",
  );
  if (platform === "win32") {
    if (!windowsLauncherValue || !windowsPassword) {
      throw new Error(
        "Windows host verification requires its trusted launcher and ephemeral account password.",
      );
    }
    const windowsLauncher = validateMountPath(
      windowsLauncherValue,
      "Windows host verification launcher",
    );
    return { user, stateRoot, windowsLauncher, windowsPassword };
  }
  if (windowsLauncherValue || windowsPassword) {
    throw new Error("Windows-only host verification settings cannot be used on macOS.");
  }
  return { user, stateRoot };
}

export function assertHostVerificationSandboxIsolation(
  config: HostVerificationSandboxConfig,
  workspaceRoot: string,
): void {
  const root = validateMountPath(workspaceRoot, "Workspace root");
  if (pathWithin(root, config.stateRoot) || pathWithin(config.stateRoot, root)) {
    throw new Error(
      "Host verification sandbox state and generated workspaces must not overlap.",
    );
  }
  if (config.windowsLauncher) {
    if (
      pathWithin(root, config.windowsLauncher) ||
      pathWithin(config.stateRoot, config.windowsLauncher)
    ) {
      throw new Error(
        "The trusted Windows proof launcher must be outside generated workspaces and writable sandbox state.",
      );
    }
  }
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
      (args[1] === "playwright" && args[2] === "install" && args[3] === "chromium"))
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
  const workspaceRoot = validateMountPath(input.workspaceRoot, "Workspace root");
  const cwd = resolve(input.cwd);
  const stateRoot = validateMountPath(input.stateRoot, "Sandbox state root");
  if (!pathWithin(workspaceRoot, cwd)) {
    throw new Error("Verification cwd is outside the workspace root.");
  }
  if (pathWithin(workspaceRoot, stateRoot) || pathWithin(stateRoot, workspaceRoot)) {
    throw new Error("Sandbox state and generated workspace mounts must not overlap.");
  }

  const containerName = input.containerName ?? `factory-verification-${randomUUID()}`;
  if (!SAFE_CONTAINER_NAME.test(containerName)) {
    throw new Error("Verification sandbox container name is invalid.");
  }

  const uid = input.uid ?? 65532;
  const gid = input.gid ?? 65532;
  if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0) {
    throw new Error("Verification sandbox uid/gid must be non-negative integers.");
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
    `type=bind,src=${cwd},dst=/workspace`,
    "--mount",
    `type=bind,src=${stateRoot},dst=/sandbox-state`,
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
