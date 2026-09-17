use std::fs;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

/// One tool event parsed from a transcript line.
pub enum Record {
    /// A tool call started (assistant `tool_use` block).
    Start {
        id: String,
        tool: String,
        command: Option<String>,
        ts: u64,
    },
    /// A tool call finished (user `tool_result` block).
    End {
        id: String,
        is_error: bool,
        output: Option<String>,
        ts: u64,
    },
    /// The model an assistant turn ran on (`message.model`). Used to show the
    /// session's *actual* current model — the ground truth the CLI records —
    /// rather than optimistically trusting a switch that may be declined.
    Model { model: String },
    /// Token usage from an assistant turn (`message.usage`), split per priced
    /// kind. Powers both the context meter (via `usage.context_tokens()`) and
    /// cost.
    ///
    /// `message_id` and `request_id` are carried because Claude Code writes ONE
    /// RECORD PER CONTENT BLOCK, each repeating this same usage object. Summing
    /// per line inflates every total (2.2x-3.3x measured). Whichever key wins,
    /// de-duplication needs it at hand — so capture both and decide upstream.
    Usage {
        usage: TokenUsage,
        model: Option<String>,
        message_id: Option<String>,
        request_id: Option<String>,
    },
}

/// Per-turn token usage, split by the kinds that price differently.
///
/// The three input kinds used to be collapsed into one number. That is correct
/// for the context meter — occupancy is occupancy, whatever it cost — and badly
/// wrong for money: measured against real transcripts, charging cache reads at
/// the base input rate overstates an Opus 5 session by **7.2x**, because ~97% of
/// its input tokens are cache reads priced at 0.1x base. So the meter keeps the
/// sum (see [`TokenUsage::context_tokens`]) and cost gets the breakdown.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct TokenUsage {
    /// Uncached input — `usage.input_tokens`. The 1x reference rate.
    pub input: u64,
    /// Cache read/refresh — `usage.cache_read_input_tokens`. ~0.1x input.
    #[serde(rename = "cacheRead")]
    pub cache_read: u64,
    /// Cache write at 5-minute TTL. 1.25x input.
    #[serde(rename = "cacheWrite5m")]
    pub cache_write_5m: u64,
    /// Cache write at 1-hour TTL. 2x input. Claude Code writes mostly 1h, so
    /// 2x — not 1.25x — is the right mental default for this app.
    #[serde(rename = "cacheWrite1h")]
    pub cache_write_1h: u64,
    /// Generated tokens. Already includes thinking tokens; never add those on
    /// top or output is double-counted.
    pub output: u64,
}

impl TokenUsage {
    /// Context-window occupancy: every input-side token, whatever it cost.
    /// This is the only thing the old collapsed number was ever right for.
    pub fn context_tokens(&self) -> u64 {
        self.input + self.cache_read + self.cache_write_5m + self.cache_write_1h
    }

    pub fn is_zero(&self) -> bool {
        self.context_tokens() == 0 && self.output == 0
    }

    /// Parse `message.usage`. Returns `None` when the block is absent or all
    /// zero — `<synthetic>` turns carry an all-zero usage and must not reach
    /// pricing, where they would trip the unknown-model banner for no reason.
    pub fn parse(v: &Value) -> Option<Self> {
        let u = &v["message"]["usage"];
        if !u.is_object() {
            return None;
        }
        let n = |k: &str| u[k].as_u64().unwrap_or(0);

        // The per-TTL split lives in a nested object. When it is absent (older
        // CLI writes), attribute the total to the 5m bucket: that is the
        // CHEAPER write rate, so a legacy transcript is under-priced rather
        // than charged a 2x rate it may never have incurred. Understating on
        // data we cannot read beats inventing a number.
        let cc = &u["cache_creation"];
        let (w5, w1) = if cc.is_object() {
            (
                cc["ephemeral_5m_input_tokens"].as_u64().unwrap_or(0),
                cc["ephemeral_1h_input_tokens"].as_u64().unwrap_or(0),
            )
        } else {
            (n("cache_creation_input_tokens"), 0)
        };

        let usage = TokenUsage {
            input: n("input_tokens"),
            cache_read: n("cache_read_input_tokens"),
            cache_write_5m: w5,
            cache_write_1h: w1,
            output: n("output_tokens"),
        };
        if usage.is_zero() {
            return None;
        }
        Some(usage)
    }
}

/// Context tokens for one assistant turn: input side = context-window fill.
///
/// Thin wrapper over [`TokenUsage`] for callers that only want occupancy.
pub fn usage_from(v: &Value) -> Option<(u64, u64)> {
    TokenUsage::parse(v).map(|u| (u.context_tokens(), u.output))
}

/// Tails a session transcript JSONL, emitting tool Start/End records as new
/// lines are appended. Only new bytes are read on each poll, so it stays cheap
/// on large transcripts. Claude Code writes the transcript regardless of hooks,
/// so this populates the timeline even when hooks are off, and persists across
/// restarts / resume.
pub struct Tailer {
    path: Option<PathBuf>,
    offset: u64,
    cwd: String,
    session_id: Option<String>,
    after_ms: u64,
    /// One tail per discovered subagent transcript. Grows as Tasks spawn.
    subs: Vec<SubTail>,
}

struct SubTail {
    file: SubagentFile,
    offset: u64,
}

/// A record plus which transcript it came from.
///
/// Subagent spend is not a footnote: measured on a real session, subagents were
/// 1.79x the parent. Attribution has to survive parsing, or the panel cannot
/// nest a child under the call that spawned it.
pub struct Tailed {
    /// `None` = the parent session; `Some(agent_id)` = that subagent.
    pub agent_id: Option<String>,
    pub record: Record,
}

impl Tailed {
    fn parent(record: Record) -> Self {
        Self {
            agent_id: None,
            record,
        }
    }
}

impl Tailer {
    pub fn new(cwd: String, session_id: Option<String>, after_ms: u64) -> Self {
        Self {
            path: None,
            offset: 0,
            cwd,
            session_id,
            after_ms,
            subs: Vec::new(),
        }
    }

    pub fn set_session_id(&mut self, sid: &str) {
        if self.session_id.as_deref() != Some(sid) {
            self.session_id = Some(sid.to_string());
            // Re-resolve against the exact file next poll.
            self.path = None;
            self.offset = 0;
            self.subs.clear();
        }
    }

    /// Read any newly-appended records, from the parent transcript **and** from
    /// every subagent transcript beneath it. Returns [] when nothing changed.
    pub fn poll(&mut self) -> Vec<Tailed> {
        if self.path.is_none() {
            self.path = locate(&self.cwd, self.session_id.as_deref(), self.after_ms);
            self.offset = 0;
            self.subs.clear();
        }
        let Some(path) = self.path.clone() else {
            return Vec::new();
        };

        let mut out = Vec::new();
        match read_new(&path, &mut self.offset) {
            Some(records) => out.extend(records.into_iter().map(Tailed::parent)),
            None => {
                self.path = None; // vanished (rotation) — re-resolve next poll
                return Vec::new();
            }
        }

        // Subagents are discovered on every poll, not once: a Task can spawn one
        // at any point in a session, and the sidecar is written at spawn time.
        for found in subagents_for(&path) {
            if !self.subs.iter().any(|s| s.file.agent_id == found.agent_id) {
                self.subs.push(SubTail {
                    file: found,
                    offset: 0,
                });
            }
        }
        for sub in &mut self.subs {
            if let Some(records) = read_new(&sub.file.path, &mut sub.offset) {
                let id = sub.file.agent_id.clone();
                out.extend(records.into_iter().map(|r| Tailed {
                    agent_id: Some(id.clone()),
                    record: r,
                }));
            }
        }
        out
    }
}

/// Read newly-appended complete lines from `path`, advancing `offset`.
///
/// `None` means the file could not be opened — the caller re-resolves. An empty
/// vec means nothing new, which is the common case.
fn read_new(path: &Path, offset: &mut u64) -> Option<Vec<Record>> {
    let file = fs::File::open(path).ok()?;
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    if len < *offset {
        *offset = 0; // truncated/rewritten — start over
    }
    if len == *offset {
        return Some(Vec::new());
    }

    let mut reader = BufReader::new(file);
    if reader.seek(SeekFrom::Start(*offset)).is_err() {
        return Some(Vec::new());
    }

    let mut out = Vec::new();
    let mut consumed = *offset;
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(n) => {
                // Only advance the durable offset past COMPLETE lines, so a
                // half-flushed final line is re-read next poll.
                if !line.ends_with('\n') {
                    break;
                }
                consumed += n as u64;
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    parse_record(&v, &mut out);
                }
            }
            Err(_) => break,
        }
    }
    *offset = consumed;
    Some(out)
}

fn parse_record(v: &Value, out: &mut Vec<Record>) {
    let ts = v["timestamp"].as_str().and_then(parse_iso_ms).unwrap_or(0);
    // Assistant turns record the model they ran on — the CLI's ground truth.
    if v["type"].as_str() == Some("assistant") {
        if let Some(model) = v["message"]["model"].as_str() {
            out.push(Record::Model {
                model: model.to_string(),
            });
        }
        if let Some(usage) = TokenUsage::parse(v) {
            out.push(Record::Usage {
                usage,
                model: v["message"]["model"].as_str().map(str::to_string),
                message_id: v["message"]["id"].as_str().map(str::to_string),
                request_id: v["requestId"].as_str().map(str::to_string),
            });
        }
    }
    let content = &v["message"]["content"];
    let Some(blocks) = content.as_array() else {
        return;
    };
    for b in blocks {
        match b["type"].as_str() {
            Some("tool_use") => {
                let Some(id) = b["id"].as_str() else { continue };
                let tool = b["name"].as_str().unwrap_or("Tool").to_string();
                out.push(Record::Start {
                    id: id.to_string(),
                    command: describe_input(&tool, &b["input"]),
                    tool,
                    ts,
                });
            }
            Some("tool_result") => {
                let Some(id) = b["tool_use_id"].as_str() else {
                    continue;
                };
                out.push(Record::End {
                    id: id.to_string(),
                    is_error: b["is_error"].as_bool().unwrap_or(false),
                    output: flatten_content(&b["content"]),
                    ts,
                });
            }
            _ => {}
        }
    }
}

/// tool_result content is either a string or an array of `{type:text,text}`.
fn flatten_content(content: &Value) -> Option<String> {
    const CAP: usize = 4000;
    let text = match content {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(|i| i["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut out: String = trimmed.chars().take(CAP).collect();
    if trimmed.chars().count() > CAP {
        out.push_str("\n… (truncated)");
    }
    Some(out)
}

fn describe_input(tool: &str, input: &Value) -> Option<String> {
    if tool == "Bash" {
        return input["command"].as_str().map(str::to_string);
    }
    for key in [
        "file_path",
        "path",
        "pattern",
        "query",
        "url",
        "description",
    ] {
        if let Some(s) = input[key].as_str() {
            return Some(s.to_string());
        }
    }
    None
}

/// Does this record drive **session-level** chrome — the model chip and the
/// context meter — rather than the timeline?
///
/// Such records are meaningful only from the parent transcript. A subagent runs
/// its own model and has its own context window, so letting a child's through
/// would misreport both.
pub fn is_session_scoped(record: &Record) -> bool {
    matches!(record, Record::Model { .. } | Record::Usage { .. })
}

/// One subagent transcript found beneath a parent session, with the sidecar
/// metadata that ties it to the tool call that spawned it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentFile {
    pub path: PathBuf,
    /// Filename stem minus the `agent-` prefix.
    pub agent_id: String,
    /// The parent `Task`/`Agent` tool-use id this run belongs to. Present in
    /// practice; `None` only if the sidecar is missing or malformed, in which
    /// case the run can still be shown, just not nested under its tool call.
    pub tool_use_id: Option<String>,
    /// Set at depth >= 2. The chain lives here, NOT in the path — subagent
    /// files stay flat under the root session however deep the nesting goes.
    pub parent_agent_id: Option<String>,
    pub agent_type: Option<String>,
    pub description: Option<String>,
}

/// The directory holding a session's subagent transcripts.
///
/// `<projects>/<slug>/<session-id>.jsonl` -> `<projects>/<slug>/<session-id>/subagents/`
fn subagent_dir(parent: &Path) -> PathBuf {
    parent.with_extension("").join("subagents")
}

/// Find the subagent transcripts belonging to an already-adopted parent.
///
/// PRIVACY-CRITICAL, and deliberately weaker than it looks: this performs **no
/// search and no guess**. The directory is derived by string construction from
/// the parent path that [`locate`] already vetted, so this inherits that
/// attribution decision wholesale rather than re-deriving it. If `locate`
/// adopted nothing, there is nothing to call this with.
///
/// Note what is NOT checked: subagents are not gated on cwd (a worktree agent
/// legitimately runs elsewhere) nor on start time (a backgrounded agent can
/// outlive the turn that spawned it). Gating on either would silently drop real
/// children. The parent's gate is the one that matters.
pub fn subagents_for(parent: &Path) -> Vec<SubagentFile> {
    let dir = subagent_dir(parent);
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new(); // no subagents ran, or none yet
    };
    // The directory is named for the session; a child must agree.
    let session_dir_name = dir
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_string();

    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue; // skips the .meta.json sidecars
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let Some(agent_id) = stem.strip_prefix("agent-") else {
            continue;
        };
        if !is_this_sessions_child(&path, &session_dir_name, agent_id) {
            continue;
        }
        let meta = read_meta(&path);
        out.push(SubagentFile {
            agent_id: agent_id.to_string(),
            tool_use_id: meta.as_ref().and_then(|m| str_field(m, "toolUseId")),
            parent_agent_id: meta.as_ref().and_then(|m| str_field(m, "parentAgentId")),
            agent_type: meta.as_ref().and_then(|m| str_field(m, "agentType")),
            description: meta.as_ref().and_then(|m| str_field(m, "description")),
            path,
        });
    }
    out.sort_by(|a, b| a.agent_id.cmp(&b.agent_id));
    out
}

fn str_field(v: &Value, key: &str) -> Option<String> {
    v[key].as_str().map(str::to_string)
}

/// The sidecar is written at spawn — ~33ms before the child's first transcript
/// line — so a subagent node can render the moment its tool call appears.
fn read_meta(jsonl: &Path) -> Option<Value> {
    let meta = jsonl.with_extension("meta.json");
    serde_json::from_str(&fs::read_to_string(meta).ok()?).ok()
}

/// Defence in depth on top of the inherited gate: the file must declare itself
/// a sidechain, name this session, and agree with its own filename.
fn is_this_sessions_child(path: &Path, session_dir_name: &str, agent_id: &str) -> bool {
    let Ok(file) = fs::File::open(path) else {
        return false;
    };
    let mut line = String::new();
    if BufReader::new(file).read_line(&mut line).is_err() {
        return false;
    }
    let Ok(v) = serde_json::from_str::<Value>(&line) else {
        return false;
    };
    if v["isSidechain"].as_bool() != Some(true) {
        return false;
    }
    if let Some(sid) = v["sessionId"].as_str() {
        if sid != session_dir_name {
            return false;
        }
    }
    match v["agentId"].as_str() {
        Some(a) => a == agent_id,
        None => true, // older writes omit it; the filename already carried it
    }
}

/// Small tolerance (ms) for the "started after we spawned" check, absorbing
/// clock jitter between our spawn timestamp and Claude's first transcript write.
const START_SLACK_MS: u64 = 3_000;

/// Find the transcript file for this session.
///
/// PRIVACY-CRITICAL attribution: a transcript is only adopted if it is
/// unambiguously THIS session's. That means either the exact
/// `<session_id>.jsonl` (known for resumed/bound sessions), or — when guessing
/// by directory — a transcript whose FIRST record timestamp is at/after this
/// session was spawned. Without the start-time gate, a different (possibly
/// private) session already running in the same directory could be picked up
/// and its commands leaked into this window's timeline.
fn locate(cwd: &str, session_id: Option<&str>, after_ms: u64) -> Option<PathBuf> {
    let projects = dirs::home_dir()?.join(".claude").join("projects");
    let dirs = fs::read_dir(&projects).ok()?;

    let mut best: Option<(u64, PathBuf)> = None;
    for entry in dirs.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        // Fast path: exact session file (resumed/bound sessions). Trusted.
        if let Some(sid) = session_id {
            let cand = dir.join(format!("{sid}.jsonl"));
            if cand.is_file() {
                return Some(cand);
            }
        }
        let Ok(files) = fs::read_dir(&dir) else {
            continue;
        };
        for f in files.flatten() {
            let path = f.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            if path
                .file_stem()
                .and_then(|s| s.to_str())
                .map(|s| s.starts_with("agent-"))
                .unwrap_or(true)
            {
                continue;
            }
            let Some((cwd_ok, start_ts)) = head_info(&path, cwd) else {
                continue;
            };
            if !cwd_ok {
                continue;
            }
            // Only adopt a transcript that STARTED at/after we spawned. A
            // pre-existing session in the same cwd started earlier → excluded.
            if start_ts + START_SLACK_MS < after_ms {
                continue;
            }
            if best.as_ref().map(|(s, _)| start_ts > *s).unwrap_or(true) {
                best = Some((start_ts, path));
            }
        }
    }
    best.map(|(_, p)| p)
}

/// Read a transcript's head: whether its session cwd matches, and the earliest
/// record timestamp (its start time). Only the first records are read.
fn head_info(path: &Path, cwd: &str) -> Option<(bool, u64)> {
    let file = fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    let mut cwd_match = false;
    let mut cwd_seen = false;
    let mut start_ts: Option<u64> = None;
    for _ in 0..60 {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if !cwd_seen {
            if let Some(c) = v["cwd"].as_str() {
                cwd_seen = true;
                cwd_match = c == cwd;
            }
        }
        if let Some(ts) = v["timestamp"].as_str().and_then(parse_iso_ms) {
            start_ts = Some(start_ts.map_or(ts, |cur| cur.min(ts)));
        }
        if cwd_seen && start_ts.is_some() {
            break;
        }
    }
    Some((cwd_match, start_ts.unwrap_or(0)))
}

/// Parse "2026-07-10T17:34:34.014Z" to epoch milliseconds. No dependency on a
/// datetime crate — the transcript format is fixed.
fn parse_iso_ms(s: &str) -> Option<u64> {
    let (date, rest) = s.split_once('T')?;
    let mut dp = date.split('-');
    let y: i64 = dp.next()?.parse().ok()?;
    let mo: i64 = dp.next()?.parse().ok()?;
    let d: i64 = dp.next()?.parse().ok()?;
    let time = rest.trim_end_matches('Z');
    let (hms, millis) = match time.split_once('.') {
        Some((a, b)) => {
            let ms: u64 = b.get(..3).unwrap_or(b).parse().ok()?;
            (a, ms)
        }
        None => (time, 0),
    };
    let mut tp = hms.split(':');
    let h: u64 = tp.next()?.parse().ok()?;
    let mi: u64 = tp.next()?.parse().ok()?;
    let se: u64 = tp.next()?.parse().ok()?;

    // days from civil (Howard Hinnant's algorithm)
    let y = if mo <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;

    let secs = days * 86400 + (h * 3600 + mi * 60 + se) as i64;
    Some((secs as u64) * 1000 + millis)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The split is the whole point: these three price 1x / 0.1x / 1.25x / 2x,
    /// so collapsing them is what produced the 7.2x overstatement.
    #[test]
    fn usage_splits_by_priced_kind() {
        let v: Value = serde_json::from_str(
            r#"{"type":"assistant","message":{"id":"msg_1","model":"claude-opus-5","usage":{
                "input_tokens":100,
                "cache_read_input_tokens":9000,
                "cache_creation_input_tokens":500,
                "cache_creation":{"ephemeral_5m_input_tokens":200,"ephemeral_1h_input_tokens":300},
                "output_tokens":42}}}"#,
        )
        .unwrap();
        let u = TokenUsage::parse(&v).expect("usage present");
        assert_eq!(u.input, 100);
        assert_eq!(u.cache_read, 9000);
        assert_eq!(u.cache_write_5m, 200);
        assert_eq!(u.cache_write_1h, 300);
        assert_eq!(u.output, 42);
        // The TTL split must reconcile with the flat total the API also sends.
        assert_eq!(u.cache_write_5m + u.cache_write_1h, 500);
        // Occupancy is every input-side token, whatever it cost.
        // 100 + 9000 + 200 + 300. Identical to what the OLD collapsed formula
        // (input + cache_read + cache_creation) produced, which is the point:
        // splitting changes what cost can see, never what the meter reports.
        assert_eq!(u.context_tokens(), 9600);
        assert_eq!(usage_from(&v), Some((9600, 42)));
    }

    /// Older CLI writes carry no per-TTL object. Attribute to the CHEAPER
    /// bucket so such a transcript is under-priced rather than charged a 2x
    /// rate it may never have incurred.
    #[test]
    fn usage_without_ttl_split_falls_back_to_5m() {
        let v: Value = serde_json::from_str(
            r#"{"type":"assistant","message":{"usage":{
                "input_tokens":10,"cache_creation_input_tokens":700,"output_tokens":1}}}"#,
        )
        .unwrap();
        let u = TokenUsage::parse(&v).unwrap();
        assert_eq!(u.cache_write_5m, 700);
        assert_eq!(u.cache_write_1h, 0);
        assert_eq!(u.context_tokens(), 710);
    }

    /// `<synthetic>` turns carry an all-zero usage block. They must not reach
    /// pricing, where an unknown model id would raise an "Unpriced" banner over
    /// a turn that cost nothing.
    #[test]
    fn all_zero_usage_is_dropped() {
        let v: Value = serde_json::from_str(
            r#"{"type":"assistant","message":{"model":"<synthetic>","usage":{
                "input_tokens":0,"cache_read_input_tokens":0,
                "cache_creation_input_tokens":0,"output_tokens":0}}}"#,
        )
        .unwrap();
        assert!(TokenUsage::parse(&v).is_none());
        assert!(usage_from(&v).is_none());
    }

    #[test]
    fn missing_usage_block_is_none() {
        let v: Value = serde_json::from_str(r#"{"type":"assistant","message":{}}"#).unwrap();
        assert!(TokenUsage::parse(&v).is_none());
    }

    /// Dedup keys must survive parsing: Claude Code repeats one usage object
    /// across every content block of a turn, so summing per record inflates
    /// totals. Whichever key wins, both have to be on the record.
    #[test]
    fn usage_record_carries_dedup_keys() {
        let v: Value = serde_json::from_str(
            r#"{"type":"assistant","requestId":"req_abc","message":{
                "id":"msg_xyz","model":"claude-opus-5",
                "usage":{"input_tokens":5,"output_tokens":5}}}"#,
        )
        .unwrap();
        let mut out = Vec::new();
        parse_record(&v, &mut out);
        let found = out.iter().find_map(|r| match r {
            Record::Usage {
                message_id,
                request_id,
                model,
                ..
            } => Some((message_id.clone(), request_id.clone(), model.clone())),
            _ => None,
        });
        assert_eq!(
            found,
            Some((
                Some("msg_xyz".into()),
                Some("req_abc".into()),
                Some("claude-opus-5".into())
            ))
        );
    }

    /// Build `<tmp>/<uniq>/<slug>/<sid>.jsonl` plus a `subagents/` dir, and
    /// return the parent transcript path. No tempfile crate in this project, so
    /// uniqueness comes from the test name + pid.
    fn scratch(tag: &str) -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("cv-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let slug = root.join("slug");
        let sid = "44d945fe-203a-46dd-9f3d-e248cc3108ae";
        let subs = slug.join(sid).join("subagents");
        fs::create_dir_all(&subs).unwrap();
        let parent = slug.join(format!("{sid}.jsonl"));
        fs::write(&parent, "{}\n").unwrap();
        (parent, subs)
    }

    fn write_child(subs: &Path, agent_id: &str, session_id: &str, sidechain: bool, tool_use: &str) {
        let line = serde_json::json!({
            "isSidechain": sidechain,
            "sessionId": session_id,
            "agentId": agent_id,
            "type": "assistant"
        });
        fs::write(
            subs.join(format!("agent-{agent_id}.jsonl")),
            format!("{line}\n"),
        )
        .unwrap();
        fs::write(
            subs.join(format!("agent-{agent_id}.meta.json")),
            serde_json::json!({
                "toolUseId": tool_use,
                "agentType": "general-purpose",
                "description": "Research pricing"
            })
            .to_string(),
        )
        .unwrap();
    }

    const SID: &str = "44d945fe-203a-46dd-9f3d-e248cc3108ae";

    #[test]
    fn finds_subagents_and_their_parent_tool_call() {
        let (parent, subs) = scratch("find");
        write_child(&subs, "a1705fdcf7a898a7e", SID, true, "toolu_01ABC");
        let found = subagents_for(&parent);
        assert_eq!(found.len(), 1, "expected exactly one subagent");
        assert_eq!(found[0].agent_id, "a1705fdcf7a898a7e");
        // The linkage that lets a subagent nest under the call that spawned it.
        assert_eq!(found[0].tool_use_id.as_deref(), Some("toolu_01ABC"));
        assert_eq!(found[0].agent_type.as_deref(), Some("general-purpose"));
        let _ = fs::remove_dir_all(parent.parent().unwrap().parent().unwrap());
    }

    /// The sidecars sit in the same directory and must never be mistaken for
    /// transcripts — `.meta.json` is not `.jsonl`.
    #[test]
    fn meta_sidecars_are_not_mistaken_for_transcripts() {
        let (parent, subs) = scratch("meta");
        write_child(&subs, "abc123", SID, true, "toolu_1");
        assert_eq!(
            fs::read_dir(&subs).unwrap().count(),
            2,
            "fixture writes both files"
        );
        assert_eq!(subagents_for(&parent).len(), 1);
        let _ = fs::remove_dir_all(parent.parent().unwrap().parent().unwrap());
    }

    /// Defence in depth. A file that names a DIFFERENT session must be refused
    /// even though it sits in this session's directory — mis-attribution would
    /// leak another session's commands into this window.
    #[test]
    fn a_child_naming_another_session_is_refused() {
        let (parent, subs) = scratch("wrongsid");
        write_child(
            &subs,
            "abc123",
            "11111111-2222-3333-4444-555555555555",
            true,
            "toolu_1",
        );
        assert!(subagents_for(&parent).is_empty());
        let _ = fs::remove_dir_all(parent.parent().unwrap().parent().unwrap());
    }

    /// A subagent transcript declares itself a sidechain. Anything that does not
    /// is not a subagent, whatever its filename says.
    #[test]
    fn a_non_sidechain_file_is_refused() {
        let (parent, subs) = scratch("nosc");
        write_child(&subs, "abc123", SID, false, "toolu_1");
        assert!(subagents_for(&parent).is_empty());
        let _ = fs::remove_dir_all(parent.parent().unwrap().parent().unwrap());
    }

    /// No subagents ran: absence is normal, not an error.
    #[test]
    fn a_session_with_no_subagents_yields_none() {
        let (parent, _subs) = scratch("empty");
        assert!(subagents_for(&parent).is_empty());
        let _ = fs::remove_dir_all(parent.parent().unwrap().parent().unwrap());
    }

    /// The directory is derived by string construction from the already-vetted
    /// parent path — no search, so no new attribution guess is introduced.
    #[test]
    fn subagent_dir_is_derived_from_the_parent_path() {
        let p = Path::new("/home/u/.claude/projects/slug/abc-123.jsonl");
        assert_eq!(
            subagent_dir(p),
            Path::new("/home/u/.claude/projects/slug/abc-123/subagents")
        );
    }

    /// End-to-end against this machine's real `~/.claude/projects` layout.
    /// Skips silently when no session on this box has spawned a subagent — the
    /// fixture tests above already cover the logic; this one guards against the
    /// on-disk layout drifting out from under us, which is exactly how the
    /// previous `agent-*` skip became dead code without anyone noticing.
    #[test]
    fn finds_real_subagents_on_this_machine() {
        let Some(projects) = dirs::home_dir().map(|h| h.join(".claude/projects")) else {
            return;
        };
        let Ok(slugs) = fs::read_dir(&projects) else {
            return;
        };
        let mut checked = 0;
        for slug in slugs.flatten() {
            let Ok(files) = fs::read_dir(slug.path()) else {
                continue;
            };
            for f in files.flatten() {
                let path = f.path();
                if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                if !subagent_dir(&path).is_dir() {
                    continue;
                }
                let found = subagents_for(&path);
                let on_disk = fs::read_dir(subagent_dir(&path))
                    .map(|d| {
                        d.flatten()
                            .filter(|e| {
                                e.path().extension().and_then(|x| x.to_str()) == Some("jsonl")
                            })
                            .count()
                    })
                    .unwrap_or(0);
                eprintln!(
                    "{}: {} subagent transcripts on disk, {} adopted",
                    path.file_name().unwrap().to_string_lossy(),
                    on_disk,
                    found.len()
                );
                // Every real child must pass the checks; a rejection here means
                // the layout or the validation drifted.
                assert_eq!(
                    found.len(),
                    on_disk,
                    "adopted fewer children than exist on disk"
                );
                for s in &found {
                    assert!(!s.agent_id.is_empty());
                    assert!(
                        s.tool_use_id.is_some(),
                        "sidecar should link {} to its spawning tool call",
                        s.agent_id
                    );
                }
                checked += found.len();
            }
        }
        eprintln!("verified {checked} real subagent transcripts");
    }

    #[test]
    fn only_model_and_usage_are_session_scoped() {
        let usage = Record::Usage {
            usage: TokenUsage::default(),
            model: None,
            message_id: None,
            request_id: None,
        };
        assert!(is_session_scoped(&usage));
        assert!(is_session_scoped(&Record::Model {
            model: "claude-opus-5".into()
        }));
        // Tool activity is per-agent and DOES belong in the timeline, whichever
        // transcript it came from — that is the whole point of reading them.
        assert!(!is_session_scoped(&Record::Start {
            id: "toolu_1".into(),
            tool: "Bash".into(),
            command: None,
            ts: 0,
        }));
        assert!(!is_session_scoped(&Record::End {
            id: "toolu_1".into(),
            is_error: false,
            output: None,
            ts: 0,
        }));
    }

    #[test]
    fn iso_parse() {
        let ms = parse_iso_ms("2026-07-10T17:34:34.014Z").unwrap();
        assert!(ms > 1_780_000_000_000 && ms < 1_800_000_000_000, "{ms}");
        // millis precision preserved
        assert_eq!(ms % 1000, 14);
    }

    #[test]
    fn parses_real_transcript() {
        let projects = match dirs::home_dir() {
            Some(h) => h.join(".claude/projects"),
            None => return,
        };
        let Ok(dirs) = fs::read_dir(&projects) else {
            return;
        };
        let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;
        for d in dirs.flatten() {
            if !d.path().is_dir() {
                continue;
            }
            let Ok(files) = fs::read_dir(d.path()) else {
                continue;
            };
            for f in files.flatten() {
                let p = f.path();
                if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                if p.file_stem()
                    .and_then(|s| s.to_str())
                    .map(|s| s.starts_with("agent-"))
                    .unwrap_or(true)
                {
                    continue;
                }
                if let Ok(m) = f.metadata().and_then(|m| m.modified()) {
                    if newest.as_ref().map(|(t, _)| m > *t).unwrap_or(true) {
                        newest = Some((m, p));
                    }
                }
            }
        }
        let Some((_, path)) = newest else { return };
        let (mut starts, mut ends) = (0, 0);
        let file = fs::File::open(&path).unwrap();
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                let mut recs = Vec::new();
                parse_record(&v, &mut recs);
                for r in recs {
                    match r {
                        Record::Start { .. } => starts += 1,
                        Record::End { .. } => ends += 1,
                        Record::Model { .. } => {}
                        Record::Usage { .. } => {}
                    }
                }
            }
        }
        eprintln!("parsed {starts} tool_use + {ends} tool_result from {path:?}");
        assert!(starts > 0, "expected tool_use records in a real transcript");
        assert!(
            ends > 0,
            "expected tool_result records in a real transcript"
        );
    }
}
