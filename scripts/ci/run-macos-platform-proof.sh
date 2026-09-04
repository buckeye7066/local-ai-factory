#!/usr/bin/env bash
set -euo pipefail

workspace_root="${1:?workspace root is required}"
proof_user="factoryproof"
proof_root="/Users/Shared/factory-proof-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
sandbox_root="${proof_root}/workspaces"
state_root="${proof_root}/state"
runner_gid="$(id -g)"
proof_uid="$(dscl . -list /Users UniqueID | awk 'BEGIN { max = 600 } $2 > max && $2 < 65000 { max = $2 } END { print max + 1 }')"

cleanup() {
  sudo pkill -KILL -u "${proof_user}" 2>/dev/null || true
  sudo dscl . -delete "/Users/${proof_user}" 2>/dev/null || true
  sudo rm -rf "${proof_root}" 2>/dev/null || true
}
trap cleanup EXIT

if dscl . -read "/Users/${proof_user}" >/dev/null 2>&1; then
  echo "Restricted proof account already exists unexpectedly." >&2
  exit 1
fi

sudo dscl . -create "/Users/${proof_user}"
sudo dscl . -create "/Users/${proof_user}" RealName "Factory Proof"
sudo dscl . -create "/Users/${proof_user}" UniqueID "${proof_uid}"
sudo dscl . -create "/Users/${proof_user}" PrimaryGroupID "${runner_gid}"
sudo dscl . -create "/Users/${proof_user}" NFSHomeDirectory "${state_root}/home"
sudo dscl . -create "/Users/${proof_user}" UserShell /usr/bin/false
sudo dscl . -passwd "/Users/${proof_user}" "$(uuidgen | tr -d '-')aA1!"

sudo mkdir -p "${sandbox_root}" \
  "${state_root}/home" \
  "${state_root}/tmp" \
  "${state_root}/appdata" \
  "${state_root}/localappdata" \
  "${state_root}/cache" \
  "${state_root}/config" \
  "${state_root}/data" \
  "${state_root}/corepack" \
  "${state_root}/pnpm" \
  "${state_root}/npm" \
  "${state_root}/yarn" \
  "${state_root}/pip" \
  "${state_root}/playwright"
sudo chown -R "$(id -un):${runner_gid}" "${proof_root}"
sudo chmod 0750 "${proof_root}"
sudo chmod -R 0770 "${sandbox_root}" "${state_root}"

# The proof account shares only the runner's group so disposable copies can be
# group-writable. Remove group/other write access from trusted runner state.
sudo chmod -R go-w "${HOME}" "${GITHUB_WORKSPACE}" "${RUNNER_TEMP}"
if [[ -n "${PNPM_HOME:-}" ]]; then
  chmod go+x "${HOME}"
  chmod -R go+rX "${PNPM_HOME}"
fi
chmod -R go-rwx .factory
for archive in ./*-workspaces.tar; do
  [[ -e "${archive}" ]] || continue
  chmod go-rwx "${archive}"
done

export WORKSPACE_ROOT="${workspace_root}"
export FACTORY_PLATFORM_SANDBOX_ROOT="${sandbox_root}"
export FACTORY_PLATFORM_PROOF_USER="${proof_user}"
export FACTORY_PLATFORM_PROOF_STATE_ROOT="${state_root}"
export ALLOW_UNTRUSTED_SCRIPTS="true"
export CI="true"

pnpm exec tsx src/cli/factory-platform-proof.ts record
