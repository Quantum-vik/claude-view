use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

use serde::Serialize;
use serde_json::Value;

use crate::git::{self, RepoInfo};
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
    /// Grouping key: the repo's git *common* dir, shared by a checkout and all
    /// of its linked worktrees, so four worktrees of one repo collapse into one
    /// launcher group. `None` when the cwd is gone from disk (routine for a past
    /// session) or was never a repo — the frontend then groups by `cwd`.
    #[serde(rename = "repoKey")]
    pub repo_key: Option<String>,
    #[serde(rename = "repoName")]
    pub repo_name: Option<String>,
    /// This checkout's own directory name; equals `repo_name` for the main copy.
    #[serde(rename = "checkoutName")]
    pub checkout_name: Option<String>,
    #[serde(rename = "isLinkedWorktree")]
    pub is_linked_worktree: bool,
}

/// Per-`list()` memo of repo identity, keyed by the raw cwd string.
///
/// Deliberately *not* a global: a cwd never changes, but the filesystem does —
/// a process-lifetime cache would keep reporting a repo as absent after a
/// `git worktree add` recreated it.
type RepoCache = HashMap<String, Option<RepoInfo>>;

/// Repo identity for `cwd`, probing the filesystem at most once per distinct
/// cwd within a scan. Many transcripts share one cwd, and the `None` results
/// are the most repeated of all (deleted worktrees accumulate transcripts), so
/// misses are memoized too.
fn repo_ident(cwd: &str, cache: &mut RepoCache) -> Option<RepoInfo> {
    if let Some(hit) = cache.get(cwd) {
        return hit.clone();
    }
    let info = git::discover(Path::new(cwd));
    cache.insert(cwd.to_string(), info.clone());
    info
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
    let mut repos: RepoCache = HashMap::new();
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
            let repo = repo_ident(&cwd, &mut repos);
            out.push(PastSession {
                session_id: stem.to_string(),
                cwd,
                modified_ms,
                preview,
                model: tail_model.or(head_model),
                context_tokens,
                // No `branch` here on purpose: a past session's checkout has
                // moved on, so HEAD would show a branch it never ran on.
                is_linked_worktree: repo.as_ref().is_some_and(|r| r.is_linked_worktree),
                repo_key: repo.as_ref().map(|r| r.repo_key.clone()),
                repo_name: repo.as_ref().map(|r| r.repo_name.clone()),
                checkout_name: repo.map(|r| r.checkout_name),
            });
        }
    }

    out.sort_by_key(|s| std::cmp::Reverse(s.modified_ms));
    Ok(out)
}

/// Delete a past session's transcript by id. The file is moved to the OS
/// Trash (not permanently removed) so an accidental delete is recoverable.
/// The id is validated against a strict charset — it becomes a filename, so
/// nothing path-like may pass through.
pub fn delete(session_id: &str) -> Result<(), String> {
    if session_id.is_empty()
        || !session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("invalid session id".into());
    }
    let projects = dirs::home_dir()
        .ok_or("could not resolve home directory")?
        .join(".claude")
        .join("projects");
    let file_name = format!("{session_id}.jsonl");
    let Ok(project_dirs) = fs::read_dir(&projects) else {
        return Err("no projects directory".into());
    };
    for project in project_dirs.flatten() {
        let candidate = project.path().join(&file_name);
        if candidate.is_file() {
            return trash::delete(&candidate)
                .map_err(|e| format!("failed to trash transcript: {e}"));
        }
    }
    Err("session transcript not found".into())
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A path that cannot exist, so `git::discover` is guaranteed to miss.
    /// (`discover` canonicalizes first, so no ancestor `.git` can rescue it.)
    fn phantom_cwd(tag: &str) -> String {
        std::env::temp_dir()
            .join(format!("cv-past-{}-{tag}-gone", std::process::id()))
            .to_string_lossy()
            .into_owned()
    }

    /// The memo is consulted *before* the filesystem: a seeded entry wins even
    /// though probing this cwd for real would come back empty.
    #[test]
    fn cache_hit_short_circuits_the_probe() {
        let cwd = phantom_cwd("hit");
        let seeded = RepoInfo {
            repo_key: "/code/app/.git".into(),
            repo_name: "app".into(),
            checkout_name: "app-fix".into(),
            is_linked_worktree: true,
            git_dir: "/code/app/.git/worktrees/app-fix".into(),
        };
        let mut cache: RepoCache = HashMap::new();
        cache.insert(cwd.clone(), Some(seeded.clone()));

        assert_eq!(git::discover(Path::new(&cwd)), None, "cwd must be absent");
        assert_eq!(repo_ident(&cwd, &mut cache), Some(seeded));
        assert_eq!(cache.len(), 1, "a hit must not add an entry");
    }

    /// Deleted worktrees are the cwd that repeats most across transcripts, so
    /// the miss has to be memoized too — otherwise it re-probes on every row.
    #[test]
    fn missing_directory_memoizes_none() {
        let cwd = phantom_cwd("miss");
        let mut cache: RepoCache = HashMap::new();

        assert_eq!(repo_ident(&cwd, &mut cache), None);
        assert_eq!(cache.get(&cwd), Some(&None), "the miss must be recorded");
        assert_eq!(repo_ident(&cwd, &mut cache), None);
        assert_eq!(cache.len(), 1);
    }
}
