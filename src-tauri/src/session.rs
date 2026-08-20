use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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

/// How far past [`SCROLLBACK_CAP`] the buffer is allowed to grow before it is
/// compacted. Trimming on every push memmoves the whole 2 MiB buffer per 8 KiB
/// read (~250x write amplification, the worst CPU cliff in the app); trimming
/// only once we're this far over turns that into one memmove per ~32 reads.
const SCROLLBACK_SLACK: usize = 256 * 1024;

/// Cap on how far we'll scan for a line boundary when compacting scrollback, so
/// output with no newlines (a progress bar redrawing with \r) can't make the
/// trim O(buffer).
const NEWLINE_SCAN_LIMIT: usize = 64 * 1024;

/// Timeline cards retained per session. The whole list is cloned into a single
/// JSON frame on every WebSocket connect, so an unbounded timeline makes each
/// reconnect progressively more expensive on a long-running session.
pub const TIMELINE_CAP: usize = 5000;

/// Cap on a card's `command` string. `extract_output` already caps results;
/// without this a multi-megabyte heredoc is retained verbatim, forever.
pub const COMMAND_CAP: usize = 2048;

/// What the agent in a session is doing right now.
///
/// Unlike herdr — which infers this by scraping spinner glyphs and footer
/// strings out of the terminal, and pays for it with a permanent stream of
/// detection regressions — every transition here comes from a Claude Code hook
/// event, i.e. from the agent's own process. It is ground truth, not a guess.
///
/// `Unknown` is not a failure mode to fix: plain terminals never emit hooks
/// (see [`Session::is_terminal`]), and neither does a claude session started
/// before hooks were installed.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentState {
    /// No hook has ever arrived — hooks are off, or this is a plain terminal.
    Unknown,
    /// Waiting on you: the turn is over, or nothing has started yet.
    Idle,
    /// Mid-turn — thinking, or running a tool.
    Working,
    /// Stopped and needs a human answer (permission prompt, plan approval).
    Blocked,
}

impl AgentState {
    /// Stable string for the wire; the frontend switches on this.
    pub fn as_str(self) -> &'static str {
        match self {
            AgentState::Unknown => "unknown",
            AgentState::Idle => "idle",
            AgentState::Working => "working",
            AgentState::Blocked => "blocked",
        }
    }
}

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
    /// What the agent is doing, derived from hook events. See [`AgentState`].
    pub state: RwLock<AgentState>,
    /// Which blocking dialog the *viewer* currently sees on screen (`"trust"`,
    /// `"permission"`, `"plan"`, `"choice"`), or `None` when the screen is clear.
    ///
    /// Deliberately a second variable rather than a write into [`Self::state`]:
    /// the two sources are blind to different things and would otherwise
    /// overwrite each other. Hooks are ground truth for turn *boundaries* and
    /// see no dialogs at all — a session parked on "Do you trust this folder?"
    /// emits no hook and reports `idle`. The screen sees dialogs and nothing
    /// else — it can't tell thinking from finished. Merged, never mixed, by
    /// [`merge_state`].
    pub screen_blocked: RwLock<Option<String>>,
    /// Epoch ms of the last accepted transition — "working for 4m".
    pub state_since: AtomicU64,
    /// Bumped on every real transition. Lets a viewer distinguish "still
    /// Working" from "Working again" without diffing, and gives a future
    /// wait-until-idle endpoint something to resume from.
    pub state_seq: AtomicU64,
    /// Timestamp of the most recent *accepted* state report. The bridge script
    /// fires a backgrounded `curl` per hook with no ordering guarantee, so a
    /// slow PreToolUse can land after the Stop that followed it; anything older
    /// than this is dropped rather than applied out of order.
    pub last_state_ts: AtomicU64,
    /// Timeline cards dropped by the [`TIMELINE_CAP`] eviction, so the viewer
    /// can say "N earlier commands" instead of silently pretending they never
    /// happened.
    pub timeline_elided: AtomicU64,
    /// git identity of `cwd`, resolved once at spawn (a session's cwd never
    /// changes). `None` when cwd isn't in a repo.
    pub repo: Option<crate::git::RepoInfo>,
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
            Record::Start {
                id,
                tool,
                command,
                ts,
            } => {
                if timeline.iter().any(|e| e.id == id) {
                    return None; // already known (hook or earlier poll)
                }
                let event = TimelineEvent {
                    id,
                    kind: "command".into(),
                    tool,
                    command: command.map(|c| cap_command(&c)),
                    status: "running".into(),
                    duration_ms: None,
                    ts,
                    output: None,
                };
                let dropped = push_timeline(&mut timeline, event.clone());
                drop(timeline);
                self.note_elided(dropped);
                Some(event)
            }
            Record::End {
                id,
                is_error,
                output,
                ts,
            } => {
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
            // Compact only once we're SLACK over the cap — see SCROLLBACK_SLACK.
            if sb.len() > SCROLLBACK_CAP + SCROLLBACK_SLACK {
                let mut cut = sb.len() - SCROLLBACK_CAP;
                // Advance past the next newline so the replay a viewer receives
                // never begins mid-UTF-8 or mid-escape-sequence (which xterm.js
                // would render as mojibake or swallow as a partial CSI).
                let limit = (cut + NEWLINE_SCAN_LIMIT).min(sb.len());
                if let Some(nl) = sb[cut..limit].iter().position(|&b| b == b'\n') {
                    cut += nl + 1;
                }
                sb.drain(..cut);
            }
        }
        let _ = self.bytes_tx.send(chunk.to_vec());
    }

    /// Record a state transition reported by a hook.
    ///
    /// Ignores no-ops and out-of-order reports; broadcasts only on a real
    /// change. Deliberately has none of herdr's confirmation hold or startup
    /// grace period (`herdr/src/pane/agent_detection.rs`) — those debounce
    /// screen-scrape flicker, and discrete hook events don't flicker.
    ///
    /// "A real change" means a change to the [`Self::effective_state`], not to
    /// the hook state: with a dialog on screen a `Stop` moves this session from
    /// Working to Idle internally while viewers correctly keep seeing Blocked,
    /// and announcing that would only reset their "blocked for 2m" clock.
    pub fn set_state(&self, next: AgentState, reason: &str, ts: u64) {
        // Plain terminals never receive hooks; anything arriving for one is
        // misrouted. Keep them Unknown so they stay out of every aggregate.
        if self.is_terminal {
            return;
        }
        // Snapshot what viewers believe *before* touching anything, so the
        // broadcast below can be gated on what they'd actually see change. With
        // no dialog on screen this is exactly the hook state and the whole
        // function behaves as it always did.
        let before = self.effective_state();
        {
            let mut current = self.state.write();
            let prev_ts = self.last_state_ts.load(Ordering::Acquire);
            if ts < prev_ts {
                return; // stale report; a newer one already won
            }
            self.last_state_ts.store(ts, Ordering::Release);
            *current = next;
        }
        // If Claude is working, nothing is blocking it — whatever dialog the
        // screen last reported has been answered. This is the rule that makes
        // "user approved the prompt, Claude carried on" resolve on its own, with
        // no `blocked:false` from the webview: the window may well be closed,
        // and a session stuck red forever is worse than one that's briefly late.
        //
        // Note this runs even when the hook state didn't move (PostToolUse after
        // PreToolUse is Working -> Working), which is precisely the transition a
        // permission prompt is answered on.
        if next == AgentState::Working {
            *self.screen_blocked.write() = None;
        }
        let after = self.effective_state();
        if after == before {
            return; // no-op: don't bump the seq or wake every viewer
        }
        self.state_since.store(ts, Ordering::Release);
        let seq = self.state_seq.fetch_add(1, Ordering::AcqRel) + 1;
        self.send_control(serde_json::json!({
            "type": "agent_state",
            "state": after.as_str(),
            "reason": reason,
            "seq": seq,
            "since": ts,
        }));
    }

    /// Record whether the viewer can see a blocking dialog right now.
    ///
    /// The webview has a fully parsed screen (xterm.js) and we have raw bytes,
    /// so it — not the backend — decides what a dialog looks like. Sent
    /// edge-triggered over the session WebSocket, plus once per reconnect.
    ///
    /// **No timestamp, deliberately.** [`Self::set_state`] needs one because the
    /// hook bridge backgrounds a `curl` per event, so arrival order isn't send
    /// order and a slow `PreToolUse` can land after the `Stop` that followed it.
    /// Dialog reports have neither problem: they arrive in order on one TCP
    /// connection, and they describe the screen *now* rather than an event that
    /// happened at some past instant — a report has no timestamp of its own to
    /// carry. So there's nothing to compare against and nothing to drop;
    /// [`Self::last_state_ts`] is left untouched on purpose, since stamping it
    /// here would start discarding genuinely newer hooks.
    pub fn set_screen_blocked(&self, kind: Option<String>) {
        // A plain shell showing `git rebase -i`'s pick-list is not a blocked
        // agent — and terminals have no agent to block. Ignore them outright so
        // the flag can never be set for one.
        if self.is_terminal {
            return;
        }
        {
            let mut current = self.screen_blocked.write();
            if *current == kind {
                return; // no-op: don't bump the seq or wake every viewer
            }
            *current = kind;
        }
        // Compute the merge only after dropping the write guard: parking_lot's
        // RwLock isn't reentrant, so reading it again here would deadlock.
        let effective = self.effective_state();
        let ts = now_ms();
        self.state_since.store(ts, Ordering::Release);
        let seq = self.state_seq.fetch_add(1, Ordering::AcqRel) + 1;
        self.send_control(serde_json::json!({
            "type": "agent_state",
            "state": effective.as_str(),
            "reason": "screen",
            "seq": seq,
            "since": ts,
        }));
    }

    /// Raw hook state, ignoring anything the screen reports. Prefer
    /// [`Self::effective_state`] for anything a human will see.
    pub fn agent_state(&self) -> AgentState {
        *self.state.read()
    }

    /// What the session is *actually* doing: the hook state, overridden to
    /// Blocked while a dialog is on screen. See [`merge_state`].
    pub fn effective_state(&self) -> AgentState {
        // Clone the kind out on its own line so that read guard is released
        // before `agent_state` takes the other lock. Nothing in here — and
        // nothing that calls it — ever holds two of these locks at once.
        let screen = self.screen_blocked.read().clone();
        merge_state(self.agent_state(), screen.as_deref(), self.is_terminal)
    }

    /// Record cards dropped by [`push_timeline`] so the viewer can say
    /// "N earlier commands" rather than silently pretending they never happened.
    pub fn note_elided(&self, dropped: u64) {
        if dropped > 0 {
            self.timeline_elided.fetch_add(dropped, Ordering::Relaxed);
        }
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

    /// The single place a [`SessionInfo`] is built.
    ///
    /// Every caller routes through here — `Registry::list`, and the two
    /// post-spawn returns in main.rs — so adding a field can't silently leave
    /// the launcher's optimistic card missing it.
    pub fn info(&self) -> SessionInfo {
        // One read of each source, shared by the merge and the label below, so
        // `state: blocked` can't be reported next to a `blocked_kind: null` that
        // a concurrent dismissal snuck in between two reads.
        let screen = self.screen_blocked.read().clone();
        let hook = *self.state.read();
        SessionInfo {
            viewer_id: self.viewer_id.clone(),
            session_id: self.session_id.read().clone(),
            cwd: self.cwd.clone(),
            ended: self.is_ended(),
            is_terminal: self.is_terminal,
            state: merge_state(hook, screen.as_deref(), self.is_terminal),
            blocked_kind: screen.filter(|_| !self.is_terminal),
            state_seq: self.state_seq.load(Ordering::Acquire),
            state_since: self.state_since.load(Ordering::Acquire),
            repo_key: self.repo.as_ref().map(|r| r.repo_key.clone()),
            repo_name: self.repo.as_ref().map(|r| r.repo_name.clone()),
            checkout_name: self.repo.as_ref().map(|r| r.checkout_name.clone()),
            is_linked_worktree: self.repo.as_ref().is_some_and(|r| r.is_linked_worktree),
            // Read fresh rather than cached: the user can switch branches under
            // a live session, and HEAD is a ~41-byte page-cached file.
            branch: self
                .repo
                .as_ref()
                .and_then(|r| crate::git::head_branch(&r.git_dir)),
        }
    }
}

/// Append a timeline card, evicting the oldest *settled* cards past
/// [`TIMELINE_CAP`]. Returns how many were dropped.
///
/// Running cards are exempt from eviction on purpose: `PostToolUse` matches its
/// card by id, and dropping a still-running one makes the Post create a
/// duplicate (with no duration) instead of resolving the original — while the
/// transcript path would drop it entirely, so the two producers would disagree.
///
/// Free function, not a method: it keeps the hook-correlation logic in server.rs
/// testable against a plain `Vec` instead of a `Session` that owns a live PTY.
pub fn push_timeline(timeline: &mut Vec<TimelineEvent>, event: TimelineEvent) -> u64 {
    timeline.push(event);
    if timeline.len() <= TIMELINE_CAP {
        return 0;
    }
    let mut budget = timeline.len() - TIMELINE_CAP;
    let before = timeline.len();
    timeline.retain(|e| {
        if budget > 0 && e.status != "running" {
            budget -= 1;
            false
        } else {
            true
        }
    });
    (before - timeline.len()) as u64
}

/// Merge the two independent state sources into the one state a human sees.
///
/// Precedence, highest first:
///
/// | `is_terminal` | `screen` | result            |
/// |---------------|----------|-------------------|
/// | true          | any      | `hook` (`Unknown`)|
/// | false         | `Some`   | `Blocked`         |
/// | false         | `None`   | `hook`            |
///
/// **A visible dialog outranks the hook state, including `Working`.** A dialog
/// is direct evidence the process is parked on a human; `Working` is only
/// evidence of what the last hook said, and `PreToolUse` means "a tool started",
/// not "no prompt appeared while it ran" — a permission prompt is *precisely*
/// the thing that interrupts a tool mid-flight, so the older signal must not win.
/// The combination is short-lived by construction anyway: the next `Working`
/// hook clears `screen_blocked` outright (see [`Session::set_state`]), so it can
/// only persist while genuinely nothing is happening.
///
/// Free function, not a method: a [`Session`] owns a live PTY and can't be built
/// in a test, so the one piece of real logic here lives where it can be
/// table-tested — same reasoning as [`push_timeline`].
pub fn merge_state(hook: AgentState, screen: Option<&str>, is_terminal: bool) -> AgentState {
    // A plain shell showing `git rebase -i`'s pick-list, or fzf, or less, is not
    // a blocked agent — it isn't an agent. Terminals get no hooks either, so
    // this returns Unknown and they stay out of every aggregate.
    // Belt and braces: `Session::set_screen_blocked` already refuses to record a
    // dialog for one, so this branch is unreachable through the live path.
    if is_terminal {
        return hook;
    }
    if screen.is_some() {
        return AgentState::Blocked;
    }
    hook
}

/// Truncate a card's subject to [`COMMAND_CAP`], on a char boundary.
pub fn cap_command(s: &str) -> String {
    if s.len() <= COMMAND_CAP {
        return s.to_string();
    }
    let mut out: String = s.chars().take(COMMAND_CAP).collect();
    out.push_str(" … (truncated)");
    out
}

#[derive(Serialize, Clone)]
pub struct SessionInfo {
    pub viewer_id: String,
    pub session_id: Option<String>,
    pub cwd: String,
    pub ended: bool,
    pub is_terminal: bool,
    /// Effective agent state — the hook state, forced to `blocked` while the
    /// viewer reports a dialog on screen. See [`merge_state`]. Always `unknown`
    /// for `is_terminal` sessions.
    pub state: AgentState,
    /// Which dialog is up, when `state` is `blocked` *because of the screen*:
    /// `"trust"`, `"permission"`, `"plan"` or `"choice"`, so the UI can say why.
    /// `None` otherwise — including for a hook-derived block (a `Notification`
    /// carries no dialog kind), so this is a label, never the blocked test.
    pub blocked_kind: Option<String>,
    pub state_seq: u64,
    pub state_since: u64,
    /// git common dir — the same string for a repo and all its worktrees, so
    /// the launcher groups them together. `None` when cwd isn't in a repo (or
    /// no longer exists), in which case callers fall back to grouping by cwd.
    pub repo_key: Option<String>,
    pub repo_name: Option<String>,
    pub checkout_name: Option<String>,
    pub is_linked_worktree: bool,
    /// Current branch, or `None` for a detached/reftable HEAD.
    pub branch: Option<String>,
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
        // A `--resume` session already knows its session_id before any hook
        // arrives (pty::spawn_in_pty seeds it), so index it here rather than
        // waiting for /bind. Without this the id is unresolvable during the
        // pre-bind window, which is what let two `claude --resume <same id>`
        // race the same transcript file.
        if let Some(sid) = session.session_id.read().clone() {
            self.by_session_id
                .write()
                .insert(sid, session.viewer_id.clone());
        }
        self.sessions
            .write()
            .insert(session.viewer_id.clone(), session);
    }

    /// True if some live session is already attached to this claude session id.
    /// Guards against resuming one conversation into two PTYs, which corrupts
    /// the transcript (both processes append to the same JSONL).
    pub fn has_session_id(&self, session_id: &str) -> bool {
        self.by_session_id.read().contains_key(session_id)
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
        // Claude Code can fork a NEW session id when resuming. Retire the old
        // index entry, or it keeps pointing at this viewer forever and a later
        // lookup of the stale id silently resolves to the wrong session.
        let previous = session.session_id.read().clone();
        if let Some(old) = previous.filter(|old| old != session_id) {
            self.by_session_id.write().remove(&old);
        }
        *session.session_id.write() = Some(session_id.to_string());
        self.by_session_id
            .write()
            .insert(session_id.to_string(), viewer_id.to_string());
        Some(session)
    }

    pub fn list(&self) -> Vec<SessionInfo> {
        self.sessions.read().values().map(|s| s.info()).collect()
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL_HOOK_STATES: [AgentState; 4] = [
        AgentState::Unknown,
        AgentState::Idle,
        AgentState::Working,
        AgentState::Blocked,
    ];

    /// The bug this whole mechanism exists for: a session parked on Claude
    /// Code's "Do you trust this folder?" prompt fires no hook at all, so hooks
    /// keep reporting the Idle it started in while a human sits there waiting.
    #[test]
    fn a_dialog_on_screen_blocks_an_idle_session() {
        assert_eq!(
            merge_state(AgentState::Idle, Some("trust"), false),
            AgentState::Blocked
        );
        // Every dialog kind blocks; the kind is a label for the UI, not a test.
        for kind in ["trust", "permission", "plan", "choice", "something_new"] {
            assert_eq!(
                merge_state(AgentState::Idle, Some(kind), false),
                AgentState::Blocked,
                "kind: {kind}"
            );
        }
    }

    /// The screen wins over `Working`. Justification in [`merge_state`]'s docs:
    /// a dialog is evidence about *now*, `Working` is evidence about the last
    /// hook — and a permission prompt is exactly what interrupts a running tool.
    /// Rule 5 in `set_state` (a `Working` hook clears the flag) means the pair
    /// can only coexist while no hook is firing, i.e. while nothing is happening.
    #[test]
    fn a_dialog_on_screen_outranks_a_working_hook() {
        assert_eq!(
            merge_state(AgentState::Working, Some("permission"), false),
            AgentState::Blocked
        );
    }

    #[test]
    fn a_terminal_is_never_blocked_by_whats_on_its_screen() {
        // `git rebase -i`, fzf, and `less` all paint a screen that looks like a
        // dialog. None of them is a stopped agent.
        for hook in ALL_HOOK_STATES {
            for kind in [None, Some("choice"), Some("trust")] {
                assert_eq!(
                    merge_state(hook, kind, true),
                    hook,
                    "terminal must pass {hook:?} through untouched (screen {kind:?})"
                );
            }
        }
        // In practice a terminal's hook state is Unknown for life, so this is
        // what the launcher actually sees.
        assert_eq!(
            merge_state(AgentState::Unknown, Some("choice"), true),
            AgentState::Unknown
        );
    }

    #[test]
    fn a_clear_screen_passes_every_hook_state_through_unchanged() {
        for hook in ALL_HOOK_STATES {
            assert_eq!(merge_state(hook, None, false), hook, "hook: {hook:?}");
        }
    }

    /// `SessionInfo` is serialized straight to the frontend with no serde
    /// renames, so the field names are the wire contract. Pin them.
    #[test]
    fn session_info_reports_blocked_kind_in_snake_case() {
        let info = SessionInfo {
            viewer_id: "v1".into(),
            session_id: None,
            cwd: "/tmp".into(),
            ended: false,
            is_terminal: false,
            state: merge_state(AgentState::Idle, Some("trust"), false),
            blocked_kind: Some("trust".into()),
            state_seq: 3,
            state_since: 1_700_000_000_000,
            repo_key: None,
            repo_name: None,
            checkout_name: None,
            is_linked_worktree: false,
            branch: None,
        };
        let v = serde_json::to_value(&info).unwrap();
        assert_eq!(v["state"], "blocked");
        assert_eq!(v["blocked_kind"], "trust");
        assert!(v.get("blockedKind").is_none(), "no camelCase alias exists");

        let clear = SessionInfo {
            state: AgentState::Idle,
            blocked_kind: None,
            ..info
        };
        let v = serde_json::to_value(&clear).unwrap();
        assert_eq!(v["state"], "idle");
        assert!(v["blocked_kind"].is_null());
    }
}
