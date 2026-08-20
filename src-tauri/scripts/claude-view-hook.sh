#!/bin/sh
# claude-view hook bridge.
# Claude Code pipes the hook event JSON to stdin; sessions launched by
# claude-view carry CLAUDE_VIEW_ID/PORT in their environment.
# Outside a claude-view session these are unset and this is a no-op, so normal
# claude sessions are unaffected.
[ -n "$CLAUDE_VIEW_ID" ] || exit 0
[ -n "$CLAUDE_VIEW_PORT" ] || exit 0
# The port is injected by the app and is always an integer; refuse anything else
# rather than interpolate it into a path below.
case "$CLAUDE_VIEW_PORT" in *[!0-9]*) exit 0 ;; esac

# The auth token is NOT in the environment (it would leak to every child
# process). Read it from the 0600 discovery file the app writes on startup.
#
# Preferred: instances/<port>.json — the filename IS the port, so two running
# apps can never clobber each other's file and "does this file belong to the app
# that owns my session?" is answered by the path itself.
#
# Fallback: the legacy single instance.json, for an app older than the per-port
# layout. That one file is shared by every instance, so it has to be checked
# against this session's port explicitly.
#
# No jq dependency anywhere — values are extracted with sed.
DIR="$HOME/.claude/claude-view"
PER_PORT="$DIR/instances/${CLAUDE_VIEW_PORT}.json"
LEGACY="$DIR/instance.json"

if [ -f "$PER_PORT" ]; then
  INSTANCE="$PER_PORT"
elif [ -f "$LEGACY" ]; then
  INSTANCE="$LEGACY"
  IPORT=$(sed -n 's/.*"port":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$INSTANCE")
  [ "$IPORT" = "$CLAUDE_VIEW_PORT" ] || exit 0
else
  exit 0
fi

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
