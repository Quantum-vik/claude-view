use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;

use serde::Serialize;
use serde_json::Value;

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

            let (cwd, preview, model) = scan_head(&path);
            let Some(cwd) = cwd else {
                continue; // unreadable/empty transcript — not resumable, skip
            };
            out.push(PastSession {
                session_id: stem.to_string(),
                cwd,
                modified_ms,
                preview,
                model,
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
