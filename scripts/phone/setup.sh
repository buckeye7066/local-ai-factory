#!/data/data/com.termux/files/usr/bin/bash
# ---------------------------------------------------------------------------
# setup.sh — make Factory Deck runnable ON AN ANDROID PHONE, with no laptop.
#
# WHY THIS SHAPE, AND NOT AN APK
# ------------------------------
# Factory Deck is an Express server whose whole job is to drive real tooling:
# it spawns `git`, `gh`, and a package manager, and it runs the generated
# project's own test suite before it will call a run finished. An APK-embedded
# JavaScript runtime (nodejs-mobile) would give us `node` and nothing else —
# generation would appear to work while verification and delivery silently
# could not run. That is the exact failure mode this repo's own rules forbid.
#
# Termux is a real Linux userland on the phone, so the program runs UNCHANGED:
# same server, same allowlist, same git delivery path. Nothing is stubbed.
#
# PREREQUISITE THE PHONE MUST ALREADY HAVE
# ----------------------------------------
#   Termux (from F-Droid or GitHub — the Play Store build is abandoned and
#   cannot install packages).
#
# USAGE (inside Termux on the phone):
#   bash setup.sh                 # full setup, prompts for a GitHub token
#   GH_TOKEN=ghp_xxx bash setup.sh
# ---------------------------------------------------------------------------
set -euo pipefail

REPO_URL="${FACTORY_REPO_URL:-https://github.com/buckeye7066/local-ai-factory.git}"
ROOT="${PHONE_CONSOLE_ROOT:-$HOME/phone-console}"
APP_DIR="$ROOT/local-ai-factory"

say()  { printf '\n\033[36m==> %s\033[0m\n' "$*"; }
die()  { printf '\n\033[31mFAIL: %s\033[0m\n' "$*" >&2; exit 1; }

# --- 0. refuse to pretend we are on a phone when we are not ---------------
[ -d /data/data/com.termux/files/usr ] || \
  die "this script is for Termux on Android. On a desktop use scripts/start-factory.ps1."

# --- 1. packages ----------------------------------------------------------
say "installing packages (python is not needed here; node/git/gh are)"
pkg update -y
# nodejs-lts: engines requires >=20. git+gh: the orchestrator shells out to
# both to deliver a finished run. openssh: ssh-keygen, and optional sshd for
# debugging the phone from the desk WITHOUT the phone depending on the desk.
pkg install -y nodejs-lts git gh openssh which

command -v node >/dev/null || die "node did not install"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "node $NODE_MAJOR is too old; Factory Deck needs >= 20"
say "node $(node -v), git $(git --version | awk '{print $3}')"

if ! command -v pnpm >/dev/null; then
  say "installing pnpm"
  npm install -g pnpm
fi

# --- 2. GitHub auth -------------------------------------------------------
# Both repos are PRIVATE, so an unauthenticated clone fails with a confusing
# 404. Authenticate first and say so plainly if it did not take.
if ! gh auth status >/dev/null 2>&1; then
  say "GitHub login required (repo is private)"
  if [ -n "${GH_TOKEN:-}" ]; then
    printf '%s' "$GH_TOKEN" | gh auth login --with-token
  else
    echo "Paste a GitHub token with 'repo' scope, then press Enter:"
    read -r _tok
    [ -n "$_tok" ] || die "no token given; cannot clone a private repo"
    printf '%s' "$_tok" | gh auth login --with-token
  fi
  gh auth status >/dev/null 2>&1 || die "gh auth did not take"
fi
gh auth setup-git

# --- 3. source ------------------------------------------------------------
mkdir -p "$ROOT"
if [ -d "$APP_DIR/.git" ]; then
  say "updating existing checkout at $APP_DIR"
  git -C "$APP_DIR" fetch --prune origin
  git -C "$APP_DIR" checkout main
  git -C "$APP_DIR" pull --ff-only origin main
else
  say "cloning $REPO_URL"
  git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"

# --- 4. dependencies ------------------------------------------------------
# Runtime deps are pure JavaScript (express/zod/dotenv/openai/@anthropic-ai).
# The dev deps that DO carry native binaries (esbuild, rollup) publish
# android-arm64 builds, which is why the UI can be bundled on the phone.
say "installing dependencies (this is the slow step; several minutes)"
pnpm install --prod=false

# --- 5. UI bundle ---------------------------------------------------------
# dist/ is gitignored, so a fresh clone has no UI. Build it here. If the
# bundler cannot run on this device we FAIL LOUDLY rather than serve an API
# with no console attached and let the phone look broken for no stated reason.
if [ -n "${FACTORY_UI_TARBALL:-}" ]; then
  say "installing prebuilt UI from $FACTORY_UI_TARBALL"
  mkdir -p dist
  tar -xzf "$FACTORY_UI_TARBALL" -C dist
else
  say "building the UI bundle"
  pnpm exec vite build || die "vite build failed on this device.
Recover by building dist/ui on the PC and copying it over, then re-run with:
  FACTORY_UI_TARBALL=/sdcard/Download/factory-ui.tgz bash setup.sh"
fi
[ -f dist/ui/index.html ] || die "no dist/ui/index.html after build — refusing to claim success"

# --- 6. configuration -----------------------------------------------------
if [ ! -f .env ]; then
  say "writing .env from the phone template — EDIT IT AND ADD YOUR API KEY"
  cp scripts/phone/phone.env.example .env
  echo "  -> $APP_DIR/.env"
fi

# --- 7. supervisor on PATH ------------------------------------------------
# chmod is not belt-and-braces, it is the fix for a defect this hit on a real
# phone: these files were committed 100644, so the symlink resolved to a
# non-executable target and `factory-engine start` died with "Permission
# denied" -- which reads like an Android sandbox problem, not a mode bit. The
# blobs are 100755 now; this keeps it working if anyone's umask, filesystem or
# zip-based copy loses the bit again.
mkdir -p "$HOME/.local/bin"
chmod +x "$APP_DIR/scripts/phone/engine.sh" "$APP_DIR/scripts/phone/setup.sh"
ln -sf "$APP_DIR/scripts/phone/engine.sh" "$HOME/.local/bin/factory-engine"
case ":$PATH:" in
  *":$HOME/.local/bin:"*) : ;;
  *) echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc" ;;
esac

# --- 8. start at boot -----------------------------------------------------
# Termux:Boot (separate F-Droid app) runs ~/.termux/boot/* at device boot.
# Without it the phone is only independent until it reboots.
mkdir -p "$HOME/.termux/boot"
cat > "$HOME/.termux/boot/20-factory-deck.sh" <<'BOOT'
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
exec "$HOME/.local/bin/factory-engine" start
BOOT
chmod +x "$HOME/.termux/boot/20-factory-deck.sh"

say "setup complete"
cat <<EOF

  Next:
    1. Put your API key in   $APP_DIR/.env
    2. Start it:             factory-engine start
    3. Check it:             factory-engine status
    4. Open the Factory Deck app on this phone (it points at 127.0.0.1:5179).

  Install Termux:Boot from F-Droid so step 2 survives a reboot.
EOF
