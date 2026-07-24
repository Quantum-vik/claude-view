use std::io::Read;
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::{Mutex, RwLock};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::session::{Registry, Session};

/// Find the `claude` executable. GUI apps (especially on macOS when launched
/// from Finder) get a minimal PATH, so we also probe common install locations.
/// `CLAUDE_BIN` env var overrides everything.
pub fn resolve_claude_bin() -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("CLAUDE_BIN") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Ok(p);
        }
    }

    #[cfg(windows)]
    let names: &[&str] = &["claude.cmd", "claude.exe", "claude"];
    #[cfg(not(windows))]
    let names: &[&str] = &["claude"];

    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            for name in names {
                let cand = dir.join(name);
                if cand.is_file() {
                    return Ok(cand);
                }
            }
        }
    }

    let mut candidates: Vec<PathBuf> = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ];
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".local/bin"));
        candidates.push(home.join(".claude/local"));
        candidates.push(home.join("bin"));
    }
    for dir in candidates {
        for name in names {
            let cand = dir.join(name);
            if cand.is_file() {
                return Ok(cand);
            }
        }
    }

    Err("could not find the `claude` executable on PATH (set CLAUDE_BIN to its full path)".into())
}

/// What a non-claude terminal window should run.
#[derive(Clone, Copy)]
pub enum TerminalKind {
    /// The user's login shell — full environment, full permissions.
    Shell,
    /// Attach to (or create) a persistent tmux session, falling back to a plain
    /// login shell when tmux isn't installed.
    Tmux,
}

impl TerminalKind {
    /// Parse the `kind` string passed from the frontend. Anything unrecognized
    /// (including "shell") maps to a plain login shell.
    pub fn parse(s: &str) -> Self {
        match s {
            "tmux" => TerminalKind::Tmux,
            _ => TerminalKind::Shell,
        }
    }
}

/// tmux session name for the attach-or-create terminal. A fixed name means every
/// tmux terminal window (re)attaches to the same persistent session.
const TMUX_SESSION: &str = "claude-view";

/// Probe PATH (+ common GUI-launch locations) for an executable by name.
#[cfg(not(windows))]
fn find_bin(name: &str) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    dirs.push("/opt/homebrew/bin".into());
    dirs.push("/usr/local/bin".into());
    dirs.into_iter().map(|d| d.join(name)).find(|c| c.is_file())
}

/// The user's login shell. GUI apps inherit a minimal env, so fall back to a
/// sane per-platform default when `$SHELL` is unset.
#[cfg(not(windows))]
fn login_shell() -> PathBuf {
    std::env::var_os("SHELL")
        .map(PathBuf::from)
        .filter(|p| p.is_file())
        .unwrap_or_else(|| PathBuf::from("/bin/sh"))
}

/// Build the command a terminal window runs. A *login* shell is used so the
/// user's full environment (PATH, etc.) loads — a plain PTY child of a GUI app
/// otherwise gets a bare env, which is what "all the permissions" comes down to
/// in practice. Tmux mode execs `tmux new-session -A` *through* that login shell
/// so the session persists across window closes and reattaches next time.
#[cfg(not(windows))]
fn terminal_command(kind: TerminalKind) -> CommandBuilder {
    let shell = login_shell();
    let mut cmd = CommandBuilder::new(&shell);
    match kind {
        TerminalKind::Tmux if find_bin("tmux").is_some() => {
            // Login shell sets up env, then hands the tty to tmux (attach or create).
            cmd.arg("-l");
            cmd.arg("-c");
            cmd.arg(format!("exec tmux new-session -A -s {TMUX_SESSION}"));
        }
        _ => {
            // Interactive login shell — a PTY tty makes it interactive.
            cmd.arg("-l");
        }
    }
    cmd
}

/// Windows has no tmux; a terminal window is always the shell. Prefer PowerShell,
/// then COMSPEC (usually cmd.exe).
#[cfg(windows)]
fn terminal_command(_kind: TerminalKind) -> CommandBuilder {
    let shell = std::env::var_os("COMSPEC")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("cmd.exe"));
    // powershell if present on PATH, else the COMSPEC shell.
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let ps = dir.join("powershell.exe");
            if ps.is_file() {
                return CommandBuilder::new(ps);
            }
        }
    }
    CommandBuilder::new(shell)
}

/// Open a PTY, spawn `cmd` inside it, register a `Session`, and start the
/// reader + writer + waiter threads. Shared by [`spawn_session`] (claude) and
/// [`spawn_terminal`] (shell/tmux). The caller supplies a fully-built command
/// (args + any process-specific env already set) and the `viewer_id` so
/// claude can inject it as `CLAUDE_VIEW_ID` before the child is spawned. Only
/// `TERM`/`COLORTERM`, cwd, and the size are applied here.
fn spawn_in_pty(
    registry: &Arc<Registry>,
    viewer_id: String,
    cwd: String,
    mut cmd: CommandBuilder,
    seed_session_id: Option<String>,
    is_terminal: bool,
) -> Result<Arc<Session>, String> {
    if !std::path::Path::new(&cwd).is_dir() {
        return Err(format!("working directory does not exist: {cwd}"));
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 34,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("failed to spawn child process: {e}"))?;
    // Close our copy of the slave so reads hit EOF when the child exits.
    drop(pair.slave);

    let killer = child.clone_killer();

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("pty reader: {e}"))?;
    let mut writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("pty writer: {e}"))?;

    let (bytes_tx, _) = broadcast::channel::<Vec<u8>>(8192);
    let (control_tx, _) = broadcast::channel::<String>(256);
    let (writer_tx, writer_rx) = std::sync::mpsc::channel::<Vec<u8>>();

    let spawned_at = crate::session::now_ms();
    let session = Arc::new(Session {
        viewer_id,
        cwd,
        spawned_at,
        session_id: RwLock::new(seed_session_id),
        writer_tx,
        master: Mutex::new(pair.master),
        killer: Mutex::new(Some(killer)),
        bytes_tx,
        control_tx,
        scrollback: Mutex::new(Vec::new()),
        timeline: Mutex::new(Vec::new()),
        model: RwLock::new(None),
        usage: RwLock::new(None),
        is_terminal,
        ended: Default::default(),
        exit_code: RwLock::new(None),
    });
    registry.insert(session.clone());

    // Writer thread: drains queued keystrokes to the PTY. Blocking writes live
    // here, never on the async runtime. Exits when the sender is dropped.
    std::thread::spawn(move || {
        use std::io::Write;
        while let Ok(data) = writer_rx.recv() {
            if writer.write_all(&data).is_err() || writer.flush().is_err() {
                break;
            }
        }
    });

    // Reader thread: forward every chunk as it arrives.
    let reader_session = session.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => reader_session.push_bytes(&buf[..n]),
            }
        }
    });

    // Waiter thread: mark the session ended when the child exits.
    let wait_session = session.clone();
    std::thread::spawn(move || {
        let code = child
            .wait()
            .map(|status| status.exit_code() as i64)
            .unwrap_or(-1);
        // Child is reaped — drop the killer so we never signal a recycled pid.
        *wait_session.killer.lock() = None;
        wait_session.mark_ended(code);
    });

    Ok(session)
}

/// Spawn `claude` inside a fresh PTY, register the session, and start the
/// reader + waiter threads plus a transcript tailer. Raw master bytes are
/// forwarded chunk-by-chunk (never line-buffered) to every connected
/// WebSocket — this is the live mirror.
pub fn spawn_session(
    registry: &Arc<Registry>,
    port: u16,
    token: &str,
    cwd: String,
    resume: Option<String>,
    continue_last: bool,
) -> Result<Arc<Session>, String> {
    let claude_bin = resolve_claude_bin()?;
    let viewer_id = Uuid::new_v4().to_string();

    let mut cmd = CommandBuilder::new(claude_bin);
    // Every session launched from this app runs with permission prompts off —
    // the user's standing choice for their own machine.
    cmd.arg("--dangerously-skip-permissions");
    // Reopen an existing conversation instead of starting fresh:
    // --resume <id> targets a specific session, --continue the most recent
    // one in this cwd.
    let resume_id = resume
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if let Some(id) = &resume_id {
        cmd.arg("--resume");
        cmd.arg(id);
    } else if continue_last {
        cmd.arg("--continue");
    }
    cmd.env("CLAUDE_VIEW_ID", &viewer_id);
    cmd.env("CLAUDE_VIEW_PORT", port.to_string());
    // NOTE: the auth token is deliberately NOT injected into the child env —
    // every process Claude spawns would inherit it (readable via `env`,
    // /proc/<pid>/environ, etc.). The bridge script reads the token from the
    // 0600 instance.json instead. `token` is kept in the signature for the
    // /bind + port wiring but not exported here.
    let _ = token;

    let session = spawn_in_pty(registry, viewer_id, cwd.clone(), cmd, resume_id, false)?;

    // Transcript tailer thread: reads Claude Code's session JSONL and merges
    // tool calls into the timeline. Works with hooks OFF and provides persistent
    // history; deduped against hook events by tool-use id. Holds only a Weak ref
    // so it never keeps an ended/removed session alive.
    let weak = Arc::downgrade(&session);
    let mut tailer = crate::transcript::Tailer::new(
        cwd,
        session.session_id.read().clone(),
        session.spawned_at,
    );
    std::thread::spawn(move || {
        let mut post_end_polls = 0;
        loop {
            let Some(session) = weak.upgrade() else { break };
            if let Some(sid) = session.session_id.read().clone() {
                tailer.set_session_id(&sid);
            }
            for rec in tailer.poll() {
                match rec {
                    // Model changes push a control frame (deduped) so viewers
                    // reflect the session's real model, self-correcting if a
                    // switch was declined at the CLI confirmation prompt.
                    crate::transcript::Record::Model { model } => {
                        let changed = session.model.read().as_deref() != Some(&model);
                        if changed {
                            *session.model.write() = Some(model.clone());
                            session.send_control(
                                serde_json::json!({ "type": "model", "model": model }),
                            );
                        }
                    }
                    crate::transcript::Record::Usage { input, output } => {
                        let usage = crate::session::ContextUsage { input, output };
                        *session.usage.write() = Some(usage);
                        session.send_control(serde_json::json!({
                            "type": "usage", "input": input, "output": output
                        }));
                    }
                    rec => {
                        if let Some(event) = session.apply_transcript(rec) {
                            session.send_control(
                                serde_json::json!({ "type": "timeline", "event": event }),
                            );
                        }
                    }
                }
            }
            // Poll a few more times after exit to catch the final flush, then stop.
            if session.is_ended() {
                post_end_polls += 1;
                if post_end_polls > 3 {
                    break;
                }
            }
            drop(session);
            std::thread::sleep(std::time::Duration::from_millis(1500));
        }
    });

    Ok(session)
}

/// Spawn a plain terminal (login shell, or tmux attach-or-create) inside a fresh
/// PTY and register it. Unlike [`spawn_session`] this runs no claude, injects no
/// `CLAUDE_VIEW_*` env (so a `claude` launched *inside* it starts its own,
/// independent viewer), and starts no transcript tailer — it's a straight live
/// mirror of a real terminal with the user's full permissions.
pub fn spawn_terminal(
    registry: &Arc<Registry>,
    cwd: String,
    kind: TerminalKind,
) -> Result<Arc<Session>, String> {
    let viewer_id = Uuid::new_v4().to_string();
    let cmd = terminal_command(kind);
    spawn_in_pty(registry, viewer_id, cwd, cmd, None, true)
}

pub fn resize(session: &Session, cols: u16, rows: u16) {
    let _ = session.master.lock().resize(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Poll `cond` until true or `timeout_ms` elapses. Returns the final value.
    fn wait_for<F: Fn() -> bool>(cond: F, timeout_ms: u64) -> bool {
        let start = std::time::Instant::now();
        while (start.elapsed().as_millis() as u64) < timeout_ms {
            if cond() {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        cond()
    }

    fn scrollback_string(s: &Session) -> String {
        String::from_utf8_lossy(&s.scrollback.lock()).into_owned()
    }

    fn temp_cwd() -> String {
        std::env::temp_dir().to_string_lossy().into_owned()
    }

    /// The shared spawn path must mirror a child's stdout into scrollback and
    /// mark the session ended when the child exits. Uses a one-shot command so
    /// it's deterministic (no interactive shell timing).
    #[test]
    fn spawn_in_pty_mirrors_output_and_marks_ended() {
        let registry = Arc::new(Registry::default());
        let marker = "cv_marker_7391";

        #[cfg(not(windows))]
        let cmd = {
            let mut c = CommandBuilder::new("/bin/sh");
            c.arg("-c");
            c.arg(format!("printf '{marker}\\n'"));
            c
        };
        #[cfg(windows)]
        let cmd = {
            let mut c = CommandBuilder::new("cmd.exe");
            c.arg("/C");
            c.arg(format!("echo {marker}"));
            c
        };

        let session = spawn_in_pty(&registry, "vid-test".into(), temp_cwd(), cmd, None, true)
            .expect("spawn_in_pty should succeed");

        assert!(session.is_terminal, "flagged as a terminal");
        assert!(wait_for(|| session.is_ended(), 5000), "child should exit");
        assert!(
            wait_for(|| scrollback_string(&session).contains(marker), 5000),
            "scrollback should mirror the child's stdout; got {:?}",
            scrollback_string(&session)
        );
        session.kill();
    }

    /// spawn_terminal must launch a real (interactive) login shell that we can
    /// drive: input written to the PTY comes back through the mirror. It carries
    /// no session_id (no claude/transcript) and is flagged as a terminal.
    #[test]
    fn spawn_terminal_shell_round_trips_io() {
        let registry = Arc::new(Registry::default());
        let session =
            spawn_terminal(&registry, temp_cwd(), TerminalKind::Shell).expect("spawn_terminal");

        assert!(session.is_terminal);
        assert!(session.session_id.read().is_none(), "no claude session id");

        let marker = "cv_shell_5521";
        session.write_input(format!("printf '{marker}\\n'\n").into_bytes());
        let seen = wait_for(|| scrollback_string(&session).contains(marker), 8000);

        // Clean up the interactive shell regardless of the assertion outcome.
        session.write_input(b"exit\n".to_vec());
        session.kill();

        assert!(
            seen,
            "driving the shell should surface the marker in the mirror; got {:?}",
            scrollback_string(&session)
        );
    }

    /// TerminalKind::parse maps "tmux" precisely and treats everything else
    /// (including "shell" and junk) as a plain login shell.
    #[test]
    fn terminal_kind_parse_defaults_to_shell() {
        assert!(matches!(TerminalKind::parse("tmux"), TerminalKind::Tmux));
        assert!(matches!(TerminalKind::parse("shell"), TerminalKind::Shell));
        assert!(matches!(TerminalKind::parse("nonsense"), TerminalKind::Shell));
        assert!(matches!(TerminalKind::parse(""), TerminalKind::Shell));
    }
}
