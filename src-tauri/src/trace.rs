//! Paged reads of a session's full trace, straight from the transcripts on disk.
//!
//! Decided in issue #18, on measurement rather than instinct: the largest real
//! transcript here is 13.06 MB / 4,688 lines / 2,199 content blocks and parses
//! end to end in **46 ms**, of which only 0.41 MB is prose a reader looks at.
//! There is no reason to hold that in memory, so the disk is authoritative and
//! Rust caches nothing. History is pulled a page at a time; only the live tail
//! is pushed over the WebSocket.
//!
//! ## Why the cursor is opaque rather than a bare integer
//!
//! #18 says the cursor must derive from **byte offset**, never a counter that
//! resets when a file is re-resolved — otherwise a cursor goes stale in silence
//! after rotation. A session is not one file though: it is the parent plus one
//! transcript per subagent, each appended to independently. A single integer
//! cannot address a position in several files at once, and a global sequence
//! number computed by sorting would *renumber earlier entries* the moment a
//! late-writing subagent inserts among them — which is exactly the silent
//! staleness the rule exists to prevent.
//!
//! So the cursor is a per-file offset map, encoded opaquely. It obeys the same
//! rule #18 laid down, extended to the multi-file reality that ticket already
//! described elsewhere in its own body.

use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::transcript::{subagents_for, SubagentFile};

/// How many entries a page returns when the caller does not say.
pub const DEFAULT_LIMIT: usize = 200;
/// Hard ceiling, so one request cannot ask for an entire 13 MB session at once.
pub const MAX_LIMIT: usize = 1000;
/// Cap on any single text field. Full tool output is fetched on demand via
/// `persistedOutputPath` (#12), so a page never has to carry 133 KB of it.
const TEXT_CAP: usize = 4000;

/// What kind of thing happened. The five content kinds from issue #15.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Prompt,
    Assistant,
    Thinking,
    Tool,
    ToolResult,
}

/// One entry in the trace.
///
/// Flat and ordered, per #15: nesting is a rendered affordance, not a shape the
/// data is coerced into, because search, filter and export all fight a tree.
#[derive(Debug, Clone, Serialize)]
pub struct Entry {
    pub kind: Kind,
    /// Position within its own file. Combined with `source`, this is the
    /// cursor: monotonic, append-only, and never renumbered.
    pub offset: u64,
    /// Which transcript this came from: `None` = parent, `Some(agent_id)`.
    #[serde(rename = "agentId", skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    /// The turn this belongs to — `requestId`, else `message.id`. Same key the
    /// cost ledger uses, so a turn's entries and its price line up.
    #[serde(rename = "turnId", skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    pub ts: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    /// `tool_use.id` / `tool_result.tool_use_id`, for pairing a call with its result.
    #[serde(rename = "toolUseId", skip_serializing_if = "Option::is_none")]
    pub tool_use_id: Option<String>,
    #[serde(rename = "isError", skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
    /// Where the FULL, untruncated output lives on disk — the thing that lets
    /// the panel be more complete than the terminal, which shows three lines
    /// and "ctrl+o to expand" (#12).
    #[serde(
        rename = "persistedOutputPath",
        skip_serializing_if = "Option::is_none"
    )]
    pub persisted_output_path: Option<String>,
    /// True when `text` was clipped to `TEXT_CAP`.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
}

/// Per-file read positions. The parent is keyed `""`; subagents by agent id.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cursor(pub BTreeMap<String, u64>);

impl Cursor {
    fn get(&self, key: &str) -> u64 {
        self.0.get(key).copied().unwrap_or(0)
    }
    /// URL-safe, unpadded base64 of the JSON map. Opaque on purpose: callers
    /// must not do arithmetic on a position that spans several files.
    pub fn encode(&self) -> String {
        b64_encode(
            serde_json::to_string(&self.0)
                .unwrap_or_default()
                .as_bytes(),
        )
    }
    pub fn decode(s: &str) -> Option<Self> {
        if s.is_empty() {
            return Some(Self::default());
        }
        let raw = b64_decode(s)?;
        serde_json::from_slice(&raw).ok().map(Cursor)
    }
}

/// A page of trace, plus where to resume.
#[derive(Debug, Clone, Serialize)]
pub struct TracePage {
    pub entries: Vec<Entry>,
    /// Feed back as `after=` to continue. Always present, even when empty, so
    /// a caller polling a quiet session keeps a valid position.
    pub cursor: String,
    /// True when the page stopped at `limit` and more is already on disk.
    #[serde(rename = "hasMore")]
    pub has_more: bool,
    /// Which transcripts were read — the parent plus every subagent found.
    pub sources: Vec<String>,
}

/// Why a trace could not be read.
///
/// A typed absence, never an empty page: #18 called this out specifically,
/// because rendering "nothing happened" for "I cannot see" is the kind of lie
/// a viewer has no way to detect.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Unavailable {
    /// No transcript has been located for this session yet. Normal for the few
    /// seconds before Claude Code's first write, and permanent for a session
    /// started with the CLAUDE_CODE_CHILD_SESSION marker inherited, which
    /// disables transcript persistence entirely.
    NoTranscript,
    /// The file was located but cannot be read now (deleted, rotated, perms).
    Unreadable,
}

/// Read one page of a session's trace.
///
/// Reads the parent transcript and every subagent transcript beneath it,
/// resuming each from the cursor's offset for that file. Entries come back
/// grouped by source — parent first, then each subagent — rather than
/// interleaved by timestamp, because interleaving would renumber positions when
/// a subagent writes late, and a stale cursor that looks valid is worse than an
/// ordering the viewer has to group itself.
pub fn read_page(
    parent: Option<&Path>,
    after: &Cursor,
    limit: usize,
) -> Result<TracePage, Unavailable> {
    let parent = parent.ok_or(Unavailable::NoTranscript)?;
    if !parent.is_file() {
        return Err(Unavailable::NoTranscript);
    }
    let limit = limit.clamp(1, MAX_LIMIT);

    let mut next = after.clone();
    let mut entries = Vec::new();
    let mut sources = vec!["parent".to_string()];
    let mut has_more = false;

    let (n, more) = read_file(parent, None, after.get(""), limit, &mut entries, &mut next)?;
    has_more |= more;
    let mut budget = limit.saturating_sub(n);

    for sub in subagents_for(parent) {
        sources.push(sub.agent_id.clone());
        if budget == 0 {
            // Something is left unread somewhere, which is all `has_more` claims.
            has_more = true;
            continue;
        }
        let start = after.get(&sub.agent_id);
        match read_sub(&sub, start, budget, &mut entries, &mut next) {
            Ok((n, more)) => {
                has_more |= more;
                budget = budget.saturating_sub(n);
            }
            // One unreadable child must not fail the whole page: the parent's
            // trace is still worth returning.
            Err(_) => continue,
        }
    }

    Ok(TracePage {
        entries,
        cursor: next.encode(),
        has_more,
        sources,
    })
}

fn read_sub(
    sub: &SubagentFile,
    start: u64,
    limit: usize,
    out: &mut Vec<Entry>,
    next: &mut Cursor,
) -> Result<(usize, bool), Unavailable> {
    read_file(&sub.path, Some(&sub.agent_id), start, limit, out, next)
}

/// Read up to `limit` entries from one transcript, starting at `start` bytes.
fn read_file(
    path: &Path,
    agent_id: Option<&str>,
    start: u64,
    limit: usize,
    out: &mut Vec<Entry>,
    next: &mut Cursor,
) -> Result<(usize, bool), Unavailable> {
    let key = agent_id.unwrap_or("").to_string();
    let file = fs::File::open(path).map_err(|_| Unavailable::Unreadable)?;
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);

    // Truncated or rewritten under us: restart rather than seek past the end.
    let mut pos = if start > len { 0 } else { start };
    if pos == len {
        next.0.insert(key, pos);
        return Ok((0, false));
    }

    let mut reader = BufReader::new(file);
    if reader.seek(SeekFrom::Start(pos)).is_err() {
        return Err(Unavailable::Unreadable);
    }

    let mut produced = 0usize;
    let mut line = String::new();
    let mut more = false;
    loop {
        if produced >= limit {
            more = pos < len;
            break;
        }
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(n) => {
                // Only advance past COMPLETE lines. A half-flushed final line is
                // re-read next call rather than emitted torn — the same rule the
                // tailer already follows.
                if !line.ends_with('\n') {
                    break;
                }
                let at = pos;
                pos += n as u64;
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    let before = out.len();
                    parse_line(&v, at, agent_id, out);
                    produced += out.len() - before;
                }
            }
            Err(_) => break,
        }
    }
    next.0.insert(key, pos);
    Ok((produced, more))
}

fn clip(s: &str) -> (String, bool) {
    let t = s.trim();
    if t.chars().count() <= TEXT_CAP {
        return (t.to_string(), false);
    }
    (t.chars().take(TEXT_CAP).collect(), true)
}

/// Turn one transcript line into zero or more entries.
fn parse_line(v: &Value, offset: u64, agent_id: Option<&str>, out: &mut Vec<Entry>) {
    let ts = v["timestamp"].as_str().and_then(parse_ts).unwrap_or(0);
    let turn_id = v["requestId"]
        .as_str()
        .or_else(|| v["message"]["id"].as_str())
        .map(str::to_string);
    let agent = agent_id.map(str::to_string);
    let mk = |kind: Kind| Entry {
        kind,
        offset,
        agent_id: agent.clone(),
        turn_id: turn_id.clone(),
        ts,
        text: None,
        tool: None,
        tool_use_id: None,
        is_error: None,
        persisted_output_path: None,
        truncated: false,
    };

    let is_user = v["type"].as_str() == Some("user");
    let content = &v["message"]["content"];

    // A plain-string user message is a real prompt. `isMeta` marks the
    // machine-generated ones Claude Code injects, which are not.
    if is_user && !v["isMeta"].as_bool().unwrap_or(false) {
        if let Some(s) = content.as_str() {
            let (text, truncated) = clip(s);
            if !text.is_empty() {
                out.push(Entry {
                    text: Some(text),
                    truncated,
                    ..mk(Kind::Prompt)
                });
            }
        }
    }

    let Some(blocks) = content.as_array() else {
        return;
    };
    for b in blocks {
        match b["type"].as_str() {
            Some("text") => {
                let (text, truncated) = clip(b["text"].as_str().unwrap_or(""));
                if text.is_empty() {
                    continue;
                }
                out.push(Entry {
                    text: Some(text),
                    truncated,
                    ..mk(Kind::Assistant)
                });
            }
            Some("thinking") => {
                let (text, truncated) = clip(b["thinking"].as_str().unwrap_or(""));
                // Measured across 1,015 real blocks: median length 0, p75 0.
                // Three quarters are EMPTY, so emitting them would fill the
                // trace with rows that render nothing (#17).
                if text.is_empty() {
                    continue;
                }
                out.push(Entry {
                    text: Some(text),
                    truncated,
                    ..mk(Kind::Thinking)
                });
            }
            Some("tool_use") => {
                let tool = b["name"].as_str().unwrap_or("Tool").to_string();
                let (text, truncated) = clip(&describe_input(&tool, &b["input"]));
                out.push(Entry {
                    tool: Some(tool),
                    tool_use_id: b["id"].as_str().map(str::to_string),
                    text: (!text.is_empty()).then_some(text),
                    truncated,
                    ..mk(Kind::Tool)
                });
            }
            Some("tool_result") => {
                let (text, truncated) = clip(&flatten(&b["content"]));
                out.push(Entry {
                    tool_use_id: b["tool_use_id"].as_str().map(str::to_string),
                    is_error: Some(b["is_error"].as_bool().unwrap_or(false)),
                    text: (!text.is_empty()).then_some(text),
                    truncated,
                    persisted_output_path: v["toolUseResult"]["persistedOutputPath"]
                        .as_str()
                        .map(str::to_string),
                    ..mk(Kind::ToolResult)
                });
            }
            _ => {}
        }
    }
}

fn flatten(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(|i| i["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn describe_input(tool: &str, input: &Value) -> String {
    if tool == "Bash" {
        return input["command"].as_str().unwrap_or("").to_string();
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
            return s.to_string();
        }
    }
    String::new()
}

fn parse_ts(s: &str) -> Option<u64> {
    crate::transcript::parse_iso_ms(s)
}

// ── base64url, unpadded ────────────────────────────────────────────────────
// A cursor is a few dozen bytes of JSON; pulling in a crate for that would be
// a dependency per request path we do not need.
const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

fn b64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        let take = chunk.len() + 1;
        for i in 0..take {
            out.push(B64[((n >> (18 - i * 6)) & 0x3f) as usize] as char);
        }
    }
    out
}

fn b64_decode(s: &str) -> Option<Vec<u8>> {
    let mut acc = 0u32;
    let mut bits = 0u8;
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    for c in s.bytes() {
        let v = B64.iter().position(|&x| x == c)? as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

/// Locate a session's transcript exactly the way the tailer does, so the route
/// and the live push can never disagree about which file a session owns.
pub fn locate_for(cwd: &str, session_id: Option<&str>, after_ms: u64) -> Option<PathBuf> {
    crate::transcript::locate(cwd, session_id, after_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("cv-trace-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("slug")).unwrap();
        root.join("slug").join("s1.jsonl")
    }

    fn line(v: Value) -> String {
        format!("{v}\n")
    }

    fn assistant_text(txt: &str, req: &str) -> Value {
        serde_json::json!({
            "type":"assistant","requestId":req,"timestamp":"2026-09-18T10:00:00.000Z",
            "message":{"id":"msg_1","content":[{"type":"text","text":txt}]}
        })
    }

    #[test]
    fn cursor_round_trips_through_its_opaque_encoding() {
        let mut c = Cursor::default();
        c.0.insert("".into(), 1234);
        c.0.insert("a1705fdcf".into(), 99);
        let back = Cursor::decode(&c.encode()).expect("decodes");
        assert_eq!(back, c);
        // An empty cursor means "start of session", not an error.
        assert_eq!(Cursor::decode("").unwrap(), Cursor::default());
        // Garbage is rejected rather than silently treated as position zero,
        // which would replay the whole session.
        assert!(Cursor::decode("!!!not base64!!!").is_none());
    }

    /// The typed-absence rule from #18: "I cannot see" must never render as
    /// "nothing happened".
    #[test]
    fn a_missing_transcript_is_a_typed_failure_not_an_empty_page() {
        assert_eq!(
            read_page(None, &Cursor::default(), 10).unwrap_err(),
            Unavailable::NoTranscript
        );
        let gone = std::env::temp_dir().join("cv-trace-does-not-exist.jsonl");
        assert_eq!(
            read_page(Some(&gone), &Cursor::default(), 10).unwrap_err(),
            Unavailable::NoTranscript
        );
    }

    #[test]
    fn pages_stop_at_limit_and_the_cursor_resumes_exactly_where_it_left_off() {
        let p = scratch("page");
        let mut body = String::new();
        for i in 0..5 {
            body.push_str(&line(assistant_text(
                &format!("msg {i}"),
                &format!("req_{i}"),
            )));
        }
        fs::write(&p, &body).unwrap();

        let first = read_page(Some(&p), &Cursor::default(), 2).unwrap();
        assert_eq!(first.entries.len(), 2);
        assert!(first.has_more, "two of five read, so more remains");
        assert_eq!(first.entries[0].text.as_deref(), Some("msg 0"));

        let c = Cursor::decode(&first.cursor).unwrap();
        let second = read_page(Some(&p), &c, 2).unwrap();
        assert_eq!(
            second.entries[0].text.as_deref(),
            Some("msg 2"),
            "no repeat, no gap"
        );

        let third = read_page(Some(&p), &Cursor::decode(&second.cursor).unwrap(), 10).unwrap();
        assert_eq!(third.entries.len(), 1);
        assert!(!third.has_more);

        // Re-reading at the end yields nothing rather than replaying.
        let end = read_page(Some(&p), &Cursor::decode(&third.cursor).unwrap(), 10).unwrap();
        assert!(end.entries.is_empty());
        let _ = fs::remove_dir_all(p.parent().unwrap().parent().unwrap());
    }

    /// A transcript is being appended to while we read it. A torn final line
    /// must be left for the next call, not emitted half-parsed.
    #[test]
    fn a_half_written_final_line_is_not_emitted_yet() {
        let p = scratch("torn");
        let mut body = line(assistant_text("complete", "req_1"));
        body.push_str("{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"te");
        fs::write(&p, &body).unwrap();

        let page = read_page(Some(&p), &Cursor::default(), 10).unwrap();
        assert_eq!(page.entries.len(), 1, "only the complete line");

        // Once the writer finishes the line, the next call picks it up.
        let mut full = body.clone();
        full.push_str("xt\",\"text\":\"arrived\"}]}}\n");
        fs::write(&p, &full).unwrap();
        let next = read_page(Some(&p), &Cursor::decode(&page.cursor).unwrap(), 10).unwrap();
        assert_eq!(next.entries.len(), 1);
        assert_eq!(next.entries[0].text.as_deref(), Some("arrived"));
        let _ = fs::remove_dir_all(p.parent().unwrap().parent().unwrap());
    }

    /// Measured across 1,015 real blocks: median 0, p75 0. Emitting empties
    /// would fill the trace with rows that render nothing (#17).
    #[test]
    fn empty_thinking_blocks_never_become_entries() {
        let p = scratch("think");
        fs::write(
            &p,
            line(serde_json::json!({
                "type":"assistant","requestId":"r1","timestamp":"2026-09-18T10:00:00.000Z",
                "message":{"id":"m","content":[
                    {"type":"thinking","thinking":""},
                    {"type":"thinking","thinking":"   "},
                    {"type":"thinking","thinking":"a real thought"}
                ]}
            })),
        )
        .unwrap();
        let page = read_page(Some(&p), &Cursor::default(), 10).unwrap();
        assert_eq!(page.entries.len(), 1);
        assert_eq!(page.entries[0].kind, Kind::Thinking);
        let _ = fs::remove_dir_all(p.parent().unwrap().parent().unwrap());
    }

    /// The field that lets the panel be MORE complete than the terminal (#12).
    #[test]
    fn tool_results_carry_the_persisted_output_path() {
        let p = scratch("persist");
        fs::write(
            &p,
            line(serde_json::json!({
                "type":"user","timestamp":"2026-09-18T10:00:00.000Z",
                "toolUseResult":{"persistedOutputPath":"/tmp/full-output.txt"},
                "message":{"content":[
                    {"type":"tool_result","tool_use_id":"toolu_1","content":"three lines shown"}
                ]}
            })),
        )
        .unwrap();
        let page = read_page(Some(&p), &Cursor::default(), 10).unwrap();
        assert_eq!(page.entries.len(), 1);
        assert_eq!(
            page.entries[0].persisted_output_path.as_deref(),
            Some("/tmp/full-output.txt")
        );
        assert_eq!(page.entries[0].is_error, Some(false));
        let _ = fs::remove_dir_all(p.parent().unwrap().parent().unwrap());
    }

    /// Subagent transcripts are part of the trace and must be attributed, or a
    /// child's work reads as the parent's — and it is often the majority.
    #[test]
    fn subagent_entries_are_included_and_tagged() {
        let p = scratch("sub");
        fs::write(&p, line(assistant_text("parent speaks", "req_p"))).unwrap();
        let subs = p.with_extension("").join("subagents");
        fs::create_dir_all(&subs).unwrap();
        fs::write(
            subs.join("agent-abc.jsonl"),
            format!(
                "{}{}",
                line(serde_json::json!({
                    "isSidechain":true,"sessionId":"s1","agentId":"abc","type":"assistant"
                })),
                line(serde_json::json!({
                    "type":"assistant","requestId":"req_c","timestamp":"2026-09-18T10:00:01.000Z",
                    "message":{"id":"m2","content":[{"type":"text","text":"child speaks"}]}
                }))
            ),
        )
        .unwrap();
        fs::write(
            subs.join("agent-abc.meta.json"),
            serde_json::json!({"toolUseId":"toolu_9"}).to_string(),
        )
        .unwrap();

        let page = read_page(Some(&p), &Cursor::default(), 50).unwrap();
        let child: Vec<_> = page
            .entries
            .iter()
            .filter(|e| e.agent_id.is_some())
            .collect();
        assert_eq!(child.len(), 1, "the subagent's text entry");
        assert_eq!(child[0].agent_id.as_deref(), Some("abc"));
        assert_eq!(child[0].text.as_deref(), Some("child speaks"));
        assert!(page.sources.iter().any(|s| s == "abc"));
        // ...and the parent's own entry is still there, untagged.
        assert!(page
            .entries
            .iter()
            .any(|e| e.agent_id.is_none() && e.text.as_deref() == Some("parent speaks")));
        let _ = fs::remove_dir_all(p.parent().unwrap().parent().unwrap());
    }

    #[test]
    fn oversized_text_is_clipped_and_flagged() {
        let p = scratch("clip");
        let huge = "x".repeat(TEXT_CAP + 500);
        fs::write(&p, line(assistant_text(&huge, "r1"))).unwrap();
        let page = read_page(Some(&p), &Cursor::default(), 10).unwrap();
        assert!(page.entries[0].truncated, "caller must know it was clipped");
        assert_eq!(
            page.entries[0].text.as_ref().unwrap().chars().count(),
            TEXT_CAP
        );
        let _ = fs::remove_dir_all(p.parent().unwrap().parent().unwrap());
    }
}
