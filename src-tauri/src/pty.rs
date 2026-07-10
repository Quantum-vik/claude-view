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

/// Spawn `claude` inside a fresh PTY, register the session, and start the
/// reader + waiter threads. Raw master bytes are forwarded chunk-by-chunk
/// (never line-buffered) to every connected WebSocket — this is the live mirror.
pub fn spawn_session(
    registry: &Arc<Registry>,
    port: u16,
    token: &str,
    cwd: String,
    resume: Option<String>,
    continue_last: bool,
) -> Result<Arc<Session>, String> {
    let claude_bin = resolve_claude_bin()?;
    if !std::path::Path::new(&cwd).is_dir() {
        return Err(format!("working directory does not exist: {cwd}"));
    }

    let viewer_id = Uuid::new_v4().to_string();

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 34,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    let mut cmd = CommandBuilder::new(claude_bin);
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
    cmd.cwd(&cwd);
    cmd.env("CLAUDE_VIEW_ID", &viewer_id);
    cmd.env("CLAUDE_VIEW_PORT", port.to_string());
    // NOTE: the auth token is deliberately NOT injected into the child env —
    // every process Claude spawns would inherit it (readable via `env`,
    // /proc/<pid>/environ, etc.). The bridge script reads the token from the
    // 0600 instance.json instead. `token` is kept in the signature for the
    // /bind + port wiring but not exported here.
    let _ = token;
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("failed to spawn claude: {e}"))?;
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
        viewer_id: viewer_id.clone(),
        cwd: cwd.clone(),
        spawned_at,
        // For a --resume, we already know the exact session id, so the
        // transcript tailer binds to that file directly (no cwd guessing).
        session_id: RwLock::new(resume_id.clone()),
        writer_tx,
        master: Mutex::new(pair.master),
        killer: Mutex::new(Some(killer)),
        bytes_tx,
        control_tx,
        scrollback: Mutex::new(Vec::new()),
        timeline: Mutex::new(Vec::new()),
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

    // Waiter thread: mark the session ended when claude exits.
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

    // Transcript tailer thread: reads Claude Code's session JSONL and merges
    // tool calls into the timeline. Works with hooks OFF and provides persistent
    // history; deduped against hook events by tool-use id. Holds only a Weak ref
    // so it never keeps an ended/removed session alive.
    let weak = Arc::downgrade(&session);
    let mut tailer = crate::transcript::Tailer::new(
        cwd,
        session.session_id.read().clone(),
        spawned_at,
    );
    std::thread::spawn(move || {
        let mut post_end_polls = 0;
        loop {
            let Some(session) = weak.upgrade() else { break };
            if let Some(sid) = session.session_id.read().clone() {
                tailer.set_session_id(&sid);
            }
            for rec in tailer.poll() {
                if let Some(event) = session.apply_transcript(rec) {
                    session.send_control(serde_json::json!({ "type": "timeline", "event": event }));
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

pub fn resize(session: &Session, cols: u16, rows: u16) {
    let _ = session.master.lock().resize(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    });
}
