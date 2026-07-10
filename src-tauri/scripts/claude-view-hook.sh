#!/bin/sh
# claude-view hook bridge.
# Claude Code pipes the hook event JSON to stdin; sessions launched by
# claude-view carry CLAUDE_VIEW_ID/PORT in their environment.
# Outside a claude-view session these are unset and this is a no-op, so normal
# claude sessions are unaffected.
[ -n "$CLAUDE_VIEW_ID" ] || exit 0
[ -n "$CLAUDE_VIEW_PORT" ] || exit 0

# The auth token is NOT in the environment (it would leak to every child
# process). Read it from the 0600 discovery file the app writes on startup.
INSTANCE="$HOME/.claude/claude-view/instance.json"
[ -f "$INSTANCE" ] || exit 0

# Only trust the token if the discovery file belongs to the app that owns this
# session (same port). No jq dependency — extract with sed.
IPORT=$(sed -n 's/.*"port":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$INSTANCE")
[ "$IPORT" = "$CLAUDE_VIEW_PORT" ] || exit 0
TOKEN=$(sed -n 's/.*"token":[[:space:]]*"\([^"]*\)".*/\1/p' "$INSTANCE")
[ -n "$TOKEN" ] || exit 0

payload=$(cat)

# Pipe the payload via stdin (--data-binary @-), NOT as a CLI argument, so a
# large tool output can't hit ARG_MAX and get silently dropped. Fire-and-forget
# with a hard timeout: never block Claude Code.
printf '%s' "$payload" | curl -s -m 2 -X POST "http://127.0.0.1:${CLAUDE_VIEW_PORT}/hooks" \
  -H "Content-Type: application/json" \
  -H "X-Claude-View-Id: ${CLAUDE_VIEW_ID}" \
  -H "X-Claude-View-Token: ${TOKEN}" \
  --data-binary @- >/dev/null 2>&1 &

exit 0
