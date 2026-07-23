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
use crate::session::{now_ms, Registry, Session, TimelineEvent};

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
        .route("/sessions", post(sessions_handler).get(list_sessions_handler))
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
        json!({ "type": "timeline_snapshot", "events": &*timeline })
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
            .send(Message::Text(json!({ "type": "model", "model": model }).to_string()))
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
            .send(Message::Text(json!({ "type": "exit", "code": code }).to_string()))
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

    let event = v["hook_event_name"].as_str().unwrap_or_default().to_string();
    let session_id = v["session_id"].as_str().map(str::to_string);
    let viewer_id = header_viewer_id(&headers);

    // Bind eagerly on any event that carries session_id — SessionStart is the
    // designed path, but this also self-heals if SessionStart was missed.
    if let (Some(vid), Some(sid)) = (&viewer_id, &session_id) {
        let already_bound = state
            .registry
            .get(vid)
            .and_then(|s| s.session_id.read().clone())
            .is_some();
        if !already_bound {
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

    match event.as_str() {
        "PreToolUse" => on_pre_tool_use(&session, &v),
        "PostToolUse" => on_post_tool_use(&session, &v),
        "SessionEnd" => {
            // The PTY waiter thread owns the authoritative "ended" state; the
            // hook just settles any cards still marked running.
            settle_running_cards(&session);
        }
        _ => {}
    }
    StatusCode::OK
}

/// Best-effort human-readable subject for a tool call card.
fn describe_input(tool_name: &str, tool_input: &Value) -> Option<String> {
    if tool_name == "Bash" {
        return tool_input["command"].as_str().map(str::to_string);
    }
    for key in ["file_path", "path", "pattern", "query", "url", "description"] {
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

fn on_pre_tool_use(session: &Arc<Session>, v: &Value) {
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
        command: describe_input(&tool, &v["tool_input"]),
        status: "running".into(),
        duration_ms: None,
        ts: now_ms(),
        output: None,
    };
    session.timeline.lock().push(event.clone());
    session.send_control(json!({ "type": "timeline", "event": event }));
}

fn on_post_tool_use(session: &Arc<Session>, v: &Value) {
    let tool = v["tool_name"].as_str().unwrap_or("Tool").to_string();
    let ts = now_ms();

    // Hook payloads don't carry a reliable success flag across versions; treat
    // an error-shaped tool_response defensively and default to success.
    let resp = &v["tool_response"];
    let is_error = resp["is_error"].as_bool().unwrap_or(false)
        || resp["success"].as_bool().map(|s| !s).unwrap_or(false)
        || (resp.is_object() && resp["error"].is_string());
    let status = if is_error { "error" } else { "success" };

    // Extract/serialize output BEFORE taking the lock — a large tool_response
    // would otherwise hold the timeline mutex through a heavy allocation and
    // stall concurrent hook handlers.
    let output = extract_output(resp);

    let tool_use_id = v["tool_use_id"].as_str();
    let mut timeline = session.timeline.lock();
    // FIFO note: without tool_use_id, we resolve the oldest running card for
    // this tool. This misattributes when two same-tool calls (e.g. a subagent's
    // Bash) overlap; recent Claude Code emits tool_use_id, which is exact.
    let entry = match tool_use_id {
        Some(id) => timeline.iter_mut().find(|e| e.id == id),
        None => timeline
            .iter_mut()
            .find(|e| e.status == "running" && e.tool == tool),
    };

    let updated = if let Some(entry) = entry {
        entry.status = status.into();
        entry.duration_ms = Some(ts.saturating_sub(entry.ts));
        entry.output = output;
        entry.clone()
    } else {
        // PostToolUse without a matching Pre (e.g. viewer attached mid-call).
        let event = TimelineEvent {
            id: tool_use_id
                .map(str::to_string)
                .unwrap_or_else(|| Uuid::new_v4().to_string()),
            kind: "command".into(),
            tool: tool.clone(),
            command: describe_input(&tool, &v["tool_input"]),
            status: status.into(),
            duration_ms: None,
            ts,
            output,
        };
        timeline.push(event.clone());
        event
    };
    drop(timeline);
    session.send_control(json!({ "type": "timeline", "event": updated }));
}

fn settle_running_cards(session: &Arc<Session>) {
    let ts = now_ms();
    let mut updates = Vec::new();
    {
        let mut timeline = session.timeline.lock();
        // These cards never got a PostToolUse before the session ended. That's
        // not necessarily a failure (the Post may have been dropped or the
        // command interrupted), so use a distinct "interrupted" status rather
        // than falsely reporting "error".
        for entry in timeline.iter_mut().filter(|e| e.status == "running") {
            entry.status = "interrupted".into();
            entry.duration_ms = Some(ts.saturating_sub(entry.ts));
            updates.push(entry.clone());
        }
    }
    for event in updates {
        session.send_control(json!({ "type": "timeline", "event": event }));
    }
}
