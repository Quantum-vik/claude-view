#!/bin/sh
# demo-timeline.sh — fire a realistic sequence of fake Claude Code hook events
# at a live claude-view session so the timeline sidebar fills in.
#
# Usage:
#   1. Launch the app normally and open any session (New Session / Open / View).
#   2. Run:  ./scripts/demo-timeline.sh
#
# The running app is auto-discovered via ~/.claude/claude-view/instance.json
# (written by the app on startup). Optional overrides:
#   ./scripts/demo-timeline.sh [port] [viewer_id]     with CLAUDE_VIEW_TOKEN set

set -eu

TOKEN="${CLAUDE_VIEW_TOKEN:-demo}"
PORT="${1:-}"
INSTANCE="$HOME/.claude/claude-view/instance.json"

# Preferred path: the app publishes its port+token on startup.
if [ -z "$PORT" ] && [ -f "$INSTANCE" ]; then
  IPORT=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["port"])' "$INSTANCE" 2>/dev/null || echo "")
  ITOKEN=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["token"])' "$INSTANCE" 2>/dev/null || echo "")
  if [ -n "$IPORT" ] && [ -n "$ITOKEN" ] && \
     curl -sf -o /dev/null "http://127.0.0.1:$IPORT/sessions" -H "X-Claude-View-Token: $ITOKEN"; then
    PORT="$IPORT"
    TOKEN="$ITOKEN"
    echo "discovered running app via instance.json"
  fi
fi

if [ -z "$PORT" ]; then
  # Several instances may be running (tauri dev + a test binary); pick the
  # one that accepts our token.
  for p in $(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk '$1 ~ /^claude-v/ { sub(".*:", "", $9); print $9 }' | sort -u); do
    if curl -sf -o /dev/null "http://127.0.0.1:$p/sessions" -H "X-Claude-View-Token: $TOKEN"; then
      PORT="$p"
      break
    fi
  done
fi
if [ -z "$PORT" ]; then
  echo "error: could not find a running claude-view instance." >&2
  echo "start the app first (it writes ~/.claude/claude-view/instance.json on launch —" >&2
  echo "if that file is missing, the app predates it: rebuild and restart)." >&2
  exit 1
fi

BASE="http://127.0.0.1:$PORT"
echo "app found on port $PORT"

VID="${2:-}"
if [ -z "$VID" ]; then
  VID=$(curl -sf "$BASE/sessions" -H "X-Claude-View-Token: $TOKEN" | python3 -c '
import json, sys
live = [s for s in json.load(sys.stdin) if not s["ended"]]
print(live[0]["viewer_id"] if live else "")
')
fi
if [ -z "$VID" ]; then
  echo "error: no live session in the viewer — open one first (New Session)" >&2
  exit 1
fi
echo "targeting session $VID"
echo "watch its timeline sidebar now..."

hook() {
  curl -sf -o /dev/null -X POST "$BASE/hooks" \
    -H "Content-Type: application/json" \
    -H "X-Claude-View-Id: $VID" \
    -H "X-Claude-View-Token: $TOKEN" \
    --data-binary "$1"
}

pre() { # id tool command
  hook "{\"hook_event_name\":\"PreToolUse\",\"tool_name\":\"$2\",\"tool_use_id\":\"demo-$1\",\"tool_input\":{\"command\":$3}}"
}
post_ok() { # id tool command
  hook "{\"hook_event_name\":\"PostToolUse\",\"tool_name\":\"$2\",\"tool_use_id\":\"demo-$1\",\"tool_input\":{\"command\":$3},\"tool_response\":{\"output\":\"ok\"}}"
}
post_err() { # id tool command
  hook "{\"hook_event_name\":\"PostToolUse\",\"tool_name\":\"$2\",\"tool_use_id\":\"demo-$1\",\"tool_input\":{\"command\":$3},\"tool_response\":{\"is_error\":true,\"output\":\"failed\"}}"
}

step() { # human label
  echo "  ▶ $1"
}

step "Bash: npm install (running ~2.5s -> success)"
pre 1 Bash '"npm install"'
sleep 2.5
post_ok 1 Bash '"npm install"'

step "Read: src/App.tsx (fast success)"
hook '{"hook_event_name":"PreToolUse","tool_name":"Read","tool_use_id":"demo-2","tool_input":{"file_path":"src/App.tsx"}}'
sleep 0.4
hook '{"hook_event_name":"PostToolUse","tool_name":"Read","tool_use_id":"demo-2","tool_input":{"file_path":"src/App.tsx"},"tool_response":{"output":"..."}}'

step "Bash: npm test (running ~3s -> ERROR)"
pre 3 Bash '"npm test"'
sleep 3
post_err 3 Bash '"npm test"'

step "Edit: src/api/client.ts (success)"
hook '{"hook_event_name":"PreToolUse","tool_name":"Edit","tool_use_id":"demo-4","tool_input":{"file_path":"src/api/client.ts"}}'
sleep 0.7
hook '{"hook_event_name":"PostToolUse","tool_name":"Edit","tool_use_id":"demo-4","tool_input":{"file_path":"src/api/client.ts"},"tool_response":{"output":"ok"}}'

step "Bash: npm test again (running ~2.5s -> success)"
pre 5 Bash '"npm test"'
sleep 2.5
post_ok 5 Bash '"npm test"'

step "Bash: git commit (success)"
pre 6 Bash '"git commit -m \"fix: handle null token\""'
sleep 0.6
post_ok 6 Bash '"git commit -m \"fix: handle null token\""'

step "WebSearch: axum websocket backpressure (~1.5s success)"
hook '{"hook_event_name":"PreToolUse","tool_name":"WebSearch","tool_use_id":"demo-7","tool_input":{"query":"axum websocket backpressure"}}'
sleep 1.5
hook '{"hook_event_name":"PostToolUse","tool_name":"WebSearch","tool_use_id":"demo-7","tool_input":{"query":"axum websocket backpressure"},"tool_response":{"output":"5 results"}}'

echo "done — 7 cards: 6 green, 1 red (npm test), durations attached."
