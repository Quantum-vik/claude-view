# Terminal window — backend ↔ frontend contract

Branch: `feat/terminal-window` (backend only; **all changes are in `src-tauri/`, `src/` is untouched** so a parallel frontend branch won't conflict).

A "Terminal" is the *same* live-mirror machinery as a Claude session, but the PTY
runs a **login shell** (or **tmux**) instead of `claude`. Because it's a real PTY
child of the app, it runs with the user's full permissions and full login env
(PATH etc.) — that's what "all the permissions" means in practice. No hooks, no
transcript, no model/usage.

## What the backend now exposes

### 1. New command: `new_terminal`
```ts
import { invoke } from "@tauri-apps/api/core";

const info = await invoke<SessionInfo>("new_terminal", {
  cwd: "/Users/quantum/WorkPersonal/claude-view", // required, must be an existing dir
  kind: "tmux" | "shell",                          // optional, default "shell"
  openWindow: true,                                // optional, default true
});
```
- `kind: "tmux"` → `tmux new-session -A -s claude-view` through a login shell
  (attach-or-create; persists across window close). Falls back to a plain login
  shell if `tmux` isn't installed.
- `kind: "shell"` (or anything else) → the user's `$SHELL -l`.
- `openWindow: false` → **no native window**; embed the viewer in the launcher
  split pane yourself using the returned `viewer_id` (same pattern as
  `new_session` + `openInPane`). Connect over WS with `get_conn_info`.

Returns the same `SessionInfo` shape as `new_session`.

### 2. `SessionInfo` gained a field
```ts
interface SessionInfo {
  viewer_id: string;
  session_id: string | null;
  cwd: string;
  ended: boolean;
  is_terminal: boolean; // NEW — true for shell/tmux terminals
}
```
`list_sessions` and `new_session`/`new_terminal` all return it. Use it to render
terminal tabs/cards differently and to skip the Claude-only header controls.

### 3. Window URL flag
Native terminal windows open with `index.html?...&kind=terminal`. When embedding
in a pane you decide rendering from `is_terminal` instead. Suggested read:
```ts
const isTerminal =
  new URLSearchParams(location.search).get("kind") === "terminal";
```

## Frontend TODO (your session)

Per the agreed UX decisions:

1. **Launcher** — add a **"New Terminal ▾"** split button next to "New Session"
   with two items: **tmux session** and **plain shell**. Both call
   `handleNewTerminal(kind)`:
   ```ts
   async function handleNewTerminal(kind: "tmux" | "shell") {
     const selected = await open({ directory: true, multiple: false }); // pick dir each time
     if (!selected) return;
     const cwd = Array.isArray(selected) ? selected[0] : selected;
     const info = await invoke<SessionInfo>("new_terminal", {
       cwd, kind, openWindow: !embedMode,
     });
     if (embedMode) openInPane(info.viewer_id, info.cwd); // add a tab; else native window
     await refreshSessions();
   }
   ```
   Placement/cwd: same tab-or-window behavior as sessions (tab when
   `embedMode`, else native window), directory picker every time.

2. **Viewer** — when `is_terminal` (native: `kind=terminal` in URL; embedded:
   pass an `isTerminal` prop), render **only `<Terminal/>`** — drop the timeline
   sidebar, model/effort switcher, context meter, and hooks chip from
   `SessionWindow`. Cleanest is a thin `TerminalWindow.tsx` that reuses
   `Terminal.tsx` + a minimal header (breadcrumb + live/connection dot), or a
   `terminal` branch inside `SessionWindow`. `main.tsx` should route:
   `kind=terminal` → terminal viewer, else the existing `vid` → `SessionWindow`.

3. **Tabs / Active-now cards** — mark terminal tabs (e.g. a `❯_` glyph instead of
   the repo dot) using `is_terminal` so they're distinguishable from Claude tabs.

Nothing else in the WS/`Terminal.tsx` layer needs to change — it's already
kind-agnostic (bytes in/out + resize).
