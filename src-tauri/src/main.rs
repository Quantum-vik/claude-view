// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod changes;
mod agents;
mod export;
mod git;
mod hooks_install;
mod liveness;
mod instance;
mod past_sessions;
mod pty;
mod rollup;
mod server;
mod session;
mod trace;
mod transcript;

use std::sync::Arc;

use session::{Registry, SessionInfo};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use uuid::Uuid;

struct AppState {
    registry: Arc<Registry>,
    port: u16,
    token: String,
}

/// Spawn a claude PTY session and open its viewer window. Shared by the
/// launcher UI command and the local POST /sessions endpoint.
///
/// `skip_permissions` selects whether the child runs with
/// `--dangerously-skip-permissions`; both callers default it to `true`.
// Nine parameters, over clippy's threshold. Bundling them into a struct
// would only move the argument list to the call sites, which are a Tauri
// command and an axum handler that each already destructure their own request
// type — so the struct would be pure ceremony.
#[allow(clippy::too_many_arguments)]
pub fn open_session(
    app: &AppHandle,
    registry: &Arc<Registry>,
    port: u16,
    token: &str,
    cwd: String,
    resume: Option<String>,
    continue_last: bool,
    skip_permissions: bool,
    open_window: bool,
) -> Result<SessionInfo, String> {
    let session = pty::spawn_session(
        registry,
        port,
        token,
        cwd.clone(),
        resume,
        continue_last,
        skip_permissions,
    )?;
    let vid = session.viewer_id.clone();

    // open_window=false: the launcher embeds the viewer in its own split
    // pane instead of a dedicated native window.
    if open_window {
        let url = format!(
            "index.html?vid={}&port={}&token={}&cwd={}",
            vid,
            port,
            token,
            urlencoding::encode(&cwd)
        );
        WebviewWindowBuilder::new(app, format!("session-{vid}"), WebviewUrl::App(url.into()))
            .title(format!("Claude — {cwd}"))
            .inner_size(1160.0, 740.0)
            .build()
            .map_err(|e| format!("failed to open session window: {e}"))?;
    }

    // Built by the session itself, never hand-rolled here: three construction
    // sites for one struct is how the launcher's optimistic card ends up
    // missing fields the registry listing has.
    Ok(session.info())
}

/// Spawn a plain terminal (login shell or tmux attach-or-create) inside a PTY
/// and open its viewer window. The mirror machinery is shared with claude
/// sessions; only the spawned command and the `kind=terminal` window flag (which
/// tells the viewer to drop the claude-only chrome) differ.
///
/// There is deliberately no `skip_permissions` parameter: a shell has no
/// permission model to skip, so `spawn_terminal` fixes it at `false` and these
/// sessions always report `skip_permissions: false`.
pub fn open_terminal(
    app: &AppHandle,
    registry: &Arc<Registry>,
    port: u16,
    token: &str,
    cwd: String,
    kind: pty::TerminalKind,
    open_window: bool,
) -> Result<SessionInfo, String> {
    let session = pty::spawn_terminal(registry, cwd.clone(), kind)?;
    let vid = session.viewer_id.clone();

    if open_window {
        let url = format!(
            "index.html?vid={}&port={}&token={}&cwd={}&kind=terminal",
            vid,
            port,
            token,
            urlencoding::encode(&cwd)
        );
        WebviewWindowBuilder::new(app, format!("session-{vid}"), WebviewUrl::App(url.into()))
            .title(format!("Terminal — {cwd}"))
            .inner_size(1000.0, 680.0)
            .build()
            .map_err(|e| format!("failed to open terminal window: {e}"))?;
    }

    Ok(session.info())
}

/// Launch a claude session. `skip_permissions` omitted means `true` — every
/// session this app has ever launched ran with `--dangerously-skip-permissions`
/// and that stays the default, so an older frontend (or one that simply doesn't
/// ask) behaves exactly as before. Pass `false` to get a session that stops and
/// asks before running tools.
#[tauri::command]
fn new_session(
    app: AppHandle,
    state: State<'_, AppState>,
    cwd: String,
    resume: Option<String>,
    continue_last: Option<bool>,
    skip_permissions: Option<bool>,
    open_window: Option<bool>,
) -> Result<SessionInfo, String> {
    open_session(
        &app,
        &state.registry,
        state.port,
        &state.token,
        cwd,
        resume,
        continue_last.unwrap_or(false),
        skip_permissions.unwrap_or(true),
        open_window.unwrap_or(true),
    )
}

/// Launch a plain terminal window (login shell or tmux). `kind` is "tmux" or
/// "shell" (anything else falls back to a login shell). `open_window=false`
/// embeds the viewer in the launcher's split pane instead of a native window.
#[tauri::command]
fn new_terminal(
    app: AppHandle,
    state: State<'_, AppState>,
    cwd: String,
    kind: Option<String>,
    open_window: Option<bool>,
) -> Result<SessionInfo, String> {
    let kind = pty::TerminalKind::parse(kind.as_deref().unwrap_or("shell"));
    open_terminal(
        &app,
        &state.registry,
        state.port,
        &state.token,
        cwd,
        kind,
        open_window.unwrap_or(true),
    )
}

fn find_in_path(name: &str) -> Option<std::path::PathBuf> {
    let paths = std::env::var_os("PATH")?;
    let mut dirs: Vec<std::path::PathBuf> = std::env::split_paths(&paths).collect();
    dirs.push("/opt/homebrew/bin".into());
    dirs.push("/usr/local/bin".into());
    dirs.into_iter().map(|d| d.join(name)).find(|c| c.is_file())
}

/// "src/app.py:42" -> ("src/app.py", Some(42))
fn split_line_suffix(s: &str) -> (&str, Option<u32>) {
    if let Some((base, suffix)) = s.rsplit_once(':') {
        if let Ok(line) = suffix.parse::<u32>() {
            return (base, Some(line));
        }
    }
    (s, None)
}

/// Open a file path clicked in a mirrored terminal. Relative paths resolve
/// against the session's cwd. Prefers `code -g` (jumps to the line), falls
/// back to the OS opener.
/// Extensions the OS default-app opener may launch when VS Code isn't present.
/// Deliberately a small allowlist of inert document/source types — never
/// executables — because terminal output is untrusted (a malicious program can
/// print an OSC 8 link with spoofed visible text pointing anywhere).
const SAFE_OPEN_EXTS: &[&str] = &[
    "txt",
    "md",
    "markdown",
    "json",
    "yaml",
    "yml",
    "toml",
    "ini",
    "cfg",
    "conf",
    "env",
    "log",
    "csv",
    "tsv",
    "xml",
    "html",
    "htm",
    "css",
    "scss",
    "rs",
    "py",
    "js",
    "jsx",
    "ts",
    "tsx",
    "go",
    "java",
    "kt",
    "rb",
    "php",
    "c",
    "h",
    "cpp",
    "hpp",
    "cc",
    "cs",
    "swift",
    "sql",
    "sh",
    "lock",
    "gitignore",
    "dockerfile",
    "vue",
    "svelte",
    "lua",
    "r",
    "pl",
    "dart",
    "ex",
    "exs",
];

#[cfg(unix)]
fn is_executable(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}
#[cfg(not(unix))]
fn is_executable(_meta: &std::fs::Metadata) -> bool {
    false
}

/// Open a file path clicked in a mirrored terminal. Hardened against crafted
/// terminal output: resolves + canonicalizes, refuses anything that isn't a
/// plain non-executable file, and always routes through VS Code (`code -g`,
/// which only ever displays a file as text) when available. The OS default
/// opener — which could *execute* a bundle/script — is used only as a fallback
/// and only for an allowlist of inert document types.
/// Write a session's full trace to `dest`.
///
/// The command writes the file itself rather than handing the body back for the
/// webview to save: that would mean granting the frontend a general
/// write-any-file capability, a far larger surface than "write this one export
/// to the path the user just picked in a dialog".
/// Spend across every session on this machine.
///
/// Scans the whole transcript corpus rather than asking each open session for
/// its total: a resumed session replays earlier turns verbatim into a new file,
/// so per-session ledgers are individually correct and still sum to the wrong
/// number. De-duplication has to be global.
#[tauri::command]
fn session_spend() -> Result<serde_json::Value, String> {
    let root = dirs::home_dir()
        .map(|h| h.join(".claude").join("projects"))
        .ok_or("no home directory")?;
    let spend = crate::rollup::scan(&root);
    serde_json::to_value(spend).map_err(|e| e.to_string())
}

/// `agent`, when set, exports only that run. An agent window passes it:
/// exporting the whole parent session from a window titled for one run is
/// the surprising outcome, not the safe one.
#[tauri::command]
fn export_trace(
    state: State<'_, AppState>,
    viewer_id: String,
    format: String,
    dest: String,
    agent: Option<String>,
) -> Result<serde_json::Value, String> {
    let fmt = crate::export::Format::parse(&format).ok_or("unknown format")?;
    let session = state
        .registry
        .get(&viewer_id)
        .ok_or_else(|| "no such session".to_string())?;

    let sid = session.session_id.read().clone();
    let path = crate::trace::locate_for(&session.cwd, sid.as_deref(), session.spawned_at);

    // Read the WHOLE trace, not a page: a partial export is worse than none,
    // because nothing in the file would say it was cut short.
    let mut entries = Vec::new();
    let mut turns = std::collections::BTreeMap::new();
    let mut sources = Vec::new();
    let mut cursor = crate::trace::Cursor::default();
    for _ in 0..500 {
        let page = crate::trace::read_page(path.as_deref(), &cursor, crate::trace::MAX_LIMIT)
            .map_err(|why| match why {
                crate::trace::Unavailable::NoTranscript => {
                    "no transcript for this session — nothing to export".to_string()
                }
                crate::trace::Unavailable::Unreadable => {
                    "the transcript could not be read".to_string()
                }
            })?;
        if page.sources.len() > sources.len() {
            sources = page.sources.clone();
        }
        let done = !page.has_more || page.entries.is_empty();
        entries.extend(page.entries);
        turns.extend(page.turns);
        cursor = crate::trace::Cursor::decode(&page.cursor).unwrap_or_default();
        if done {
            break;
        }
    }

    // Scoping is applied to the WHOLE trace, never to a page: the "read
    // everything first" rule above exists so a file can never be silently cut
    // short, and filtering a complete read keeps that guarantee.
    if let Some(agent) = &agent {
        entries.retain(|e| e.agent_id.as_deref() == Some(agent.as_str()));
        sources.retain(|s| s == agent);
    }

    let meta = crate::export::Meta {
        session_id: sid,
        cwd: session.cwd.clone(),
        model: session.model.read().clone(),
        sources,
        exported_at: now_iso8601(),
    };
    let body = match fmt {
        crate::export::Format::Markdown => crate::export::to_markdown(&entries, &turns, &meta),
        crate::export::Format::Json => crate::export::to_json(&entries, &turns, &meta),
    };
    let dest = fmt.with_extension(&dest);
    std::fs::write(&dest, body.as_bytes()).map_err(|e| format!("could not write {dest}: {e}"))?;
    Ok(serde_json::json!({
        "path": dest,
        "bytes": body.len(),
        "entries": entries.len(),
        "turns": turns.len(),
    }))
}

/// `2026-09-18T11:00:00Z`, without pulling in a datetime crate for one line.
fn now_iso8601() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = secs / 86_400;
    let (h, mi, s) = ((secs % 86_400) / 3600, (secs % 3600) / 60, secs % 60);
    // Civil-from-days (Howard Hinnant), matching transcript.rs's parser.
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

/// The agent-run roster for a session: every subagent it spawned, named and
/// costed, plus the parent totals so the viewer can show the partition.
///
/// A separate command rather than a field on `read_trace`, because the two
/// answer different questions: the trace is paged and positional, the roster is
/// whole-session and unordered by position. Folding them would mean either
/// recomputing the roster on every page or letting it go stale on page two.
#[tauri::command]
fn read_agents(state: State<'_, AppState>, viewer_id: String) -> Result<serde_json::Value, String> {
    let session = state
        .registry
        .get(&viewer_id)
        .ok_or_else(|| "no such session".to_string())?;
    let sid = session.session_id.read().clone();
    let path = crate::trace::locate_for(&session.cwd, sid.as_deref(), session.spawned_at);

    match path
        .as_deref()
        .ok_or(crate::trace::Unavailable::NoTranscript)
        .and_then(crate::agents::read_roster)
    {
        Ok(roster) => serde_json::to_value(roster).map_err(|e| e.to_string()),
        // Same typed-absence contract as the trace: the panel says WHICH
        // failure it is rather than rendering an empty roster for "I cannot see".
        Err(why) => Ok(serde_json::json!({
            "unavailable": why,
            "runs": [],
            "parentTurns": 0,
            "parentUsage": crate::transcript::TokenUsage::default(),
            "duplicatesFolded": 0,
        })),
    }
}

/// What the session changed on disk, measured from the commit HEAD pointed at
/// when it started.
///
/// Separate from `read_trace` for the same reason `read_agents` is: the trace is
/// paged and positional, a change set is whole-session and keyed by path. It is
/// also computed on demand rather than polled — a diff is reviewed, not watched.
/// Watch a session claude-view did not launch (#40).
///
/// Read-only by construction: the registry entry has no PTY, so there is nothing
/// to type into and nothing to resize. Every other command — the trace, the
/// roster, the change set, cost — already works from `cwd` and `session_id`, so
/// this adds an entry point rather than a second code path.
///
/// Hooks never arrive from such a session (#41), so it is discovered from disk
/// and its liveness is read from the transcript.
#[tauri::command]
fn watch_session(
    app: AppHandle,
    state: State<'_, AppState>,
    cwd: String,
    session_id: String,
    open_window: Option<bool>,
) -> Result<SessionInfo, String> {
    let path = crate::trace::locate_for(&cwd, Some(&session_id), 0)
        .ok_or_else(|| "no transcript for that session".to_string())?;

    // The session's own start, not now. `spawned_at` is what the tailer pages
    // from and what the change set derives its baseline from, so stamping it
    // with the moment Watch was clicked would claim the session began then.
    let meta = std::fs::metadata(&path).map_err(|e| format!("unreadable transcript: {e}"))?;
    let started_at = meta
        .created()
        .or_else(|_| meta.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or_else(crate::session::now_ms);

    let vid = uuid::Uuid::new_v4().to_string();
    let session = std::sync::Arc::new(crate::session::Session::watched(
        vid.clone(),
        cwd.clone(),
        session_id,
        started_at,
    ));
    state.registry.insert(session.clone());

    if open_window.unwrap_or(true) {
        let url = format!(
            "index.html?vid={}&port={}&token={}&cwd={}&watched=1",
            vid,
            state.port,
            state.token,
            urlencoding::encode(&cwd)
        );
        WebviewWindowBuilder::new(&app, format!("session-{vid}"), WebviewUrl::App(url.into()))
            .title(format!("Watching — {cwd}"))
            .inner_size(1160.0, 740.0)
            .build()
            .map_err(|e| format!("failed to open window: {e}"))?;
    }
    Ok(session.info())
}

/// Whether a watched session is still going, read from its transcript.
///
/// Polled by the window rather than pushed, because nothing pushes: there is no
/// process to report an exit and no hooks to report a turn (#41).
#[tauri::command]
fn session_liveness(
    state: State<'_, AppState>,
    viewer_id: String,
) -> Result<serde_json::Value, String> {
    let session = state
        .registry
        .get(&viewer_id)
        .ok_or_else(|| "no such session".to_string())?;
    let sid = session.session_id.read().clone();
    let path = crate::trace::locate_for(&session.cwd, sid.as_deref(), session.spawned_at)
        .ok_or_else(|| "no transcript".to_string())?;
    let mtime = std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let state_ = crate::liveness::probe(&path, mtime, crate::session::now_ms());
    serde_json::to_value(state_).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_changes(state: State<'_, AppState>, viewer_id: String) -> Result<serde_json::Value, String> {
    let session = state
        .registry
        .get(&viewer_id)
        .ok_or_else(|| "no such session".to_string())?;
    let cs = crate::changes::read(std::path::Path::new(&session.cwd), session.spawned_at);
    serde_json::to_value(cs).map_err(|e| e.to_string())
}

/// Unified patch for one file, fetched when the reader opens it. Kept out of
/// `read_changes` so a 5,668-line lock file does not ride along in a listing
/// nobody asked to expand.
#[tauri::command]
fn read_patch(
    state: State<'_, AppState>,
    viewer_id: String,
    path: String,
) -> Result<String, String> {
    let session = state
        .registry
        .get(&viewer_id)
        .ok_or_else(|| "no such session".to_string())?;
    crate::changes::patch(
        std::path::Path::new(&session.cwd),
        session.spawned_at,
        &path,
    )
}

#[tauri::command]
fn read_trace(
    state: State<'_, AppState>,
    viewer_id: String,
    after: Option<String>,
    limit: Option<usize>,
) -> Result<serde_json::Value, String> {
    // The webview talks to the backend through commands, not through the local
    // HTTP server: that server exists for hooks and scripting, and the webview
    // is a different origin from 127.0.0.1:<port>, so a fetch would need a CORS
    // layer we have no reason to open. `GET /trace/:id` stays for scripting.
    let session = state
        .registry
        .get(&viewer_id)
        .ok_or_else(|| "no such session".to_string())?;

    let cursor = match after.as_deref() {
        Some(raw) => crate::trace::Cursor::decode(raw).ok_or("malformed cursor")?,
        None => crate::trace::Cursor::default(),
    };
    let sid = session.session_id.read().clone();
    let path = crate::trace::locate_for(&session.cwd, sid.as_deref(), session.spawned_at);

    match crate::trace::read_page(
        path.as_deref(),
        &cursor,
        limit.unwrap_or(crate::trace::DEFAULT_LIMIT),
    ) {
        Ok(page) => serde_json::to_value(page).map_err(|e| e.to_string()),
        // A typed absence, so the panel can say WHICH failure it is rather than
        // rendering "nothing happened" for "I cannot see".
        Err(why) => Ok(serde_json::json!({
            "unavailable": why,
            "entries": [],
            "cursor": cursor.encode(),
            "hasMore": false,
            "sources": [],
            "turns": {},
        })),
    }
}

#[tauri::command]
fn open_path(path: String, cwd: Option<String>) -> Result<(), String> {
    use std::path::{Path, PathBuf};

    let (raw, line) = split_line_suffix(path.trim());
    let mut pb = if let Some(rest) = raw.strip_prefix("~/") {
        dirs::home_dir().ok_or("no home dir")?.join(rest)
    } else {
        PathBuf::from(raw)
    };
    if pb.is_relative() {
        if let Some(cwd) = &cwd {
            pb = Path::new(cwd).join(pb);
        }
    }
    let pb = pb
        .canonicalize()
        .map_err(|_| format!("not found: {}", pb.display()))?;

    let meta = std::fs::metadata(&pb).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("refusing to open: not a regular file".into());
    }
    if is_executable(&meta) {
        return Err("refusing to open an executable file".into());
    }

    if let Some(code) = find_in_path("code") {
        // VS Code renders the file as text; it never executes it, so it's safe
        // for any (non-executable) file type.
        let target = match line {
            Some(l) => format!("{}:{l}", pb.display()),
            None => pb.display().to_string(),
        };
        if std::process::Command::new(code)
            .arg("-g")
            .arg(target)
            .spawn()
            .is_ok()
        {
            return Ok(());
        }
    }

    // Fallback: OS default app, but only for inert document extensions.
    let ext = pb
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase());
    let allowed = ext
        .as_deref()
        .map(|e| SAFE_OPEN_EXTS.contains(&e))
        .unwrap_or(false);
    if !allowed {
        return Err(format!(
            "refusing to hand '{}' to the OS opener (install the `code` CLI to open arbitrary files as text)",
            pb.display()
        ));
    }
    open::that(pb.as_os_str()).map_err(|e| e.to_string())
}

/// Open an http(s) link clicked in a mirrored terminal in the default browser.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    // Reject anything that isn't plainly http(s); the `open` crate passes the
    // URL to the OS handler without shell parsing, so no cmd injection.
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("unsupported scheme".into());
    }
    if url.contains(['\n', '\r', '\0', '"']) {
        return Err("invalid URL".into());
    }
    open::that(url).map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
struct ConnInfo {
    port: u16,
    token: String,
}

/// Connection details the launcher needs to embed a session viewer in-window.
#[tauri::command]
fn get_conn_info(state: State<'_, AppState>) -> ConnInfo {
    ConnInfo {
        port: state.port,
        token: state.token.clone(),
    }
}

#[tauri::command]
fn list_sessions(state: State<'_, AppState>) -> Vec<SessionInfo> {
    let mut sessions = state.registry.list();
    sessions.sort_by(|a, b| a.cwd.cmp(&b.cwd));
    sessions
}

#[tauri::command]
fn focus_session(
    app: AppHandle,
    state: State<'_, AppState>,
    viewer_id: String,
) -> Result<(), String> {
    let label = format!("session-{viewer_id}");
    if let Some(window) = app.get_webview_window(&label) {
        return window.set_focus().map_err(|e| e.to_string());
    }
    // Window was closed but the session (and its PTY) is still running —
    // reopen a viewer; scrollback replays on connect. A terminal reopens with
    // the same `kind=terminal` flag and title it was created with.
    let session = state.registry.get(&viewer_id).ok_or("session not found")?;
    let kind_suffix = if session.is_terminal {
        "&kind=terminal"
    } else {
        ""
    };
    let url = format!(
        "index.html?vid={}&port={}&token={}&cwd={}{}",
        viewer_id,
        state.port,
        state.token,
        urlencoding::encode(&session.cwd),
        kind_suffix
    );
    let title = if session.is_terminal {
        format!("Terminal — {}", session.cwd)
    } else {
        format!("Claude — {}", session.cwd)
    };
    let size = if session.is_terminal {
        (1000.0, 680.0)
    } else {
        (1160.0, 740.0)
    };
    WebviewWindowBuilder::new(&app, label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(size.0, size.1)
        .build()
        .map_err(|e| format!("failed to reopen session window: {e}"))?;
    Ok(())
}

/// Open one agent run in its own window, read-only.
///
/// A run is not a session: it has no PTY, so there is nothing to type into and
/// nothing to resize. What it does have is its own transcript, its own context
/// window, its own model and its own cost — enough to be worth looking at on
/// its own terms rather than as a filtered slice of its parent.
///
/// The window is addressed by the PARENT's viewer id plus the agent id, because
/// the run has no registry entry of its own; the reader resolves its transcript
/// from the parent's, exactly as the roster does.
#[tauri::command]
fn open_agent_window(
    app: AppHandle,
    state: State<'_, AppState>,
    viewer_id: String,
    agent_id: String,
) -> Result<(), String> {
    // One window per run, so clicking the same run twice focuses rather than
    // stacking duplicates on top of each other.
    let label = format!("agent-{viewer_id}-{agent_id}");
    if let Some(window) = app.get_webview_window(&label) {
        return window.set_focus().map_err(|e| e.to_string());
    }
    let session = state.registry.get(&viewer_id).ok_or("session not found")?;
    let url = format!(
        "index.html?vid={}&port={}&token={}&cwd={}&kind=agent&agent={}",
        viewer_id,
        state.port,
        state.token,
        urlencoding::encode(&session.cwd),
        urlencoding::encode(&agent_id)
    );
    WebviewWindowBuilder::new(&app, label, WebviewUrl::App(url.into()))
        .title(format!("Agent — {}", &agent_id[..agent_id.len().min(12)]))
        .inner_size(1000.0, 720.0)
        .build()
        .map_err(|e| format!("failed to open agent window: {e}"))?;
    Ok(())
}

/// Move a popped-out session window back into the main app: tell the launcher
/// to open the session as a tab, focus the launcher, then close the native
/// session window. The session itself (PTY, scrollback) is untouched — the
/// tab simply reconnects as another viewer.
#[tauri::command]
fn dock_session(
    app: AppHandle,
    state: State<'_, AppState>,
    viewer_id: String,
) -> Result<(), String> {
    let session = state.registry.get(&viewer_id).ok_or("session not found")?;
    let payload = serde_json::json!({
        "vid": viewer_id,
        "cwd": session.cwd,
        "isTerminal": session.is_terminal,
    });
    // Only emit when the launcher webview already exists — a freshly created
    // one wouldn't have its listener attached yet (the session stays visible
    // under "Active now" there regardless).
    let had_launcher = app.get_webview_window("main").is_some();
    show_launcher(&app);
    if had_launcher {
        app.emit_to("main", "cv:dock", payload)
            .map_err(|e| e.to_string())?;
        if let Some(window) = app.get_webview_window(&format!("session-{viewer_id}")) {
            let _ = window.close();
        }
    }
    Ok(())
}

/// Refocus the launcher window, recreating it if it was closed.
fn show_launcher(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    } else {
        let _ = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
            .title("Claude View")
            .inner_size(520.0, 640.0)
            .build();
    }
}

#[tauri::command]
fn list_past_sessions() -> Result<Vec<past_sessions::PastSession>, String> {
    past_sessions::list()
}

/// Move a past session's transcript to the OS Trash (recoverable). The row's
/// UI confirms before calling this.
#[tauri::command]
fn delete_past_session(session_id: String) -> Result<(), String> {
    past_sessions::delete(&session_id)
}

/// Remove a session from the registry and kill its child. Called when the user
/// closes an ENDED session's tab/window so its PTY fds, scrollback, and channels
/// are reclaimed (live sessions are intentionally kept so closing a window
/// doesn't kill them).
#[tauri::command]
fn close_session(app: AppHandle, state: State<'_, AppState>, viewer_id: String) {
    if let Some(session) = state.registry.remove(&viewer_id) {
        session.kill();
    }
    if let Some(window) = app.get_webview_window(&format!("session-{viewer_id}")) {
        let _ = window.close();
    }
}

#[tauri::command]
fn hooks_status() -> bool {
    hooks_install::installed()
}

/// Show a native notification with a sound, posted under the app's own
/// identity (tauri-plugin-notification) — so CLICKING the notification
/// activates claude-view. The previous osascript implementation belonged to
/// Script Editor, and clicks opened that instead. The sound name is
/// restricted to a known set so nothing user-controlled leaks through.
#[tauri::command]
fn notify(
    app: AppHandle,
    title: String,
    body: String,
    sound: Option<String>,
) -> Result<(), String> {
    use tauri_plugin_notification::{NotificationExt, PermissionState};
    const SOUNDS: &[&str] = &[
        "Glass",
        "Ping",
        "Pop",
        "Funk",
        "Hero",
        "Purr",
        "Submarine",
        "Tink",
    ];
    let sound = sound
        .as_deref()
        .filter(|s| SOUNDS.contains(s))
        .unwrap_or("Glass");
    // macOS drops notifications from apps that never asked for authorization —
    // banners silently don't appear. Ask (once; the OS remembers) before
    // posting.
    let notifications = app.notification();
    match notifications.permission_state() {
        Ok(PermissionState::Granted) => {}
        _ => {
            let _ = notifications.request_permission();
        }
    }
    notifications
        .builder()
        .title(&title)
        .body(&body)
        .sound(sound)
        .show()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn install_hooks() -> Result<String, String> {
    hooks_install::install()
}

#[tauri::command]
fn uninstall_hooks() -> Result<String, String> {
    hooks_install::uninstall()
}

fn main() {
    // Hook-set upgrade: users who installed hooks under an older build pick up
    // newly-added events (this release adds UserPromptSubmit, which is what
    // makes a turn that thinks for 90s before its first tool call show as
    // Working) automatically. install() is idempotent — it only appends entries
    // that are missing.
    if hooks_install::installed() {
        let _ = hooks_install::install();
    }

    let registry = Arc::new(Registry::default());
    // Random per run; CLAUDE_VIEW_TOKEN overrides for scripting/testing.
    let token = std::env::var("CLAUDE_VIEW_TOKEN").unwrap_or_else(|_| Uuid::new_v4().to_string());

    // Bind an ephemeral local port up front so its number can live in managed
    // state (sessions inject it into claude's env as CLAUDE_VIEW_PORT).
    let listener =
        std::net::TcpListener::bind("127.0.0.1:0").expect("failed to bind local server port");
    listener
        .set_nonblocking(true)
        .expect("failed to set listener non-blocking");
    let port = listener.local_addr().expect("listener addr").port();

    // Discovery files so the hook bridge (and local scripts like
    // scripts/demo-timeline.sh) can find this instance without token/port
    // coordination. Localhost-only server; the files are owner-readable only
    // because the token in them grants full control of every session.
    //
    // Reap first: RunEvent::Exit never fires on a crash or `kill -9`, so a
    // previous run's file can still be sitting there advertising a dead pid.
    if let Some(root) = instance::default_root() {
        instance::reap_stale(&root);
        if let Err(e) = instance::publish(&root, port, &token, std::process::id()) {
            // Not fatal — the app still runs, but hooks can't authenticate, so
            // say so instead of leaving an empty timeline unexplained.
            eprintln!("claude-view: could not publish instance discovery file: {e}");
        }
    }

    let state = AppState {
        registry: registry.clone(),
        port,
        token: token.clone(),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(state)
        .setup(move |app| {
            let router = server::router(registry, token, app.handle().clone(), port);
            tauri::async_runtime::spawn(async move {
                let listener = tokio::net::TcpListener::from_std(listener)
                    .expect("failed to adopt listener into tokio");
                axum::serve(listener, router)
                    .await
                    .expect("local server crashed");
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            new_session,
            new_terminal,
            list_sessions,
            list_past_sessions,
            delete_past_session,
            focus_session,
            dock_session,
            close_session,
            get_conn_info,
            read_trace,
            read_agents,
            read_changes,
            watch_session,
            session_liveness,
            read_patch,
            open_agent_window,
            export_trace,
            session_spend,
            open_path,
            open_url,
            hooks_status,
            install_hooks,
            uninstall_hooks,
            notify
        ])
        .build(tauri::generate_context!())
        .expect("error while building claude-view")
        .run(move |app, event| match event {
            // macOS: clicking the Dock icon reopens the launcher.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => show_launcher(app),
            // macOS: keep running when the last window closes (sessions and
            // their PTYs live in this process). `code: None` is the
            // all-windows-closed case; explicit quits (Cmd+Q) pass a code.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::ExitRequested {
                code: None, api, ..
            } => api.prevent_exit(),
            // Actual shutdown: kill every child so no `claude` is orphaned, and
            // remove OUR discovery files — matched by pid, never blindly. A
            // second instance may be running and own the legacy instance.json;
            // deleting it would break that instance's hook bridge.
            tauri::RunEvent::Exit => {
                let state = app.state::<AppState>();
                for session in state.registry.all() {
                    session.kill();
                }
                if let Some(root) = instance::default_root() {
                    instance::cleanup(&root, std::process::id());
                }
            }
            _ => {}
        });
}
