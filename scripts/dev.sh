#!/bin/sh
# dev.sh — live-reload development instance of claude-view.
#
#   bash scripts/dev.sh     (or: npm run tauri dev)
#
# UI edits under src/ hot-reload into the running window INSTANTLY (no
# rebuild, no reinstall, sessions keep running). Rust edits under src-tauri/
# recompile and relaunch the dev instance automatically.
#
# This is a separate process from the installed /Applications app — run both
# side by side: iterate here, keep real work in the installed app, and ship
# with scripts/reinstall.sh (which by default swaps the bundle IN PLACE
# without touching the running app — the update applies the next time you
# quit and reopen it).
set -eu
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:/usr/local/bin:$PATH"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
exec npm run tauri dev
