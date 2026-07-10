use std::fs;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};

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
                let Some(id) = b["tool_use_id"].as_str() else { continue };
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
    for key in ["file_path", "path", "pattern", "query", "url", "description"] {
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
    let yoe = (y - era * 400) as i64;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;

    let secs = days * 86400 + (h * 3600 + mi * 60 + se) as i64;
    Some((secs as u64) * 1000 + millis)
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let Ok(dirs) = fs::read_dir(&projects) else { return };
        let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;
        for d in dirs.flatten() {
            if !d.path().is_dir() {
                continue;
            }
            let Ok(files) = fs::read_dir(d.path()) else { continue };
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
                    }
                }
            }
        }
        eprintln!("parsed {starts} tool_use + {ends} tool_result from {path:?}");
        assert!(starts > 0, "expected tool_use records in a real transcript");
        assert!(ends > 0, "expected tool_result records in a real transcript");
    }
}
