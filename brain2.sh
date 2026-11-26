#!/usr/bin/env bash
# Launch the latest version of BRAIN2 from this checkout.
#
#   ./brain2.sh            run in the foreground (logs in this terminal)
#   ./brain2.sh --detach   start in the background and return (used by BRAIN2.command)
#
# Before launching it (re)installs dependencies when they are missing or their
# manifests changed, and rebuilds the UI when any UI source is newer than the build.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$ROOT/backend"
APP="$ROOT/app"
# Finder-launched scripts may not have Homebrew on PATH.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"

say() { printf '\033[1;34m[brain2]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[brain2]\033[0m %s\n' "$*" >&2; exit 1; }

# newer_than TARGET PATH... : true if TARGET is missing or any PATH contains a newer file
newer_than() {
  local target="$1"; shift
  [ -e "$target" ] || return 0
  [ -n "$(find "$@" -newer "$target" -type f -not -name '.DS_Store' -print -quit 2>/dev/null)" ]
}

command -v node >/dev/null || fail "Node.js is required (https://nodejs.org)."
command -v python3 >/dev/null || command -v uv >/dev/null || fail "Python 3.11+ is required."

# ---------------------------------------------------------------- backend deps
VENV_MARK="$BACKEND/.venv/.brain2-installed"
if newer_than "$VENV_MARK" "$BACKEND/pyproject.toml"; then
  say "Installing backend dependencies…"
  if command -v uv >/dev/null; then
    (cd "$BACKEND" && uv venv -q --allow-existing .venv && uv pip install -q --python .venv -e '.[dev]')
  else
    (cd "$BACKEND" && python3 -m venv .venv && .venv/bin/pip install -q -e '.[dev]')
  fi
  touch "$VENV_MARK"
fi

# ---------------------------------------------------------------- app deps
NODE_MARK="$APP/node_modules/.package-lock.json"
if newer_than "$NODE_MARK" "$APP/package.json" "$APP/package-lock.json"; then
  say "Installing app dependencies…"
  (cd "$APP" && npm install --no-audit --no-fund --silent)
  touch "$NODE_MARK"
fi

# ---------------------------------------------------------------- UI build
if newer_than "$APP/dist/index.html" "$APP/src" "$APP/index.html" "$APP/vite.config.ts" \
    "$APP/tsconfig.json" "$APP/package.json"; then
  say "Building the UI…"
  BUILD_LOG="$(mktemp)"
  if ! (cd "$APP" && npm run build --silent) >"$BUILD_LOG" 2>&1; then
    cat "$BUILD_LOG"; rm -f "$BUILD_LOG"; fail "UI build failed (see errors above)."
  fi
  rm -f "$BUILD_LOG"
fi

# ---------------------------------------------------------------- macOS launcher with the icon
if [ "$(uname)" = "Darwin" ] && newer_than "$ROOT/BRAIN2.app/Contents/Info.plist" "$ROOT/res/brain2-icon.icns" "$ROOT/scripts/make-launcher.sh"; then
  "$ROOT/scripts/make-launcher.sh" >/dev/null && say "Created BRAIN2.app (drag it to the Dock to launch BRAIN2 with its icon)."
fi

# ---------------------------------------------------------------- launch
cd "$APP"
if [ "${1:-}" = "--detach" ]; then
  LOG="${TMPDIR:-/tmp}/brain2.log"
  nohup npx electron . >"$LOG" 2>&1 &
  say "BRAIN2 started (log: $LOG)."
else
  say "Starting BRAIN2…"
  exec npx electron .
fi
