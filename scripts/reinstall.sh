#!/bin/sh
# reinstall.sh — one command to rebuild claude-view and install it to
# /Applications as a standalone, double-clickable app. No dev server needed.
#
# Usage:  npm run reinstall      (or:  bash scripts/reinstall.sh)
set -eu

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

echo "==> Quitting any running instance..."
pkill -f "$APP_NAME/Contents/MacOS/claude-view" 2>/dev/null || true
sleep 1

echo "==> Installing to $DEST..."
rm -rf "$DEST"
cp -R "$BUNDLE" "$DEST"
# Locally-built apps aren't quarantined, but strip it defensively so Gatekeeper
# never blocks the launch.
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

VERSION=$(node -p "require('$ROOT/package.json').version" 2>/dev/null || echo "?")
echo "==> Installed claude-view v$VERSION to /Applications."

# Relaunch unless called with --no-open
case "${1:-}" in
  --no-open) echo "   (skipping launch)";;
  *) echo "==> Launching..."; open "$DEST";;
esac
