use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Arc;

use parking_lot::{Mutex, RwLock};
use portable_pty::{ChildKiller, MasterPty};
use serde::Serialize;
use tokio::sync::broadcast;

use crate::transcript::TokenUsage;

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
    pub tool: String,
    pub command: Option<String>,
    pub status: String,
    #[serde(rename = "durationMs")]
    pub duration_ms: Option<u64>,
    pub ts: u64,
    /// Captured tool result (truncated) from PostToolUse, shown when a
    /// timeline card is expanded.
    pub output: Option<String>,
    /// Which subagent produced this card, or `None` for the parent session.
    /// Without it a subagent's tool calls appear indistinguishable from the
    /// parent's — and subagents can be the majority of a session's work.
    #[serde(rename = "agentId", skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
}

/// The live half of a session: everything that exists only because a process is
/// running. Absent for a watched session.
pub struct Pty {
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
}

pub struct Session {
    pub viewer_id: String,
    pub cwd: String,
    /// When the PTY was spawned (epoch ms) — used to locate this session's
    /// transcript file among all projects.
    pub spawned_at: u64,
    pub session_id: RwLock<Option<String>>,
    /// The process behind this session, when there is one.
    ///
    /// `None` for a **watched** session: one claude-view did not launch, read
    /// from its transcript on disk (#40). Grouping the four PTY handles into one
    /// option makes a half-attached session unrepresentable — there is one place
    /// to ask whether a process exists, rather than four fields that could
    /// disagree — and it keeps the answer out of `SessionInfo`, where
    /// `is_terminal` has already taught this codebase what a spreading flag
    /// costs.
    pub pty: Option<Pty>,
    /// Control/timeline fan-out (text WS frames, JSON strings).
    pub control_tx: broadcast::Sender<String>,
    pub scrollback: Mutex<Vec<u8>>,
    pub timeline: Mutex<Vec<TimelineEvent>>,
    /// Actual current model (full id, e.g. "claude-opus-4-8"), read from the
    /// transcript. None until the first assistant turn is observed.
    pub model: RwLock<Option<String>>,
    /// Latest context-window usage (input/output tokens) from the transcript.
    pub usage: RwLock<Option<ContextUsage>>,
    /// De-duplicated per-turn usage for the whole session, parent AND
    /// subagents. Distinct from `usage` above: the meter wants the LATEST
    /// turn's occupancy, cost wants the de-duplicated SUM. Conflating them is
    /// how you get a 2x-3x cost error.
    pub ledger: Mutex<UsageLedger>,
    /// True for a plain shell/tmux terminal (no claude, no transcript). Lets the
    /// viewer drop the claude-only chrome (timeline, model switcher, context
    /// meter) and lets the backend rebuild the right window URL on reopen.
    pub is_terminal: bool,
    /// True when this session's `claude` was launched with
    /// `--dangerously-skip-permissions`, i.e. it runs every tool (file writes,
    /// shell commands) without stopping to ask. Decided per session by whoever
    /// launched it and fixed for the life of the process — the flag is argv, so
    /// it cannot change without a respawn. Always `false` for
    /// [`Self::is_terminal`]: a shell has no permission model to skip.
    pub skip_permissions: bool,
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
    /// git identity of `cwd`, resolved once at spawn (a session's cwd never
    /// changes). `None` when cwd isn't in a repo.
    pub repo: Option<crate::git::RepoInfo>,
}

/// One turn's usage, as the API billed it.
#[derive(Clone, Debug, Serialize)]
pub struct TurnUsage {
    pub usage: TokenUsage,
    pub model: Option<String>,
    /// Which subagent produced it; `None` for the parent session.
    #[serde(rename = "agentId", skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
}

/// Aggregated usage for one model, because prices are per model.
#[derive(Clone, Debug, Serialize)]
pub struct ModelTotal {
    pub model: String,
    pub turns: usize,
    pub usage: TokenUsage,
}

/// What the viewer needs to turn tokens into money.
///
/// Deliberately carries **no dollar figure**: the price table lives in
/// `src/pricing.ts` with its own `AS_OF` date, and duplicating it here would
/// give the app two sources of truth for money that could disagree.
#[derive(Clone, Debug, Default, Serialize)]
pub struct CostRollup {
    pub turns: usize,
    #[serde(rename = "subagentTurns")]
    pub subagent_turns: usize,
    #[serde(rename = "byModel")]
    pub by_model: Vec<ModelTotal>,
    pub total: TokenUsage,
    /// The subagent share, which is routinely the majority — measured at 64.2%
    /// of one real session. Surfaced separately so it cannot hide inside the
    /// total.
    #[serde(rename = "subagentTotal")]
    pub subagent_total: TokenUsage,
}

/// De-duplicated per-turn usage across a whole session: parent and subagents.
///
/// Claude Code writes ONE RECORD PER CONTENT BLOCK, each repeating the same
/// `message.usage`, so summing per record inflates totals (1.00x-3.57x per file,
/// median 2.12, token-weighted 2.20x input / 2.08x output on the reference
/// corpus). Turns are therefore keyed, and the last write wins.
///
/// **Last-wins, not first-wins.** Within a turn the input side is identical
/// across records (0 of 1,258 groups differed), but `output_tokens` GROWS —
/// 283 groups, every one of them in a subagent transcript. Taking the first
/// record undercounts corpus output by 27.9%.
///
/// **The key is global, not per file.** A resumed session replays turns
/// verbatim into a new transcript — same `requestId`, same usage — so keying
/// per file double-counts them.
#[derive(Default)]
pub struct UsageLedger {
    turns: HashMap<String, TurnUsage>,
}

impl UsageLedger {
    /// Record a turn. Returns true when this actually changed the totals, so
    /// callers can skip broadcasting an identical rollup for every one of a
    /// turn's repeated records.
    pub fn record(&mut self, key: String, turn: TurnUsage) -> bool {
        match self.turns.get(&key) {
            // Same key, same numbers: one of the repeated content-block records.
            Some(prev) if prev.usage == turn.usage => false,
            _ => {
                self.turns.insert(key, turn);
                true
            }
        }
    }

    pub fn rollup(&self) -> CostRollup {
        let mut by: HashMap<&str, (usize, TokenUsage)> = HashMap::new();
        let mut out = CostRollup {
            turns: self.turns.len(),
            ..Default::default()
        };
        for t in self.turns.values() {
            out.total.add(&t.usage);
            if t.agent_id.is_some() {
                out.subagent_turns += 1;
                out.subagent_total.add(&t.usage);
            }
            // An unpriceable turn still has to be counted, or the total quietly
            // shrinks. It lands under "unknown" and the viewer renders it
            // Unpriced rather than $0.00.
            let model = t.model.as_deref().unwrap_or("unknown");
            let slot = by.entry(model).or_insert((0, TokenUsage::default()));
            slot.0 += 1;
            slot.1.add(&t.usage);
        }
        out.by_model = by
            .into_iter()
            .map(|(model, (turns, usage))| ModelTotal {
                model: model.to_string(),
                turns,
                usage,
            })
            .collect();
        // Stable order so the viewer does not reshuffle rows on every update.
        out.by_model.sort_by(|a, b| a.model.cmp(&b.model));
        out
    }
}

/// Token usage for the context meter. `input` = context-window occupancy
/// (prompt + cache), `output` = tokens generated on the latest turn.
#[derive(Serialize, Clone, Copy)]
pub struct ContextUsage {
    pub input: u64,
    pub output: u64,
}

impl Session {
    /// A **watched** session: one claude-view did not launch, read from its
    /// transcript on disk (#40).
    ///
    /// It carries no process, so `pty` is `None` and everything that needs one
    /// refuses quietly. Everything else — the trace, the roster, the change set,
    /// cost — already works from `cwd` and `session_id`, which is why this costs
    /// a constructor rather than a second code path.
    ///
    /// `spawned_at` is the transcript's own start, not now: it is what the
    /// tailer pages from and what `changes` derives a baseline from, so
    /// stamping it with the moment the user clicked Watch would silently claim
    /// the session began then.
    pub fn watched(viewer_id: String, cwd: String, session_id: String, started_at: u64) -> Self {
        let (control_tx, _) = tokio::sync::broadcast::channel::<String>(256);
        let cwd_for_repo = cwd.clone();
        Self {
            viewer_id,
            cwd,
            spawned_at: started_at,
            session_id: RwLock::new(Some(session_id)),
            pty: None,
            control_tx,
            scrollback: Mutex::new(Vec::new()),
            timeline: Mutex::new(Vec::new()),
            model: RwLock::new(None),
            usage: RwLock::new(None),
            ledger: Mutex::new(UsageLedger::default()),
            // Same resolution the spawn path does, so a watched session groups
            // under its repo in the launcher exactly like a hosted one.
            repo: crate::git::discover(std::path::Path::new(&cwd_for_repo)),
            is_terminal: false,
            // Not ours to claim either way: the flag describes how a session was
            // launched, and this one was launched elsewhere.
            skip_permissions: false,
            ended: Default::default(),
            exit_code: RwLock::new(None),
            // Hooks never arrive for a session claude-view did not launch (#41),
            // so the hook-derived state stays Unknown for life. Liveness comes
            // from the transcript instead — see `crate::liveness`.
            state: RwLock::new(AgentState::Unknown),
            screen_blocked: RwLock::new(None),
            state_since: std::sync::atomic::AtomicU64::new(started_at),
            state_seq: Default::default(),
            last_state_ts: Default::default(),
        }
    }
    /// Merge a tool event parsed from the transcript into the timeline. Deduped
    /// by tool-use id, so hook-derived cards (which use the same ids and arrive
    /// live) take precedence and transcript records only fill gaps. Returns the
    /// event to broadcast, or None if nothing changed.
    pub fn apply_transcript(
        &self,
        rec: crate::transcript::Record,
        agent_id: Option<String>,
    ) -> Option<TimelineEvent> {
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
                    agent_id,
                    id,
                    tool,
                    command: command.map(|c| cap_command(&c)),
                    status: "running".into(),
                    duration_ms: None,
                    ts,
                    output: None,
                };
                push_timeline(&mut timeline, event.clone());
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
    /// session (writer thread gone) drops the input silently — and so does a
    /// watched one, which has no process to type into. Same outcome, so no new
    /// failure mode is invented for it.
    pub fn write_input(&self, data: Vec<u8>) {
        if self.is_ended() {
            return;
        }
        if let Some(pty) = &self.pty {
            let _ = pty.writer_tx.send(data);
        }
    }

    /// Whether claude-view launched this session. A watched session is read by
    /// construction, not by policy — there is no process to type into.
    pub fn is_watched(&self) -> bool {
        self.pty.is_none()
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
        if let Some(pty) = &self.pty {
            let _ = pty.bytes_tx.send(chunk.to_vec());
        }
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
        // The whole decision runs under ONE state write guard, and both merges
        // are derived in place. Computing them with `effective_state()` — which
        // takes and releases both locks on each call — let a second hook
        // delivery interleave between the two, so both could see a no-op and
        // skip the broadcast, leaving every viewer showing a state this session
        // is not in. `screen_blocked` is taken *inside* the state guard; that
        // order is safe because nothing anywhere takes the state lock while
        // holding the screen one.
        let mut current = self.state.write();
        let prev_ts = self.last_state_ts.load(Ordering::Acquire);
        if ts < prev_ts {
            return; // stale report; a newer one already won
        }
        self.last_state_ts.store(ts, Ordering::Release);
        // One read of the screen, shared by both merges. With no dialog on
        // screen `before`/`after` are exactly the hook states and the whole
        // function behaves as it always did.
        let screen = self.screen_blocked.read().clone();
        let before = merge_state(*current, screen.as_deref(), self.is_terminal);
        *current = next;
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
        let Some(pty) = &self.pty else {
            return; // watched: nothing of ours is running
        };
        if let Some(killer) = pty.killer.lock().as_mut() {
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
            watched: self.is_watched(),
            skip_permissions: self.skip_permissions,
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
    /// `true` when claude-view did **not** launch this session — it is read from
    /// a transcript on disk, with no process behind it (#40).
    ///
    /// Derived from `pty.is_none()` rather than stored, so it cannot fall out of
    /// step with the thing it describes. The launcher decides where to draw such
    /// a session; *Active now* means "claude-view is running this", and that
    /// promise is kept in the UI rather than by hiding these from the registry.
    pub watched: bool,
    /// `true` when this session was launched with
    /// `--dangerously-skip-permissions` — Claude runs every tool without asking
    /// for approval, so no permission prompt will ever appear in it. The
    /// default for new sessions, but a per-session choice; always `false` for
    /// `is_terminal` sessions. See [`Session::skip_permissions`].
    pub skip_permissions: bool,
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

    /// Reserve a claude session id for `viewer_id`, or return false if someone
    /// already holds it. `has_session_id` followed by `insert` is not the same
    /// thing: the spawn between them does a fork/exec with no lock held, and
    /// two `--resume <same id>` requests both walked through that window and
    /// appended to one transcript. This takes the write lock once and decides
    /// under it, so exactly one caller can win.
    pub fn claim_session_id(&self, session_id: &str, viewer_id: &str) -> bool {
        let mut by_sid = self.by_session_id.write();
        if by_sid.contains_key(session_id) {
            return false;
        }
        by_sid.insert(session_id.to_string(), viewer_id.to_string());
        true
    }

    /// Hand a claim back when the spawn it was taken for never happened. A
    /// claim that outlives a failed spawn blocks resuming that conversation for
    /// the life of the app, which is worse than the race the claim prevents.
    pub fn release_session_id(&self, session_id: &str) {
        self.by_session_id.write().remove(session_id);
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

    /// A watched session has no process, and every call that would need one must
    /// do nothing rather than panic or invent a new failure mode. This is
    /// defence against a bug, not a user path — a watched window has no terminal
    /// to type into.
    #[test]
    fn pty_only_calls_are_harmless_on_a_watched_session() {
        let s = Session::watched(
            "v1".into(),
            std::env::temp_dir().to_string_lossy().into_owned(),
            "sid-1".into(),
            1_000,
        );
        assert!(s.is_watched());
        assert!(
            s.info().watched,
            "the flag is derived, so it cannot disagree"
        );

        // None of these have anything to act on; none may panic.
        s.write_input(b"rm -rf /\n".to_vec());
        s.kill();
        crate::pty::resize(&s, 120, 40);
        s.push_bytes(b"output that has nowhere to go");
    }

    /// `spawned_at` is the session's own start, not the moment Watch was
    /// clicked: the tailer pages from it and the change set derives a baseline
    /// from it, so a wrong value silently claims the session began then.
    #[test]
    fn a_watched_session_keeps_the_transcripts_start_time() {
        let started = 1_700_000_000_000;
        let s = Session::watched("v2".into(), "/tmp".into(), "sid-2".into(), started);
        assert_eq!(s.spawned_at, started);
        assert_eq!(s.session_id.read().as_deref(), Some("sid-2"));
    }

    /// Hooks never arrive from a session claude-view did not launch (#41), so a
    /// hook-derived state would be a lie. Liveness comes from the transcript.
    #[test]
    fn a_watched_session_reports_no_hook_state() {
        let s = Session::watched("v3".into(), "/tmp".into(), "sid-3".into(), 1);
        assert_eq!(s.info().state, AgentState::Unknown);
        assert!(!s.info().skip_permissions, "not ours to claim either way");
    }
    use crate::transcript::TokenUsage as TU;

    fn tu(input: u64, cache_read: u64, output: u64) -> TU {
        TU {
            input,
            cache_read,
            cache_write_5m: 0,
            cache_write_1h: 0,
            output,
        }
    }
    fn turn(u: TU, model: &str, agent: Option<&str>) -> TurnUsage {
        TurnUsage {
            usage: u,
            model: Some(model.into()),
            agent_id: agent.map(str::to_string),
        }
    }

    /// The core of the whole rollup. Claude Code writes one record per content
    /// block, each repeating the same usage; summing them inflates totals
    /// 2.2x-3.3x. Keyed turns must collapse to one.
    #[test]
    fn repeated_records_for_one_turn_count_once() {
        let mut l = UsageLedger::default();
        let u = tu(100, 9_000, 50);
        assert!(l.record("req_1".into(), turn(u, "claude-opus-5", None)));
        // ...the same turn arriving four more times, as it really does.
        for _ in 0..4 {
            assert!(
                !l.record("req_1".into(), turn(u, "claude-opus-5", None)),
                "an identical repeat must not report a change"
            );
        }
        let r = l.rollup();
        assert_eq!(r.turns, 1);
        assert_eq!(
            r.total.output, 50,
            "output summed per record instead of per turn"
        );
        assert_eq!(r.total.cache_read, 9_000);
    }

    /// LAST-wins, not first. Input is identical across a turn's records but
    /// output GROWS (283 groups on the reference corpus, all in subagent
    /// transcripts); taking the first undercounts output by 27.9%.
    #[test]
    fn a_turns_growing_output_takes_the_last_value() {
        let mut l = UsageLedger::default();
        for out in [10, 40, 90] {
            l.record("req_1".into(), turn(tu(100, 0, out), "claude-opus-5", None));
        }
        assert_eq!(l.rollup().total.output, 90, "must be last-wins, not first");
        assert_eq!(l.rollup().turns, 1);
    }

    /// Subagent spend is routinely the majority — 64.2% of one real session —
    /// so it must be in the total AND visible separately.
    #[test]
    fn subagent_turns_are_counted_and_also_surfaced_separately() {
        let mut l = UsageLedger::default();
        l.record("req_p".into(), turn(tu(10, 0, 5), "claude-opus-5", None));
        l.record(
            "req_a".into(),
            turn(tu(70, 0, 30), "claude-opus-5", Some("agent-1")),
        );
        l.record(
            "req_b".into(),
            turn(tu(20, 0, 10), "claude-opus-5", Some("agent-2")),
        );
        let r = l.rollup();
        assert_eq!(r.turns, 3);
        assert_eq!(r.subagent_turns, 2);
        assert_eq!(r.total.input, 100, "subagents must be inside the total");
        assert_eq!(r.subagent_total.input, 90);
        assert_eq!(r.subagent_total.output, 40);
    }

    /// A resumed session replays turns verbatim into a NEW transcript file.
    /// Keys are global precisely so that does not double-count.
    #[test]
    fn a_replayed_turn_from_another_file_does_not_double_count() {
        let mut l = UsageLedger::default();
        let u = tu(1_000, 0, 100);
        l.record("req_x".into(), turn(u, "claude-opus-5", None));
        // same turn, re-seen while tailing the resumed session's file
        l.record("req_x".into(), turn(u, "claude-opus-5", None));
        let r = l.rollup();
        assert_eq!(r.turns, 1);
        assert_eq!(r.total.input, 1_000);
    }

    /// Prices are per model, so totals split by model — and a turn whose model
    /// is unknown must still be COUNTED, or the total quietly shrinks. It lands
    /// under "unknown" for the viewer to render as Unpriced, never $0.00.
    #[test]
    fn totals_split_by_model_and_unknown_models_are_still_counted() {
        let mut l = UsageLedger::default();
        l.record("r1".into(), turn(tu(10, 0, 1), "claude-opus-5", None));
        l.record("r2".into(), turn(tu(20, 0, 2), "claude-haiku-4-5", None));
        l.record(
            "r3".into(),
            TurnUsage {
                usage: tu(40, 0, 4),
                model: None,
                agent_id: None,
            },
        );
        let r = l.rollup();
        assert_eq!(r.turns, 3);
        assert_eq!(
            r.total.input, 70,
            "the unpriceable turn must still be in the total"
        );
        let models: Vec<&str> = r.by_model.iter().map(|m| m.model.as_str()).collect();
        // sorted, so the viewer does not reshuffle rows on every update
        assert_eq!(models, vec!["claude-haiku-4-5", "claude-opus-5", "unknown"]);
        let unknown = r.by_model.iter().find(|m| m.model == "unknown").unwrap();
        assert_eq!(unknown.usage.input, 40);
    }

    /// The meter and the ledger answer different questions: latest occupancy
    /// vs de-duplicated sum. Conflating them is how a 2x-3x cost error happens.
    #[test]
    fn the_ledger_sums_while_the_meter_would_take_the_latest() {
        let mut l = UsageLedger::default();
        l.record("r1".into(), turn(tu(500_000, 0, 10), "claude-opus-5", None));
        l.record("r2".into(), turn(tu(60_000, 0, 20), "claude-opus-5", None));
        let r = l.rollup();
        // Cost wants the sum...
        assert_eq!(r.total.input, 560_000);
        // ...even though the meter would show 60_000, because compaction just
        // dropped the context. Occupancy is not monotonic; spend is.
        assert!(r.total.input > 60_000);
    }

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
            watched: false,
            skip_permissions: true,
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

    /// The viewer decides whether to show the "permissions skipped" badge from
    /// this one field, so its name and shape on the wire are the contract.
    #[test]
    fn session_info_reports_skip_permissions_in_snake_case() {
        let base = SessionInfo {
            viewer_id: "v1".into(),
            session_id: None,
            cwd: "/tmp".into(),
            ended: false,
            is_terminal: false,
            watched: false,
            skip_permissions: true,
            state: AgentState::Idle,
            blocked_kind: None,
            state_seq: 0,
            state_since: 0,
            repo_key: None,
            repo_name: None,
            checkout_name: None,
            is_linked_worktree: false,
            branch: None,
        };

        let v = serde_json::to_value(&base).unwrap();
        assert_eq!(v["skip_permissions"], true, "the app's default: skipping");
        assert!(
            v.get("skipPermissions").is_none(),
            "no camelCase alias exists"
        );

        let strict = SessionInfo {
            skip_permissions: false,
            ..base.clone()
        };
        assert_eq!(
            serde_json::to_value(&strict).unwrap()["skip_permissions"],
            false
        );

        // A plain shell is never reported as having skipped permissions —
        // `Session::info` copies the field, and `spawn_in_pty` pins it to false
        // for terminals (asserted against a real PTY in pty.rs).
        let terminal = SessionInfo {
            is_terminal: true,
            skip_permissions: false,
            ..base
        };
        let v = serde_json::to_value(&terminal).unwrap();
        assert_eq!(v["is_terminal"], true);
        assert_eq!(v["skip_permissions"], false);
    }
}
