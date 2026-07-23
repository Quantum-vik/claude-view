use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;

use parking_lot::{Mutex, RwLock};
use portable_pty::{ChildKiller, MasterPty};
use serde::Serialize;
use tokio::sync::broadcast;

/// Bytes of raw PTY output retained per session for replay when a viewer
/// (re)connects. xterm.js re-renders this instantly, so a window opened or
/// refreshed mid-session still shows history.
pub const SCROLLBACK_CAP: usize = 2 * 1024 * 1024;

#[derive(Clone, Serialize)]
pub struct TimelineEvent {
    pub id: String,
    pub kind: String,
    pub tool: String,
    pub command: Option<String>,
    pub status: String,
    #[serde(rename = "durationMs")]
    pub duration_ms: Option<u64>,
    pub ts: u64,
    /// Captured tool result (truncated) from PostToolUse, shown when a
    /// timeline card is expanded.
    pub output: Option<String>,
}

pub struct Session {
    pub viewer_id: String,
    pub cwd: String,
    /// When the PTY was spawned (epoch ms) — used to locate this session's
    /// transcript file among all projects.
    pub spawned_at: u64,
    pub session_id: RwLock<Option<String>>,
    /// Keystrokes from viewers go here; a dedicated writer thread owns the PTY
    /// writer and drains this channel, so blocking PTY writes never run on the
    /// async runtime.
    pub writer_tx: mpsc::Sender<Vec<u8>>,
    /// PTY master, kept for resize().
    pub master: Mutex<Box<dyn MasterPty + Send>>,
    /// Kills the child on app shutdown so `claude` isn't orphaned.
    pub killer: Mutex<Option<Box<dyn ChildKiller + Send + Sync>>>,
    /// Raw PTY output fan-out to all connected viewers (binary WS frames).
    pub bytes_tx: broadcast::Sender<Vec<u8>>,
    /// Control/timeline fan-out (text WS frames, JSON strings).
    pub control_tx: broadcast::Sender<String>,
    pub scrollback: Mutex<Vec<u8>>,
    pub timeline: Mutex<Vec<TimelineEvent>>,
    /// Actual current model (full id, e.g. "claude-opus-4-8"), read from the
    /// transcript. None until the first assistant turn is observed.
    pub model: RwLock<Option<String>>,
    /// Latest context-window usage (input/output tokens) from the transcript.
    pub usage: RwLock<Option<ContextUsage>>,
    /// True for a plain shell/tmux terminal (no claude, no transcript). Lets the
    /// viewer drop the claude-only chrome (timeline, model switcher, context
    /// meter) and lets the backend rebuild the right window URL on reopen.
    pub is_terminal: bool,
    pub ended: AtomicBool,
    pub exit_code: RwLock<Option<i64>>,
}

/// Token usage for the context meter. `input` = context-window occupancy
/// (prompt + cache), `output` = tokens generated on the latest turn.
#[derive(Serialize, Clone, Copy)]
pub struct ContextUsage {
    pub input: u64,
    pub output: u64,
}

impl Session {
    /// Merge a tool event parsed from the transcript into the timeline. Deduped
    /// by tool-use id, so hook-derived cards (which use the same ids and arrive
    /// live) take precedence and transcript records only fill gaps. Returns the
    /// event to broadcast, or None if nothing changed.
    pub fn apply_transcript(&self, rec: crate::transcript::Record) -> Option<TimelineEvent> {
        use crate::transcript::Record;
        let mut timeline = self.timeline.lock();
        match rec {
            Record::Start { id, tool, command, ts } => {
                if timeline.iter().any(|e| e.id == id) {
                    return None; // already known (hook or earlier poll)
                }
                let event = TimelineEvent {
                    id,
                    kind: "command".into(),
                    tool,
                    command,
                    status: "running".into(),
                    duration_ms: None,
                    ts,
                    output: None,
                };
                timeline.push(event.clone());
                Some(event)
            }
            Record::End { id, is_error, output, ts } => {
                let entry = timeline.iter_mut().find(|e| e.id == id)?;
                // Don't override a card hooks already resolved live.
                if entry.status != "running" {
                    return None;
                }
                entry.status = if is_error { "error" } else { "success" }.into();
                entry.duration_ms = Some(ts.saturating_sub(entry.ts));
                entry.output = output;
                Some(entry.clone())
            }
            // Model and Usage records are handled by the tailer thread, not
            // the timeline.
            Record::Model { .. } | Record::Usage { .. } => None,
        }
    }

    /// Queue keystrokes for the PTY writer thread. Non-blocking; a dead
    /// session (writer thread gone) drops the input silently.
    pub fn write_input(&self, data: Vec<u8>) {
        if !self.is_ended() {
            let _ = self.writer_tx.send(data);
        }
    }

    pub fn push_bytes(&self, chunk: &[u8]) {
        {
            let mut sb = self.scrollback.lock();
            sb.extend_from_slice(chunk);
            if sb.len() > SCROLLBACK_CAP {
                let cut = sb.len() - SCROLLBACK_CAP;
                sb.drain(..cut);
            }
        }
        let _ = self.bytes_tx.send(chunk.to_vec());
    }

    pub fn send_control(&self, value: serde_json::Value) {
        let _ = self.control_tx.send(value.to_string());
    }

    pub fn is_ended(&self) -> bool {
        // Acquire pairs with the Release in mark_ended so a reader that sees
        // `true` also sees the exit_code written just before.
        self.ended.load(Ordering::Acquire)
    }

    pub fn mark_ended(&self, code: i64) {
        *self.exit_code.write() = Some(code);
        self.ended.store(true, Ordering::Release);
        self.send_control(serde_json::json!({ "type": "exit", "code": code }));
    }

    /// Terminate the child process (best effort). Used on app shutdown.
    pub fn kill(&self) {
        if let Some(killer) = self.killer.lock().as_mut() {
            let _ = killer.kill();
        }
    }
}

#[derive(Serialize, Clone)]
pub struct SessionInfo {
    pub viewer_id: String,
    pub session_id: Option<String>,
    pub cwd: String,
    pub ended: bool,
    pub is_terminal: bool,
}

#[derive(Default)]
pub struct Registry {
    /// viewer_id -> session
    sessions: RwLock<HashMap<String, Arc<Session>>>,
    /// session_id -> viewer_id (populated on /bind)
    by_session_id: RwLock<HashMap<String, String>>,
}

impl Registry {
    pub fn insert(&self, session: Arc<Session>) {
        self.sessions
            .write()
            .insert(session.viewer_id.clone(), session);
    }

    /// Look up by viewer_id or session_id. Holds the `sessions` read lock for
    /// both lookups so it's race-free against concurrent removal.
    pub fn get(&self, id: &str) -> Option<Arc<Session>> {
        let sessions = self.sessions.read();
        if let Some(s) = sessions.get(id) {
            return Some(s.clone());
        }
        let vid = self.by_session_id.read().get(id).cloned()?;
        sessions.get(&vid).cloned()
    }

    /// Remove a session and its session_id index entry. Returns it so the
    /// caller can tear it down (kill child, etc.).
    pub fn remove(&self, viewer_id: &str) -> Option<Arc<Session>> {
        let session = self.sessions.write().remove(viewer_id)?;
        if let Some(sid) = session.session_id.read().clone() {
            self.by_session_id.write().remove(&sid);
        }
        Some(session)
    }

    /// Snapshot of all live sessions, for shutdown cleanup.
    pub fn all(&self) -> Vec<Arc<Session>> {
        self.sessions.read().values().cloned().collect()
    }

    pub fn bind(&self, viewer_id: &str, session_id: &str) -> Option<Arc<Session>> {
        let session = self.sessions.read().get(viewer_id).cloned()?;
        *session.session_id.write() = Some(session_id.to_string());
        self.by_session_id
            .write()
            .insert(session_id.to_string(), viewer_id.to_string());
        Some(session)
    }

    pub fn list(&self) -> Vec<SessionInfo> {
        self.sessions
            .read()
            .values()
            .map(|s| SessionInfo {
                viewer_id: s.viewer_id.clone(),
                session_id: s.session_id.read().clone(),
                cwd: s.cwd.clone(),
                ended: s.is_ended(),
                is_terminal: s.is_terminal,
            })
            .collect()
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
