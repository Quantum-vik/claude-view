use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

use serde::Serialize;
use serde_json::Value;

use crate::transcript::usage_from;

/// A session found on disk in ~/.claude/projects, resumable via
/// `claude --resume <session_id>`.
#[derive(Serialize, Clone)]
pub struct PastSession {
    pub session_id: String,
    pub cwd: String,
    #[serde(rename = "modifiedMs")]
    pub modified_ms: u64,
    pub preview: Option<String>,
    /// Model id from the first assistant message (e.g. "claude-fable-5").
    pub model: Option<String>,
    /// Context-window occupancy at the session's end (input tokens of the last
    /// assistant turn). None if no usage found in the tail.
    #[serde(rename = "contextTokens")]
    pub context_tokens: Option<u64>,
}

/// Scan every project transcript and return sessions newest-first. Only the
/// head of each JSONL file is read (cwd + first user message), so this stays
/// fast even with hundreds of sessions.
pub fn list() -> Result<Vec<PastSession>, String> {
    let projects = dirs::home_dir()
        .ok_or("could not resolve home directory")?
        .join(".claude")
        .join("projects");
    let mut out = Vec::new();
    let Ok(project_dirs) = fs::read_dir(&projects) else {
        return Ok(out); // no projects dir -> no sessions
    };

    for project in project_dirs.flatten() {
        let dir = project.path();
        if !dir.is_dir() {
            continue;
        }
        let Ok(files) = fs::read_dir(&dir) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            // Subagent transcripts live alongside session files; skip them.
            if stem.starts_with("agent-") {
                continue;
            }
            let modified_ms = file
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);

            let (cwd, preview, head_model) = scan_head(&path);
            let Some(cwd) = cwd else {
                continue; // unreadable/empty transcript — not resumable, skip
            };
            // The tail gives the session's CURRENT model + context size. Prefer
            // the tail model for both the chip and the meter's window, since a
            // session may have switched models (e.g. fable → opus).
            let (context_tokens, tail_model) = scan_tail(&path);
            out.push(PastSession {
                session_id: stem.to_string(),
                cwd,
                modified_ms,
                preview,
                model: tail_model.or(head_model),
                context_tokens,
            });
        }
    }

    out.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    Ok(out)
}

/// Read the head of a transcript defensively (schema is undocumented and
/// version-dependent): pull the session cwd and something human-recognizable
/// to label it with — the first real user prompt, falling back to a summary.
fn scan_head(path: &Path) -> (Option<String>, Option<String>, Option<String>) {
    let Ok(file) = fs::File::open(path) else {
        return (None, None, None);
    };
    let mut reader = BufReader::new(file.take(512 * 1024));
    let mut cwd = None;
    let mut preview = None;
    let mut summary = None;
    let mut model = None;
    let mut line = String::new();

    for _ in 0..200 {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if cwd.is_none() {
            cwd = v["cwd"].as_str().map(str::to_string);
        }
        if summary.is_none() && v["type"] == "summary" {
            summary = v["summary"].as_str().map(|s| truncate(s, 140));
        }
        if preview.is_none() {
            preview = extract_user_text(&v);
        }
        if model.is_none() && v["type"] == "assistant" {
            model = v["message"]["model"].as_str().map(str::to_string);
        }
        if cwd.is_some() && preview.is_some() && model.is_some() {
            break;
        }
    }
    (cwd, preview.or(summary), model)
}

/// Read the tail of a transcript and return the context-window occupancy
/// (input tokens) AND the model of the LAST assistant turn — i.e. how full the
/// context was and what model the session ended on. The model drives the
/// meter's window, so a session that switched models is scaled correctly. Only
/// the final chunk is read, so it stays cheap.
fn scan_tail(path: &Path) -> (Option<u64>, Option<String>) {
    const TAIL: u64 = 256 * 1024;
    let none = (None, None);
    let Ok(mut file) = fs::File::open(path) else {
        return none;
    };
    let Ok(len) = file.metadata().map(|m| m.len()) else {
        return none;
    };
    let start = len.saturating_sub(TAIL);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return none;
    }
    // Read raw bytes (an arbitrary offset can split a UTF-8 codepoint) and
    // decode lossily; the partial first line is skipped below regardless.
    let mut bytes = Vec::new();
    if file.take(TAIL).read_to_end(&mut bytes).is_err() {
        return none;
    }
    let buf = String::from_utf8_lossy(&bytes);
    let mut context = None;
    let mut model = None;
    // The first line is likely partial when we didn't start at 0 — skip it.
    for line in buf.lines().skip(if start > 0 { 1 } else { 0 }) {
        if let Ok(v) = serde_json::from_str::<Value>(line) {
            if v["type"] == "assistant" {
                if let Some((input, _)) = usage_from(&v) {
                    context = Some(input);
                }
                if let Some(m) = v["message"]["model"].as_str() {
                    model = Some(m.to_string());
                }
            }
        }
    }
    (context, model)
}

fn extract_user_text(v: &Value) -> Option<String> {
    if v["type"] != "user" || v["isMeta"].as_bool().unwrap_or(false) {
        return None;
    }
    let content = &v["message"]["content"];
    let text = match content {
        Value::String(s) => Some(s.clone()),
        Value::Array(items) => items.iter().find_map(|item| {
            (item["type"] == "text")
                .then(|| item["text"].as_str().map(str::to_string))
                .flatten()
        }),
        _ => None,
    }?;
    let text = text.trim();
    // Skip harness-injected content (slash-command markers, caveat banners).
    if text.is_empty() || text.starts_with('<') || text.starts_with("Caveat:") {
        return None;
    }
    Some(truncate(text, 140))
}

fn truncate(s: &str, max_chars: usize) -> String {
    let mut out: String = s.chars().take(max_chars).collect();
    if s.chars().count() > max_chars {
        out.push('…');
    }
    out
}
