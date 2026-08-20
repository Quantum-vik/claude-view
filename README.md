# claude-view

A desktop app that opens a **dedicated window for each Claude Code CLI session** and mirrors that
session's terminal **in real time, character-by-character** — every command, its live scrolling
output, and Claude's messages — plus a **structured command-timeline sidebar** driven by Claude
Code hooks.

## Permissions: sessions skip approval prompts by default

**Every session claude-view launches runs `claude --dangerously-skip-permissions` unless you turn
that off.** That has been true since the app's first commit. It is now a visible, per-session
choice instead of a hardcoded one — but the default is unchanged, so upgrading does not alter how
anything you already run behaves.

What the flag does: Claude Code stops asking you to approve tool calls. For the whole session,
Claude writes, edits and deletes files and runs shell commands immediately, without confirmation.
Nothing sits between the model deciding to run something and it running on your machine, in
whatever directory you pointed the session at.

**Turning it off.** The launcher has a **Skip permission prompts** toggle that applies to the next
session you start; the choice is remembered. With it off, the session gets Claude Code's normal
approval prompts. The setting is fixed once a session is running — it's a process argument, so
changing it means launching a new session. Sessions running with it on are tagged **skip perms**
in the launcher list, and every session reports `"skip_permissions": true|false` in the session
API. Terminal windows are unaffected: they run your login shell with your own privileges and have
no such flag (they always report `false`).

**Why a session can sit there looking idle.** With prompts skipped, a permission prompt is never
drawn, so nothing ever puts a session into the `blocked` state because of one. A quiet session
mid-task has already run the command — a stricter setup would have stopped there and asked you
first. That is the trade this default makes; the toggle is how you take the other side of it.

## How it works (the two layers)

Claude Code's observability channels (hooks, Agent SDK, `stream-json`, transcripts, OTel) only
emit tool output **after** a command finishes — none stream live output. So:

| Layer | Source | Latency |
|---|---|---|
| **Live terminal mirror** | `claude` spawned inside a PTY the app owns (`portable-pty`) → raw bytes → binary WebSocket → xterm.js | Instant, char-by-char |
| **Command timeline sidebar** | Claude Code `command` hooks → bundled bridge script → HTTP POST to the app's local server | Per-command |

The app **launches** sessions (so it owns their terminals) and **observes** them (via hooks).
Multiple concurrent sessions each get their own native window, correlated by
`CLAUDE_VIEW_ID` (env, injected at spawn) ↔ `session_id` (from the `SessionStart` hook).

## Prerequisites

- **Rust** (stable, 1.77+) — https://rustup.rs
- **Node.js** 18+ and npm
- **Claude Code CLI** (`claude` on PATH; or set `CLAUDE_BIN=/full/path/to/claude`)
- Linux only: Tauri v2 system deps (webkit2gtk 4.1, etc.) — see https://v2.tauri.app/start/prerequisites/

## Run (dev)

```bash
cd claude-view
npm install
npm run tauri dev
```

The launcher window opens. Click **New Session**, pick a working directory, and a session window
opens running `claude --dangerously-skip-permissions` (the default — see
[Permissions](#permissions-sessions-skip-approval-prompts-by-default)) with a live terminal
mirror. The session is fully interactive from the window — type into it exactly as you would in a
terminal.

## Build (release)

```bash
npm run tauri build
```

Installers/bundles land in `src-tauri/target/release/bundle/`.
(The bundled icon is a placeholder; replace `src-tauri/icons/icon.png` — and add an `.icns`/`.ico`
via `npx tauri icon` — before shipping.)

## Enable the timeline sidebar (hooks)

The live terminal works with no setup. The sidebar needs Claude Code hooks:

1. In the launcher window, click **Install** under *Hooks* (asks nothing else; it's reversible).
   This:
   - writes the bridge script to `~/.claude/claude-view/claude-view-hook.sh` (`.ps1` on Windows), and
   - merges `SessionStart` / `PreToolUse` / `PostToolUse` / `SessionEnd` entries into
     `~/.claude/settings.json`, **preserving any existing hooks** (a one-shot backup is written to
     `settings.json.claude-view.bak`).
2. **Uninstall** removes exactly those entries and the script, nothing else.

The bridge script is a no-op when `CLAUDE_VIEW_ID` is unset, so sessions started outside
claude-view are completely unaffected. It fires a `curl` with a 2s timeout in the background and
always exits 0, so it can never block Claude Code. The payload is piped via stdin (not a CLI
argument), so large tool outputs are never truncated by `ARG_MAX`.

**Security note:** the auth token is *not* injected into the session's environment (it would be
readable by every process Claude spawns). The bridge script reads it from the 0600
`~/.claude/claude-view/instance.json` instead. **If you installed hooks before this change, click
Install again** to refresh the bridge script — otherwise the old script can't authenticate and the
timeline stays empty.

## Using it

- **New Session** → directory picker → new window running `claude` in that cwd. By default that is
  `claude --dangerously-skip-permissions`; the **Skip permission prompts** toggle next to the
  launcher's session controls decides, and it applies to **Resume in viewer** too. Read
  [Permissions](#permissions-sessions-skip-approval-prompts-by-default) before leaving it on.
- **Resume in viewer** → directory picker → runs `claude --continue` (most recent conversation in
  that directory) or `claude --resume <id>` if you paste a session id. This is how you bring an
  *existing* session into the viewer: the app can only mirror terminals it owns, so live-attaching
  to a session running in another terminal isn't possible — exit it there, then resume it here
  with full history.
- Each Bash/tool call Claude makes appears in the sidebar as an amber *running* card that resolves
  to green *success* / red *error* with a duration (requires hooks installed).
- **Cmd/Ctrl+F** in a session window: search the terminal scrollback.
- When `claude` exits, the window shows an **ENDED** badge and keeps the scrollback visible.
- Closing a session window does not kill the session's PTY; reopen/focus from the launcher list
  (the last 2 MB of output replays on reconnect).

## Architecture

```
Tauri app (one process)
├─ Session Manager (Rust)     registry: viewer_id ↔ session_id ↔ PTY ↔ window
├─ PTY per session            portable-pty: ConPTY on Windows, openpty on Unix
├─ axum server on 127.0.0.1:<ephemeral port>
│   ├─ GET  /ws/:id           binary frames = raw PTY bytes out / keystrokes in
│   │                         text frames   = resize (in), timeline + bound + exit (out)
│   ├─ POST /hooks            hook events from the bridge script (token-authed)
│   └─ POST /bind             explicit viewer_id ↔ session_id binding (spec compat)
└─ One webview window per session: xterm.js (+fit/webgl/search) + timeline sidebar
```

## Implementation notes / chosen defaults

Where the spec was silent (or allowed a choice), these defaults were picked:

- **Timeline transport:** pushed as JSON **text frames on the same WebSocket** as the PTY bytes
  (binary = bytes, text = control) instead of a second WS channel or Tauri emit — one connection,
  no framing ambiguity.
- **Bridge normalization:** the bridge script forwards the hook's stdin JSON **verbatim** with
  `X-Claude-View-Id` / `X-Claude-View-Token` headers; normalization happens server-side in Rust.
  This keeps the shell script dependency-free (no `jq`). `SessionStart` binds via `/hooks`
  directly; `/bind` also exists per the spec contract for custom bridges.
- **Bridge script location:** installed to `~/.claude/claude-view/` (not the app bundle dir) so
  the `settings.json` entry survives app moves/updates and works identically in dev and release.
- **Auth:** a per-app-run UUID token is required on `/hooks`, `/bind`, and the WebSocket
  (`?token=`); the server binds to `127.0.0.1` only.
- **Pre/Post correlation:** by `tool_use_id` when the hook payload provides it, else FIFO per
  tool name. Duration = server receipt-time delta between Pre and Post.
- **Success detection:** hook payloads carry no stable success flag across versions, so
  `tool_response` is inspected defensively (`is_error`, `success:false`, `error`), defaulting to
  success.
- **Scrollback replay:** the server keeps the last 2 MB of PTY output per session and replays it
  on WS (re)connect, so refreshed/reopened windows aren't blank.
- **`SessionStart`/`SessionEnd` hook entries omit `matcher`** (lifecycle events match all sources
  that way); `PreToolUse`/`PostToolUse` use `"matcher": "*"` per the spec.
- **Permission mode:** sessions default to `--dangerously-skip-permissions`, per-session
  overridable, reported as `skip_permissions` on every session. The default is kept as-is because
  changing it would silently alter the security posture of an existing install; see
  [Permissions](#permissions-sessions-skip-approval-prompts-by-default) for what it costs you.
- **claude discovery:** `CLAUDE_BIN` env override, then PATH, then common install dirs
  (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.claude/local`).
- **Session windows** get their config via URL query params (`vid`, `port`, `token`, `cwd`).
- **Scripting affordances** (added beyond the spec, used by the e2e smoke tests):
  - `CLAUDE_VIEW_TOKEN` env var fixes the auth token instead of a random per-run UUID.
  - `POST /sessions` `{"cwd": "..."}` (token-authed, localhost) launches a session + window
    from the CLI: the response returns the `viewer_id`. Add `"skip_permissions": false` for a
    session that asks before running tools; **omitting the key means `true`**, matching the app's
    default. A present-but-non-boolean value is a 400, not a guess in either direction.

## Project layout

```
claude-view/
├─ src-tauri/                 Rust backend
│  ├─ src/main.rs             Tauri setup, commands, spawns axum
│  ├─ src/server.rs           axum routes: /ws/:id, /hooks, /bind
│  ├─ src/pty.rs              portable-pty spawn, reader thread, resize
│  ├─ src/session.rs          registry, correlation, timeline state
│  ├─ src/hooks_install.rs    settings.json merge/remove + bridge script install
│  └─ scripts/                claude-view-hook.sh / .ps1 (bridge)
├─ src/                       React + TS frontend
│  ├─ SessionWindow.tsx       per-session layout (terminal + sidebar)
│  ├─ Terminal.tsx            xterm.js + fit/webgl/search + WS wiring
│  ├─ Timeline.tsx            command cards
│  ├─ Launcher.tsx            main window (new session, list, hooks)
│  └─ ws.ts                   binary WebSocket client with reconnect
└─ README.md
```
