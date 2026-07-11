#!/bin/sh
# reinstall.sh — one command to rebuild claude-view and install it to
# /Applications as a standalone, double-clickable app. No dev server needed.
#
# Usage:  npm run reinstall      (or:  bash scripts/reinstall.sh)
set -eu

# Ensure the toolchain is reachable even from a minimal (non-login) shell:
# Homebrew node/npm and the Rust cargo dir aren't always on PATH otherwise.
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:/usr/local/bin:$PATH"

# Resolve the project root (this script lives in <root>/scripts).
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

APP_NAME="claude-view.app"
BUNDLE="$ROOT/src-tauri/target/release/bundle/macos/$APP_NAME"
DEST="/Applications/$APP_NAME"

echo "==> Building release app bundle (Rust release + LTO — a couple of minutes)..."
# Build ONLY the .app (skip the .dmg — its Finder-based styling step is flaky
# and unnecessary for a local install). Run `npm run tauri build` yourself if
# you want the distributable .dmg.
npm run tauri build -- --bundles app

if [ ! -d "$BUNDLE" ]; then
  echo "error: expected bundle not found at $BUNDLE" >&2
  exit 1
fi

# By DEFAULT, do NOT quit the running app — replacing the bundle in place is
# safe (macOS keeps the running binary alive), and the new code applies the next
# time you quit and reopen it. This means reinstalling never kills the sessions
# you have open. Pass --restart to quit + relaunch immediately (old behavior).
RESTART=0
case "${1:-}" in
  --restart) RESTART=1;;
esac

if [ "$RESTART" = "1" ]; then
  echo "==> Quitting running instance (‑‑restart)..."
  pkill -f "$APP_NAME/Contents/MacOS/claude-view" 2>/dev/null || true
  sleep 1
fi

echo "==> Installing to $DEST..."
rm -rf "$DEST"
cp -R "$BUNDLE" "$DEST"
# Locally-built apps aren't quarantined, but strip it defensively so Gatekeeper
# never blocks the launch.
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

VERSION=$(node -p "require('$ROOT/package.json').version" 2>/dev/null || echo "?")
echo "==> Installed claude-view v$VERSION to /Applications."

if [ "$RESTART" = "1" ]; then
  echo "==> Launching..."
  open "$DEST"
else
  echo "   The running app is untouched. Quit and reopen claude-view to apply this build."
  echo "   (Run with --restart to quit + relaunch now.)"
fi
