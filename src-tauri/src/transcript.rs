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
}

impl Tailer {
    pub fn new(cwd: String, session_id: Option<String>, after_ms: u64) -> Self {
        Self {
            path: None,
            offset: 0,
            cwd,
            session_id,
            after_ms,
        }
    }

    pub fn set_session_id(&mut self, sid: &str) {
        if self.session_id.as_deref() != Some(sid) {
            self.session_id = Some(sid.to_string());
            // Re-resolve against the exact file next poll.
            self.path = None;
            self.offset = 0;
        }
    }

    /// Read any newly-appended records. Returns [] when nothing changed.
    pub fn poll(&mut self) -> Vec<Record> {
        if self.path.is_none() {
            self.path = locate(&self.cwd, self.session_id.as_deref(), self.after_ms);
            self.offset = 0;
        }
        let Some(path) = self.path.clone() else {
            return Vec::new();
        };

        let Ok(file) = fs::File::open(&path) else {
            self.path = None; // file vanished (rotation) — re-resolve later
            return Vec::new();
        };
        let len = file.metadata().map(|m| m.len()).unwrap_or(0);
        if len < self.offset {
            // Truncated/rewritten — start over.
            self.offset = 0;
        }
        if len == self.offset {
            return Vec::new();
        }

        let mut reader = BufReader::new(file);
        if reader.seek(SeekFrom::Start(self.offset)).is_err() {
            return Vec::new();
        }

        let mut out = Vec::new();
        let mut consumed = self.offset;
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
        self.offset = consumed;
        out
    }
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
