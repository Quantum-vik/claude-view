use std::sync::atomic::Ordering;
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::pty;
use crate::session::{
    cap_command, now_ms, push_timeline, AgentState, Registry, Session, TimelineEvent,
};

#[derive(Clone)]
pub struct ServerState {
    pub registry: Arc<Registry>,
    pub token: String,
    pub app: tauri::AppHandle,
    pub port: u16,
}

pub fn router(registry: Arc<Registry>, token: String, app: tauri::AppHandle, port: u16) -> Router {
    let state = ServerState {
        registry,
        token,
        app,
        port,
    };
    Router::new()
        .route("/ws/:id", get(ws_handler))
        .route("/hooks", post(hooks_handler))
        .route("/bind", post(bind_handler))
        .route(
            "/sessions",
            post(sessions_handler).get(list_sessions_handler),
        )
        .route("/terminals", post(terminals_handler))
        .route("/past_sessions", get(past_sessions_handler))
        .with_state(state)
}

/// Token-authed listing of sessions the app is currently hosting — lets
/// scripts (e.g. scripts/demo-timeline.sh) find a live viewer_id.
async fn list_sessions_handler(
    State(state): State<ServerState>,
    headers: HeaderMap,
) -> Result<axum::Json<Vec<crate::session::SessionInfo>>, (StatusCode, String)> {
    if !check_token(&state, &headers) {
        return Err((StatusCode::UNAUTHORIZED, "bad token".into()));
    }
    Ok(axum::Json(state.registry.list()))
}

async fn past_sessions_handler(
    State(state): State<ServerState>,
    headers: HeaderMap,
) -> Result<axum::Json<Vec<crate::past_sessions::PastSession>>, (StatusCode, String)> {
    if !check_token(&state, &headers) {
        return Err((StatusCode::UNAUTHORIZED, "bad token".into()));
    }
    // Filesystem scan of ~/.claude/projects is blocking — keep it off the
    // async executor.
    tokio::task::spawn_blocking(crate::past_sessions::list)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map(axum::Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

#[derive(Deserialize)]
struct NewSessionReq {
    cwd: String,
    #[serde(default)]
    resume: Option<String>,
    #[serde(default)]
    continue_last: bool,
}

/// Token-authed local endpoint to launch a session (with its viewer window)
/// from scripts: curl -X POST /sessions -H 'X-Claude-View-Token: …' -d '{"cwd":"…"}'
async fn sessions_handler(
    State(state): State<ServerState>,
    headers: HeaderMap,
    body: String,
) -> Result<axum::Json<crate::session::SessionInfo>, (StatusCode, String)> {
    if !check_token(&state, &headers) {
        return Err((StatusCode::UNAUTHORIZED, "bad token".into()));
    }
    let req: NewSessionReq = serde_json::from_str(&body)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("bad request: {e}")))?;
    let info = crate::open_session(
        &state.app,
        &state.registry,
        state.port,
        &state.token,
        req.cwd,
        req.resume,
        req.continue_last,
        true,
    )
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(axum::Json(info))
}

#[derive(Deserialize)]
struct NewTerminalReq {
    cwd: String,
    /// "tmux" or "shell" (default). Anything else falls back to a login shell.
    #[serde(default)]
    kind: Option<String>,
}

/// Token-authed local endpoint to launch a terminal window (login shell or
/// tmux) from scripts, mirroring /sessions for claude:
/// curl -X POST /terminals -H 'X-Claude-View-Token: …' -d '{"cwd":"…","kind":"tmux"}'
async fn terminals_handler(
    State(state): State<ServerState>,
    headers: HeaderMap,
    body: String,
) -> Result<axum::Json<crate::session::SessionInfo>, (StatusCode, String)> {
    if !check_token(&state, &headers) {
        return Err((StatusCode::UNAUTHORIZED, "bad token".into()));
    }
    let req: NewTerminalReq = serde_json::from_str(&body)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("bad request: {e}")))?;
    let kind = crate::pty::TerminalKind::parse(req.kind.as_deref().unwrap_or("shell"));
    let info = crate::open_terminal(
        &state.app,
        &state.registry,
        state.port,
        &state.token,
        req.cwd,
        kind,
        true,
    )
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(axum::Json(info))
}

#[derive(Deserialize)]
struct WsQuery {
    token: Option<String>,
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    Path(id): Path<String>,
    Query(q): Query<WsQuery>,
    State(state): State<ServerState>,
) -> Result<axum::response::Response, StatusCode> {
    if q.token.as_deref() != Some(state.token.as_str()) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let session = state.registry.get(&id).ok_or(StatusCode::NOT_FOUND)?;
    Ok(ws.on_upgrade(move |socket| handle_ws(socket, session)))
}

async fn handle_ws(socket: WebSocket, session: Arc<Session>) {
    let (mut tx, mut rx) = socket.split();

    // Subscribe before snapshotting so no bytes/events are lost in between.
    // The timeline snapshot is taken while holding the same lock a hook writer
    // would need, and the subscribe happens first, so an event can only be
    // duplicated (snapshot + broadcast) — never lost. The client upserts by id,
    // so a duplicate is idempotent.
    let mut bytes_rx = session.bytes_tx.subscribe();
    let mut control_rx = session.control_tx.subscribe();

    // Replay state: scrollback bytes, timeline snapshot, binding, ended flag.
    let scrollback = session.scrollback.lock().clone();
    if !scrollback.is_empty() && tx.send(Message::Binary(scrollback)).await.is_err() {
        return;
    }
    let snapshot = {
        let timeline = session.timeline.lock();
        json!({
            "type": "timeline_snapshot",
            "events": &*timeline,
            // Cards already evicted by TIMELINE_CAP. Without this the viewer
            // can't tell a session that ran 12 commands from one that ran 5012
            // — it just shows the tail as if it were the whole history.
            "elided": session.timeline_elided.load(Ordering::Relaxed),
        })
    };
    if tx.send(Message::Text(snapshot.to_string())).await.is_err() {
        return;
    }
    let bound_sid = session.session_id.read().clone();
    if let Some(sid) = bound_sid {
        let msg = json!({ "type": "bound", "session_id": sid, "cwd": session.cwd });
        let _ = tx.send(Message::Text(msg.to_string())).await;
    }
    let current_model = session.model.read().clone();
    if let Some(model) = current_model {
        let _ = tx
            .send(Message::Text(
                json!({ "type": "model", "model": model }).to_string(),
            ))
            .await;
    }
    let current_usage = *session.usage.read();
    if let Some(u) = current_usage {
        let _ = tx
            .send(Message::Text(
                json!({ "type": "usage", "input": u.input, "output": u.output }).to_string(),
            ))
            .await;
    }
    if session.is_ended() {
        let code = session.exit_code.read().unwrap_or(0);
        let _ = tx
            .send(Message::Text(
                json!({ "type": "exit", "code": code }).to_string(),
            ))
            .await;
    }

    // Outbound: fan PTY bytes (binary) and control messages (text) to the client.
    let send_session = session.clone();
    let send_task = tokio::spawn(async move {
        use tokio::sync::broadcast::error::RecvError;
        loop {
            tokio::select! {
                chunk = bytes_rx.recv() => match chunk {
                    Ok(bytes) => {
                        if tx.send(Message::Binary(bytes)).await.is_err() {
                            break;
                        }
                    }
                    // A slow client fell behind and the ring buffer dropped
                    // bytes. Rather than silently desync xterm, resend the full
                    // scrollback so the terminal re-renders a correct state.
                    Err(RecvError::Lagged(_)) => {
                        let sb = send_session.scrollback.lock().clone();
                        let resync = json!({ "type": "resync" }).to_string();
                        if tx.send(Message::Text(resync)).await.is_err()
                            || tx.send(Message::Binary(sb)).await.is_err()
                        {
                            break;
                        }
                    }
                    Err(RecvError::Closed) => break,
                },
                ctrl = control_rx.recv() => match ctrl {
                    Ok(text) => {
                        if tx.send(Message::Text(text)).await.is_err() {
                            break;
                        }
                    }
                    Err(RecvError::Lagged(_)) => continue,
                    Err(RecvError::Closed) => break,
                },
            }
        }
    });

    // Inbound: binary = keystrokes -> PTY; text = control (resize).
    while let Some(Ok(msg)) = rx.next().await {
        match msg {
            Message::Binary(data) => {
                // Non-blocking: queued to the session's writer thread.
                session.write_input(data);
            }
            Message::Text(text) => {
                if let Ok(v) = serde_json::from_str::<Value>(&text) {
                    if v["type"] == "resize" {
                        let cols = v["cols"].as_u64().unwrap_or(120) as u16;
                        let rows = v["rows"].as_u64().unwrap_or(34) as u16;
                        pty::resize(&session, cols, rows);
                    }
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    send_task.abort();
}

fn check_token(state: &ServerState, headers: &HeaderMap) -> bool {
    headers
        .get("x-claude-view-token")
        .and_then(|v| v.to_str().ok())
        == Some(state.token.as_str())
}

/// Explicit bind endpoint (spec §7b). The bundled bridge script normally posts
/// everything to /hooks and SessionStart is bound there, but this route honors
/// the contract for custom bridges.
async fn bind_handler(
    State(state): State<ServerState>,
    headers: HeaderMap,
    body: String,
) -> StatusCode {
    if !check_token(&state, &headers) {
        return StatusCode::UNAUTHORIZED;
    }
    let Ok(v) = serde_json::from_str::<Value>(&body) else {
        return StatusCode::BAD_REQUEST;
    };
    let viewer_id = v["viewer_id"]
        .as_str()
        .map(str::to_string)
        .or_else(|| header_viewer_id(&headers));
    let (Some(vid), Some(sid)) = (viewer_id, v["session_id"].as_str()) else {
        return StatusCode::BAD_REQUEST;
    };
    do_bind(&state.registry, &vid, sid);
    StatusCode::OK
}

fn header_viewer_id(headers: &HeaderMap) -> Option<String> {
    headers
        .get("x-claude-view-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
}

fn do_bind(registry: &Arc<Registry>, viewer_id: &str, session_id: &str) {
    if let Some(session) = registry.bind(viewer_id, session_id) {
        session.send_control(json!({
            "type": "bound",
            "session_id": session_id,
            "cwd": session.cwd,
        }));
    }
}

/// All hook events land here. The bridge script forwards the hook's stdin JSON
/// verbatim with the viewer id/token in headers; normalization happens here so
/// the shell side stays trivial and dependency-free.
async fn hooks_handler(
    State(state): State<ServerState>,
    headers: HeaderMap,
    body: String,
) -> StatusCode {
    if !check_token(&state, &headers) {
        return StatusCode::UNAUTHORIZED;
    }
    let Ok(v) = serde_json::from_str::<Value>(&body) else {
        return StatusCode::BAD_REQUEST;
    };

    let event = v["hook_event_name"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    let session_id = v["session_id"].as_str().map(str::to_string);
    let viewer_id = header_viewer_id(&headers);

    // Bind eagerly on any event that carries session_id — SessionStart is the
    // designed path, but this also self-heals if SessionStart was missed.
    //
    // Compare the STORED id against the incoming one; "is anything bound?" is
    // the wrong question. `pty::spawn_in_pty` pre-seeds session_id for every
    // `claude --resume`, so an is_some() test is already true on the FIRST hook:
    // the bind was skipped entirely for resumed sessions, and when Claude Code
    // forks a NEW id on resume the seeded (now stale) one was never replaced —
    // leaving the viewer unbound and the dead id resolving to this session
    // forever. Registry::bind retires the superseded index entry.
    if let (Some(vid), Some(sid)) = (&viewer_id, &session_id) {
        let bound = state
            .registry
            .get(vid)
            .and_then(|s| s.session_id.read().clone());
        if bound.as_deref() != Some(sid.as_str()) {
            do_bind(&state.registry, vid, sid);
        }
    }

    // Route to the session by session_id first, then viewer_id.
    let session = session_id
        .as_deref()
        .and_then(|sid| state.registry.get(sid))
        .or_else(|| viewer_id.as_deref().and_then(|vid| state.registry.get(vid)));
    let Some(session) = session else {
        return StatusCode::OK; // not one of our sessions; ignore quietly
    };

    // One timestamp for the whole event: it orders the state transition against
    // concurrently-delivered hooks (the bridge backgrounds a curl per hook, so
    // arrival order isn't send order — see Session::set_state).
    let ts = now_ms();

    match event.as_str() {
        // The process is up but no turn has begun. Also fires after /clear.
        "SessionStart" => session.set_state(AgentState::Idle, "session_start", ts),
        // Start of a turn — the only signal for a turn that thinks for 90s
        // before it touches a tool (PreToolUse might never come at all).
        "UserPromptSubmit" => session.set_state(AgentState::Working, "prompt", ts),
        "PreToolUse" => {
            session.set_state(AgentState::Working, "tool", ts);
            on_pre_tool_use(&session, &v);
        }
        "PostToolUse" => {
            // Still Working, not Idle: the tool finished, the *turn* has not.
            // Claude is now thinking about the result; Stop ends the turn.
            session.set_state(AgentState::Working, "tool_done", ts);
            on_post_tool_use(&session, &v);
        }
        "SessionEnd" => {
            // The PTY waiter thread owns the authoritative "ended" state; the
            // hook just settles any cards still marked running. Deliberately
            // sets no terminal state: Claude Code fires SessionEnd with
            // reason "clear" on a still-live process, so treating it as the end
            // of the session would freeze a perfectly healthy agent's state.
            settle_running_cards(&session);
        }
        // Claude finished its turn — the viewer decides whether to raise a
        // native notification (it knows if the window is focused).
        "Stop" => {
            session.set_state(AgentState::Idle, "turn_done", ts);
            session.send_control(json!({ "type": "turn_done" }));
        }
        // Claude wants attention. Whether that means *blocked* depends on what
        // it says — see notification_state.
        "Notification" => {
            let message = v["message"]
                .as_str()
                .unwrap_or("Claude needs your attention");
            let (next, reason) = notification_state(message);
            session.set_state(next, reason, ts);
            session.send_control(json!({ "type": "attention", "message": message }));
        }
        _ => {}
    }
    StatusCode::OK
}

/// Unambiguously permission/approval-shaped text. Matched case-insensitively
/// against a `Notification`'s `message`.
const BLOCKED_MARKERS: &[&str] = &["permission", "approve", "approval", "confirm"];

/// Also permission-shaped in general — but Claude Code's idle ping is literally
/// "Claude is waiting for your input", so this one needs [`IDLE_PING`] carved
/// out of it. See [`notification_state`].
const WAITING_MARKER: &str = "waiting for your input";

/// Claude Code's ~60-second idle ping, lowercased. Not a blocking condition.
const IDLE_PING: &str = "claude is waiting for your input";

/// The [`AgentState`] a `Notification` implies, and the reason to record.
///
/// A Notification is not synonymous with "blocked". Claude Code fires it for
/// exactly two things: a permission prompt, and an idle ping after ~60s with no
/// input. Every session this app spawns runs with
/// `--dangerously-skip-permissions` (see `pty::spawn_session`), so the
/// permission prompt effectively never fires and what actually arrives is the
/// idle ping — which means Claude is waiting on the *user*, i.e. Idle. Mapping
/// every Notification to Blocked would paint every quiet session red once a
/// minute forever: exactly the false-positive class hook-driven state exists to
/// avoid.
///
/// Blocked is therefore opt-in — only permission/approval-shaped text qualifies.
fn notification_state(message: &str) -> (AgentState, &'static str) {
    let text = message.to_lowercase();
    if BLOCKED_MARKERS.iter().any(|m| text.contains(m)) {
        return (AgentState::Blocked, "needs_input");
    }
    // "waiting for your input" reads as blocking, and would be — except that
    // it's a substring of the idle ping, which is the message we actually get.
    if text.contains(WAITING_MARKER) && !text.contains(IDLE_PING) {
        return (AgentState::Blocked, "needs_input");
    }
    // Anything else is a custom/unknown notification: Claude stopped to talk to
    // us rather than to run a tool, so Idle is the honest read — and the next
    // UserPromptSubmit/PreToolUse corrects it the moment work resumes.
    let reason = if text.contains(IDLE_PING) {
        "idle_ping"
    } else {
        "notification"
    };
    (AgentState::Idle, reason)
}

/// Best-effort human-readable subject for a tool call card.
fn describe_input(tool_name: &str, tool_input: &Value) -> Option<String> {
    if tool_name == "Bash" {
        return tool_input["command"].as_str().map(str::to_string);
    }
    for key in [
        "file_path",
        "path",
        "pattern",
        "query",
        "url",
        "description",
    ] {
        if let Some(s) = tool_input[key].as_str() {
            return Some(s.to_string());
        }
    }
    None
}

/// Pull a human-readable result out of tool_response, whose shape varies by
/// tool and Claude Code version (string, object, or content-block array).
fn extract_output(resp: &Value) -> Option<String> {
    const CAP: usize = 4000;
    let text = if let Some(s) = resp.as_str() {
        s.to_string()
    } else if let Some(s) = resp["output"].as_str() {
        s.to_string()
    } else if let Some(s) = resp["stdout"].as_str() {
        s.to_string()
    } else if let Some(s) = resp["content"].as_str() {
        s.to_string()
    } else if let Some(items) = resp.as_array().or_else(|| resp["content"].as_array()) {
        items
            .iter()
            .find_map(|item| item["text"].as_str())
            .map(str::to_string)?
    } else if resp.is_object() {
        serde_json::to_string_pretty(resp).ok()?
    } else {
        return None;
    };
    let mut combined = text.trim().to_string();
    // Bash and other tools carry diagnostics on stderr; surface it too instead
    // of silently dropping it.
    if let Some(err) = resp["stderr"].as_str().filter(|s| !s.trim().is_empty()) {
        if !combined.is_empty() {
            combined.push('\n');
        }
        combined.push_str("[stderr]\n");
        combined.push_str(err.trim());
    }
    if combined.is_empty() {
        return None;
    }
    let mut out: String = combined.chars().take(CAP).collect();
    if combined.chars().count() > CAP {
        out.push_str("\n… (truncated)");
    }
    Some(out)
}

// ---------------------------------------------------------------------------
// Timeline correlation.
//
// These three operate on a plain `&mut Vec<TimelineEvent>` rather than on a
// `Session`, because a `Session` owns a live PTY: nothing that takes one can be
// unit-tested, and this is the bug-densest logic in the app (id correlation,
// FIFO fallback, eviction). The `on_*` fns below are the thin Session-facing
// wrappers — lock, delegate, account, broadcast.
// ---------------------------------------------------------------------------

/// Open a card for a tool call. Returns the card to broadcast and how many
/// older cards the append evicted.
pub(crate) fn apply_pre_tool_use(
    timeline: &mut Vec<TimelineEvent>,
    v: &Value,
    ts: u64,
) -> (TimelineEvent, u64) {
    let tool = v["tool_name"].as_str().unwrap_or("Tool").to_string();
    // tool_use_id is present in recent Claude Code versions; fall back to a
    // generated id + FIFO matching when absent.
    let id = v["tool_use_id"]
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let event = TimelineEvent {
        id,
        kind: "command".into(),
        tool: tool.clone(),
        command: describe_input(&tool, &v["tool_input"]).map(|c| cap_command(&c)),
        status: "running".into(),
        duration_ms: None,
        ts,
        output: None,
    };
    let dropped = push_timeline(timeline, event.clone());
    (event, dropped)
}

/// Resolve the card a tool call opened (or create one if its Pre was missed).
///
/// The whole-payload entry point. `on_post_tool_use` deliberately calls
/// [`apply_post_tool_use_with_output`] instead so the extraction happens off the
/// lock, which leaves this one exercised only by tests in a non-test build —
/// keeping it is what guarantees those tests extract output exactly the way
/// production does, instead of hand-feeding it.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn apply_post_tool_use(
    timeline: &mut Vec<TimelineEvent>,
    v: &Value,
    ts: u64,
) -> (TimelineEvent, u64) {
    let output = extract_output(&v["tool_response"]);
    apply_post_tool_use_with_output(timeline, v, ts, output)
}

/// Body of [`apply_post_tool_use`] with the (potentially expensive) output
/// extraction already done, so the caller can run it *outside* the timeline
/// lock. See [`on_post_tool_use`].
fn apply_post_tool_use_with_output(
    timeline: &mut Vec<TimelineEvent>,
    v: &Value,
    ts: u64,
    output: Option<String>,
) -> (TimelineEvent, u64) {
    let tool = v["tool_name"].as_str().unwrap_or("Tool").to_string();

    // Hook payloads don't carry a reliable success flag across versions; treat
    // an error-shaped tool_response defensively and default to success.
    let resp = &v["tool_response"];
    let is_error = resp["is_error"].as_bool().unwrap_or(false)
        || resp["success"].as_bool().map(|s| !s).unwrap_or(false)
        || (resp.is_object() && resp["error"].is_string());
    let status = if is_error { "error" } else { "success" };

    let tool_use_id = v["tool_use_id"].as_str();
    // FIFO note: without tool_use_id, we resolve the oldest running card for
    // this tool. This misattributes when two same-tool calls (e.g. a subagent's
    // Bash) overlap; recent Claude Code emits tool_use_id, which is exact.
    let entry = match tool_use_id {
        Some(id) => timeline.iter_mut().find(|e| e.id == id),
        None => timeline
            .iter_mut()
            .find(|e| e.status == "running" && e.tool == tool),
    };

    if let Some(entry) = entry {
        entry.status = status.into();
        entry.duration_ms = Some(ts.saturating_sub(entry.ts));
        entry.output = output;
        (entry.clone(), 0)
    } else {
        // PostToolUse without a matching Pre (e.g. viewer attached mid-call).
        let event = TimelineEvent {
            id: tool_use_id
                .map(str::to_string)
                .unwrap_or_else(|| Uuid::new_v4().to_string()),
            kind: "command".into(),
            tool: tool.clone(),
            command: describe_input(&tool, &v["tool_input"]).map(|c| cap_command(&c)),
            status: status.into(),
            duration_ms: None,
            ts,
            output,
        };
        let dropped = push_timeline(timeline, event.clone());
        (event, dropped)
    }
}

/// Close out every still-running card. Returns the cards that changed.
///
/// Takes a slice, not a `&mut Vec`, because unlike its two siblings it only ever
/// rewrites cards in place — it can't append or evict.
pub(crate) fn settle_running(timeline: &mut [TimelineEvent], ts: u64) -> Vec<TimelineEvent> {
    // These cards never got a PostToolUse before the session ended. That's not
    // necessarily a failure (the Post may have been dropped or the command
    // interrupted), so use a distinct "interrupted" status rather than falsely
    // reporting "error".
    timeline
        .iter_mut()
        .filter(|e| e.status == "running")
        .map(|entry| {
            entry.status = "interrupted".into();
            entry.duration_ms = Some(ts.saturating_sub(entry.ts));
            entry.clone()
        })
        .collect()
}

fn on_pre_tool_use(session: &Arc<Session>, v: &Value) {
    let ts = now_ms();
    let (event, dropped) = {
        let mut timeline = session.timeline.lock();
        apply_pre_tool_use(&mut timeline, v, ts)
    };
    session.note_elided(dropped);
    session.send_control(json!({ "type": "timeline", "event": event }));
}

fn on_post_tool_use(session: &Arc<Session>, v: &Value) {
    let ts = now_ms();
    // Extract/serialize output BEFORE taking the lock — a large tool_response
    // would otherwise hold the timeline mutex through a heavy allocation and
    // stall concurrent hook handlers.
    let output = extract_output(&v["tool_response"]);
    let (event, dropped) = {
        let mut timeline = session.timeline.lock();
        apply_post_tool_use_with_output(&mut timeline, v, ts, output)
    };
    session.note_elided(dropped);
    session.send_control(json!({ "type": "timeline", "event": event }));
}

fn settle_running_cards(session: &Arc<Session>) {
    let ts = now_ms();
    let updates = {
        let mut timeline = session.timeline.lock();
        settle_running(&mut timeline, ts)
    };
    for event in updates {
        session.send_control(json!({ "type": "timeline", "event": event }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::{COMMAND_CAP, TIMELINE_CAP};

    /// A PreToolUse payload in the shape Claude Code actually posts (see
    /// scripts/demo-timeline.sh for captured examples).
    fn pre(tool: &str, id: Option<&str>, input: Value) -> Value {
        let mut v = json!({
            "hook_event_name": "PreToolUse",
            "session_id": "11111111-2222-3333-4444-555555555555",
            "cwd": "/Users/dev/app",
            "tool_name": tool,
            "tool_input": input,
        });
        if let Some(id) = id {
            v["tool_use_id"] = json!(id);
        }
        v
    }

    fn post(tool: &str, id: Option<&str>, input: Value, response: Value) -> Value {
        let mut v = json!({
            "hook_event_name": "PostToolUse",
            "session_id": "11111111-2222-3333-4444-555555555555",
            "cwd": "/Users/dev/app",
            "tool_name": tool,
            "tool_input": input,
            "tool_response": response,
        });
        if let Some(id) = id {
            v["tool_use_id"] = json!(id);
        }
        v
    }

    /// A finished card, for filling a timeline without going through the hooks.
    fn settled(id: &str, ts: u64) -> TimelineEvent {
        TimelineEvent {
            id: id.into(),
            kind: "command".into(),
            tool: "Read".into(),
            command: Some("src/lib.rs".into()),
            status: "success".into(),
            duration_ms: Some(4),
            ts,
            output: None,
        }
    }

    // ---- describe_input -----------------------------------------------------

    #[test]
    fn describe_input_picks_the_right_key() {
        let cases: &[(&str, &str, Value, Option<&str>)] = &[
            (
                "Bash reads command, not description",
                "Bash",
                json!({ "command": "npm test", "description": "run the tests" }),
                Some("npm test"),
            ),
            (
                "Bash is command-only — it never falls through",
                "Bash",
                json!({ "description": "run the tests", "file_path": "a.rs" }),
                None,
            ),
            (
                "file_path outranks every other key",
                "Edit",
                json!({
                    "file_path": "a", "path": "b", "pattern": "c",
                    "query": "d", "url": "e", "description": "f"
                }),
                Some("a"),
            ),
            (
                "path outranks pattern",
                "Grep",
                json!({ "path": "b", "pattern": "c", "query": "d" }),
                Some("b"),
            ),
            (
                "pattern outranks query",
                "Glob",
                json!({ "pattern": "c", "query": "d", "url": "e" }),
                Some("c"),
            ),
            (
                "query outranks url",
                "WebSearch",
                json!({ "query": "axum websocket backpressure", "url": "e" }),
                Some("axum websocket backpressure"),
            ),
            (
                "url outranks description",
                "WebFetch",
                json!({ "url": "https://example.com", "description": "f" }),
                Some("https://example.com"),
            ),
            (
                "description is the last resort",
                "Agent",
                json!({ "description": "search the codebase" }),
                Some("search the codebase"),
            ),
            ("no known key", "Weird", json!({ "foo": "bar" }), None),
            ("empty input", "Weird", json!({}), None),
            ("missing tool_input", "Weird", Value::Null, None),
            (
                "non-string values are skipped",
                "Edit",
                json!({ "file_path": 42, "path": ["a"] }),
                None,
            ),
        ];
        for (name, tool, input, want) in cases {
            assert_eq!(
                describe_input(tool, input).as_deref(),
                *want,
                "case: {name}"
            );
        }
    }

    #[test]
    fn a_huge_command_is_capped_on_the_card() {
        let huge = format!("echo {}", "a".repeat(COMMAND_CAP * 3));
        let marker = " … (truncated)";
        // describe_input itself is faithful; capping happens on the card.
        assert_eq!(
            describe_input("Bash", &json!({ "command": huge.clone() }))
                .unwrap()
                .chars()
                .count(),
            huge.chars().count()
        );

        let mut timeline = Vec::new();
        let (card, _) = apply_pre_tool_use(
            &mut timeline,
            &pre("Bash", Some("t1"), json!({ "command": huge.clone() })),
            10,
        );
        let command = card.command.expect("Bash card has a command");
        assert!(command.ends_with(marker), "got: {}", &command[..40]);
        assert_eq!(
            command.chars().count(),
            COMMAND_CAP + marker.chars().count()
        );

        // The Post-without-Pre path builds a card too, and must cap it as well.
        let mut timeline = Vec::new();
        let (card, _) = apply_post_tool_use(
            &mut timeline,
            &post(
                "Bash",
                Some("t2"),
                json!({ "command": huge }),
                json!({ "output": "ok" }),
            ),
            10,
        );
        assert!(card.command.unwrap().ends_with(marker));
    }

    // ---- extract_output -----------------------------------------------------

    #[test]
    fn extract_output_handles_every_response_shape() {
        let cases: &[(&str, Value, Option<&str>)] = &[
            ("plain string", json!("just text"), Some("just text")),
            (
                "{output}",
                json!({ "output": "added 42 packages" }),
                Some("added 42 packages"),
            ),
            ("{stdout}", json!({ "stdout": "hello\n" }), Some("hello")),
            (
                "{content} as string",
                json!({ "content": "file body" }),
                Some("file body"),
            ),
            (
                "{content} as content blocks",
                json!({ "content": [{ "type": "text", "text": "block text" }] }),
                Some("block text"),
            ),
            (
                "bare content-block array",
                json!([{ "type": "text", "text": "array text" }]),
                Some("array text"),
            ),
            ("array with no text block", json!([1, 2, 3]), None),
            (
                "generic object falls back to pretty JSON",
                json!({ "filePath": "a.rs", "numLines": 3 }),
                Some("{\n  \"filePath\": \"a.rs\",\n  \"numLines\": 3\n}"),
            ),
            ("null", Value::Null, None),
            ("number", json!(7), None),
            ("blank output", json!({ "output": "   " }), None),
            (
                "stderr is appended, marked",
                json!({ "output": "ok", "stderr": "warning: unused" }),
                Some("ok\n[stderr]\nwarning: unused"),
            ),
            (
                "stderr alone still surfaces",
                json!({ "stdout": "", "stderr": "command not found" }),
                Some("[stderr]\ncommand not found"),
            ),
            (
                "blank stderr is ignored",
                json!({ "output": "ok", "stderr": "  \n" }),
                Some("ok"),
            ),
        ];
        for (name, response, want) in cases {
            assert_eq!(extract_output(response).as_deref(), *want, "case: {name}");
        }
    }

    #[test]
    fn extract_output_caps_long_results() {
        let marker = "\n… (truncated)";
        let long = "x".repeat(5000);
        let out = extract_output(&json!({ "output": long })).unwrap();
        assert!(out.ends_with(marker));
        assert_eq!(out.chars().count(), 4000 + marker.chars().count());

        // Exactly at the cap: no marker.
        let exact = "y".repeat(4000);
        let out = extract_output(&json!({ "output": exact })).unwrap();
        assert_eq!(out.chars().count(), 4000);
        assert!(!out.contains("truncated"));
    }

    // ---- error heuristic ----------------------------------------------------

    #[test]
    fn error_shaped_responses_mark_the_card_failed() {
        let cases: &[(&str, Value, &str)] = &[
            (
                "is_error",
                json!({ "is_error": true, "output": "boom" }),
                "error",
            ),
            (
                "success:false",
                json!({ "success": false, "output": "boom" }),
                "error",
            ),
            ("string error field", json!({ "error": "ENOENT" }), "error"),
            // Only a *string* error counts: some tools return `error: null` or a
            // numeric exit-style field on a perfectly successful call.
            (
                "non-string error field",
                json!({ "error": 42, "output": "ok" }),
                "success",
            ),
            (
                "null error field",
                json!({ "error": null, "output": "ok" }),
                "success",
            ),
            ("plain success", json!({ "output": "ok" }), "success"),
            (
                "is_error:false",
                json!({ "is_error": false, "output": "ok" }),
                "success",
            ),
            ("plain string response", json!("done"), "success"),
        ];
        for (name, response, want) in cases {
            let mut timeline = Vec::new();
            let (card, _) = apply_post_tool_use(
                &mut timeline,
                &post(
                    "Bash",
                    Some("t"),
                    json!({ "command": "x" }),
                    response.clone(),
                ),
                10,
            );
            assert_eq!(card.status, *want, "case: {name}");
        }
    }

    // ---- correlation --------------------------------------------------------

    #[test]
    fn pre_then_post_with_the_same_id_resolves_one_card() {
        let mut timeline = Vec::new();
        let (opened, dropped) = apply_pre_tool_use(
            &mut timeline,
            &pre(
                "Bash",
                Some("toolu_01"),
                json!({ "command": "npm install" }),
            ),
            1_000,
        );
        assert_eq!((opened.status.as_str(), dropped), ("running", 0));
        assert_eq!(timeline.len(), 1);

        let (resolved, dropped) = apply_post_tool_use(
            &mut timeline,
            &post(
                "Bash",
                Some("toolu_01"),
                json!({ "command": "npm install" }),
                json!({ "output": "added 42 packages" }),
            ),
            3_500,
        );
        assert_eq!(dropped, 0);
        assert_eq!(timeline.len(), 1, "must resolve in place, not append");
        assert_eq!(resolved.id, "toolu_01");
        assert_eq!(resolved.status, "success");
        assert_eq!(resolved.duration_ms, Some(2_500));
        assert_eq!(resolved.output.as_deref(), Some("added 42 packages"));
        assert_eq!(timeline[0].status, "success");
    }

    #[test]
    fn post_without_a_matching_pre_opens_its_own_card() {
        let mut timeline = Vec::new();
        let (card, _) = apply_post_tool_use(
            &mut timeline,
            &post(
                "Read",
                Some("toolu_orphan"),
                json!({ "file_path": "src/App.tsx" }),
                json!({ "output": "…" }),
            ),
            2_000,
        );
        assert_eq!(timeline.len(), 1);
        assert_eq!(card.id, "toolu_orphan");
        assert_eq!(card.status, "success");
        assert_eq!(card.command.as_deref(), Some("src/App.tsx"));
        assert_eq!(
            card.duration_ms, None,
            "no Pre means no start time to measure"
        );
    }

    #[test]
    fn a_pre_without_an_id_still_gets_a_unique_one() {
        let mut timeline = Vec::new();
        let payload = pre("Bash", None, json!({ "command": "ls" }));
        let (a, _) = apply_pre_tool_use(&mut timeline, &payload, 1);
        let (b, _) = apply_pre_tool_use(&mut timeline, &payload, 2);
        assert!(!a.id.is_empty());
        assert_ne!(a.id, b.id);
    }

    #[test]
    fn fifo_fallback_resolves_the_oldest_running_card_of_that_tool() {
        let mut timeline = Vec::new();
        apply_pre_tool_use(
            &mut timeline,
            &pre("Bash", Some("old"), json!({ "command": "sleep 10" })),
            1_000,
        );
        apply_pre_tool_use(
            &mut timeline,
            &pre("Read", Some("other-tool"), json!({ "file_path": "a.rs" })),
            1_100,
        );
        apply_pre_tool_use(
            &mut timeline,
            &pre("Bash", Some("new"), json!({ "command": "sleep 1" })),
            1_200,
        );

        // No tool_use_id — the older Claude Code payload shape.
        let (resolved, _) = apply_post_tool_use(
            &mut timeline,
            &post(
                "Bash",
                None,
                json!({ "command": "sleep 1" }),
                json!({ "output": "ok" }),
            ),
            2_000,
        );
        assert_eq!(resolved.id, "old", "oldest running card of that tool wins");
        assert_eq!(timeline.len(), 3, "nothing new appended");
        let status = |id: &str| {
            timeline
                .iter()
                .find(|e| e.id == id)
                .map(|e| e.status.clone())
                .unwrap()
        };
        assert_eq!(status("new"), "running");
        assert_eq!(
            status("other-tool"),
            "running",
            "a different tool is untouched"
        );
    }

    /// The case FIFO gets wrong — and the reason id correlation exists: two
    /// overlapping calls to the same tool that finish out of order.
    #[test]
    fn overlapping_same_tool_calls_resolve_by_id() {
        let mut timeline = Vec::new();
        apply_pre_tool_use(
            &mut timeline,
            &pre("Bash", Some("first"), json!({ "command": "npm run build" })),
            1_000,
        );
        apply_pre_tool_use(
            &mut timeline,
            &pre("Bash", Some("second"), json!({ "command": "git status" })),
            1_100,
        );

        // The second call finishes first.
        let (b, _) = apply_post_tool_use(
            &mut timeline,
            &post(
                "Bash",
                Some("second"),
                json!({ "command": "git status" }),
                json!({ "output": "clean" }),
            ),
            1_300,
        );
        assert_eq!(b.id, "second");
        assert_eq!(b.duration_ms, Some(200));
        assert_eq!(
            timeline[0].status, "running",
            "the first call is still going"
        );

        let (a, _) = apply_post_tool_use(
            &mut timeline,
            &post(
                "Bash",
                Some("first"),
                json!({ "command": "npm run build" }),
                json!({ "is_error": true, "output": "build failed" }),
            ),
            9_000,
        );
        assert_eq!(a.id, "first");
        assert_eq!(a.status, "error");
        assert_eq!(a.duration_ms, Some(8_000));
        assert_eq!(timeline.len(), 2);
        assert_eq!(timeline[0].output.as_deref(), Some("build failed"));
        assert_eq!(timeline[1].output.as_deref(), Some("clean"));
    }

    // ---- eviction -----------------------------------------------------------

    /// The regression the running-card exemption in `push_timeline` exists for:
    /// evicting a card whose PostToolUse hasn't arrived makes that Post open a
    /// duplicate (with no duration) instead of resolving the original.
    #[test]
    fn eviction_never_drops_a_running_card() {
        let mut timeline = Vec::new();
        let (running, _) = apply_pre_tool_use(
            &mut timeline,
            &pre(
                "Bash",
                Some("long-runner"),
                json!({ "command": "npm run build" }),
            ),
            1_000,
        );
        assert_eq!(running.status, "running");

        // Flood past the cap with settled cards.
        let mut dropped = 0;
        for i in 0..TIMELINE_CAP + 10 {
            dropped += push_timeline(
                &mut timeline,
                settled(&format!("filler-{i}"), 2_000 + i as u64),
            );
        }
        assert_eq!(dropped, 11, "every push past the cap evicts exactly one");
        assert_eq!(timeline.len(), TIMELINE_CAP);
        assert_eq!(
            timeline[0].id, "long-runner",
            "the oldest card survived because it is still running"
        );
        assert!(
            !timeline.iter().any(|e| e.id == "filler-0"),
            "the oldest *settled* cards are what got evicted"
        );

        // And the late Post still resolves it rather than duplicating it.
        let before = timeline.len();
        let (resolved, _) = apply_post_tool_use(
            &mut timeline,
            &post(
                "Bash",
                Some("long-runner"),
                json!({ "command": "npm run build" }),
                json!({ "output": "done" }),
            ),
            60_000,
        );
        assert_eq!(resolved.id, "long-runner");
        assert_eq!(resolved.status, "success");
        assert_eq!(resolved.duration_ms, Some(59_000));
        assert_eq!(timeline.len(), before, "resolved in place, no duplicate");
    }

    #[test]
    fn eviction_reports_what_it_dropped() {
        let mut timeline: Vec<TimelineEvent> = (0..TIMELINE_CAP)
            .map(|i| settled(&format!("old-{i}"), i as u64))
            .collect();
        let (_, dropped) = apply_pre_tool_use(
            &mut timeline,
            &pre("Bash", Some("newest"), json!({ "command": "ls" })),
            9_999,
        );
        assert_eq!(dropped, 1);
        assert_eq!(timeline.len(), TIMELINE_CAP);
        assert!(!timeline.iter().any(|e| e.id == "old-0"));
        assert!(timeline.iter().any(|e| e.id == "newest"));
    }

    // ---- settle -------------------------------------------------------------

    #[test]
    fn settle_running_interrupts_rather_than_errors() {
        let mut timeline = Vec::new();
        apply_pre_tool_use(
            &mut timeline,
            &pre(
                "Bash",
                Some("stuck"),
                json!({ "command": "tail -f app.log" }),
            ),
            1_000,
        );
        apply_pre_tool_use(
            &mut timeline,
            &pre("Read", Some("done"), json!({ "file_path": "a.rs" })),
            1_100,
        );
        apply_post_tool_use(
            &mut timeline,
            &post(
                "Read",
                Some("done"),
                json!({ "file_path": "a.rs" }),
                json!({ "output": "…" }),
            ),
            1_200,
        );
        apply_pre_tool_use(
            &mut timeline,
            &pre(
                "Bash",
                Some("also-stuck"),
                json!({ "command": "sleep 999" }),
            ),
            1_300,
        );

        let settled_now = settle_running(&mut timeline, 5_000);
        assert_eq!(settled_now.len(), 2);
        for card in &settled_now {
            assert_eq!(card.status, "interrupted", "never a false 'error'");
            assert!(card.duration_ms.is_some(), "how long it ran before dying");
        }
        assert_eq!(settled_now[0].duration_ms, Some(4_000));
        assert_eq!(
            timeline.iter().find(|e| e.id == "done").unwrap().status,
            "success",
            "already-resolved cards are untouched"
        );
        assert!(
            settle_running(&mut timeline, 6_000).is_empty(),
            "nothing left running on a second pass"
        );
    }

    // ---- notification heuristic --------------------------------------------

    #[test]
    fn notification_blocks_only_on_permission_shaped_text() {
        let cases: &[(&str, AgentState)] = &[
            // What actually arrives: the ~60s idle ping. Sessions run with
            // --dangerously-skip-permissions, so this is the common case and it
            // means "waiting on you", not "blocked on an approval".
            ("Claude is waiting for your input", AgentState::Idle),
            ("claude is waiting for your input", AgentState::Idle),
            ("Task complete", AgentState::Idle),
            ("", AgentState::Idle),
            // Permission/approval shaped.
            (
                "Claude needs your permission to use Bash",
                AgentState::Blocked,
            ),
            ("Approve this plan?", AgentState::Blocked),
            ("APPROVAL required to continue", AgentState::Blocked),
            ("Please confirm before I force-push", AgentState::Blocked),
            ("Waiting for your input on the plan", AgentState::Blocked),
            // The idle phrase does not launder an approval request.
            (
                "Claude is waiting for your input to approve the plan",
                AgentState::Blocked,
            ),
        ];
        for (message, want) in cases {
            let (state, reason) = notification_state(message);
            assert_eq!(state, *want, "case: {message:?} (reason: {reason})");
        }
        assert_eq!(
            notification_state("Claude is waiting for your input").1,
            "idle_ping"
        );
        assert_eq!(
            notification_state("Claude needs your permission to use Bash").1,
            "needs_input"
        );
    }
}
