// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod hooks_install;
mod past_sessions;
mod pty;
mod server;
mod session;
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
pub fn open_session(
    app: &AppHandle,
    registry: &Arc<Registry>,
    port: u16,
    token: &str,
    cwd: String,
    resume: Option<String>,
    continue_last: bool,
    open_window: bool,
) -> Result<SessionInfo, String> {
    let session = pty::spawn_session(registry, port, token, cwd.clone(), resume, continue_last)?;
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

    Ok(SessionInfo {
        viewer_id: vid,
        session_id: None,
        cwd,
        ended: false,
        is_terminal: false,
    })
}

/// Spawn a plain terminal (login shell or tmux attach-or-create) inside a PTY
/// and open its viewer window. The mirror machinery is shared with claude
/// sessions; only the spawned command and the `kind=terminal` window flag (which
/// tells the viewer to drop the claude-only chrome) differ.
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

    Ok(SessionInfo {
        viewer_id: vid,
        session_id: None,
        cwd,
        ended: false,
        is_terminal: true,
    })
}

#[tauri::command]
fn new_session(
    app: AppHandle,
    state: State<'_, AppState>,
    cwd: String,
    resume: Option<String>,
    continue_last: Option<bool>,
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
    "txt", "md", "markdown", "json", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "log",
    "csv", "tsv", "xml", "html", "htm", "css", "scss", "rs", "py", "js", "jsx", "ts", "tsx", "go",
    "java", "kt", "rb", "php", "c", "h", "cpp", "hpp", "cc", "cs", "swift", "sql", "sh", "lock",
    "gitignore", "dockerfile", "vue", "svelte", "lua", "r", "pl", "dart", "ex", "exs",
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
    let allowed = ext.as_deref().map(|e| SAFE_OPEN_EXTS.contains(&e)).unwrap_or(false);
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
fn focus_session(app: AppHandle, state: State<'_, AppState>, viewer_id: String) -> Result<(), String> {
    let label = format!("session-{viewer_id}");
    if let Some(window) = app.get_webview_window(&label) {
        return window.set_focus().map_err(|e| e.to_string());
    }
    // Window was closed but the session (and its PTY) is still running —
    // reopen a viewer; scrollback replays on connect. A terminal reopens with
    // the same `kind=terminal` flag and title it was created with.
    let session = state.registry.get(&viewer_id).ok_or("session not found")?;
    let kind_suffix = if session.is_terminal { "&kind=terminal" } else { "" };
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
    let size = if session.is_terminal { (1000.0, 680.0) } else { (1160.0, 740.0) };
    WebviewWindowBuilder::new(&app, label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(size.0, size.1)
        .build()
        .map_err(|e| format!("failed to reopen session window: {e}"))?;
    Ok(())
}

/// Move a popped-out session window back into the main app: tell the launcher
/// to open the session as a tab, focus the launcher, then close the native
/// session window. The session itself (PTY, scrollback) is untouched — the
/// tab simply reconnects as another viewer.
#[tauri::command]
fn dock_session(app: AppHandle, state: State<'_, AppState>, viewer_id: String) -> Result<(), String> {
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
        app.emit_to("main", "cv:dock", payload).map_err(|e| e.to_string())?;
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
fn notify(app: AppHandle, title: String, body: String, sound: Option<String>) -> Result<(), String> {
    use tauri_plugin_notification::{NotificationExt, PermissionState};
    const SOUNDS: &[&str] = &[
        "Glass", "Ping", "Pop", "Funk", "Hero", "Purr", "Submarine", "Tink",
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
    // newly-added events (Stop/Notification) automatically. install() is
    // idempotent — it only appends entries that are missing.
    if hooks_install::installed() {
        let _ = hooks_install::install();
    }

    let registry = Arc::new(Registry::default());
    // Random per run; CLAUDE_VIEW_TOKEN overrides for scripting/testing.
    let token =
        std::env::var("CLAUDE_VIEW_TOKEN").unwrap_or_else(|_| Uuid::new_v4().to_string());

    // Bind an ephemeral local port up front so its number can live in managed
    // state (sessions inject it into claude's env as CLAUDE_VIEW_PORT).
    let listener =
        std::net::TcpListener::bind("127.0.0.1:0").expect("failed to bind local server port");
    listener
        .set_nonblocking(true)
        .expect("failed to set listener non-blocking");
    let port = listener.local_addr().expect("listener addr").port();

    // Discovery file so local scripts (e.g. scripts/demo-timeline.sh) can
    // find this instance without token/port coordination. Localhost-only
    // server; file is user-readable only.
    if let Some(home) = dirs::home_dir() {
        let dir = home.join(".claude").join("claude-view");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("instance.json");
        let info = serde_json::json!({
            "port": port,
            "token": token,
            "pid": std::process::id(),
        });
        if std::fs::write(&path, info.to_string()).is_ok() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
            }
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
            tauri::RunEvent::ExitRequested { code: None, api, .. } => api.prevent_exit(),
            // Actual shutdown: kill every child so no `claude` is orphaned, and
            // remove the instance discovery file.
            tauri::RunEvent::Exit => {
                let state = app.state::<AppState>();
                for session in state.registry.all() {
                    session.kill();
                }
                if let Some(home) = dirs::home_dir() {
                    let _ = std::fs::remove_file(
                        home.join(".claude").join("claude-view").join("instance.json"),
                    );
                }
            }
            _ => {}
        });
}
