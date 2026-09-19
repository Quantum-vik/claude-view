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
/// Sessions run from a scratch directory, which the launcher hides.
///
/// Agent tooling works in temp directories constantly — a research agent, a
/// throwaway experiment, a scratchpad — and every one of them leaves a
/// transcript behind. Measured on one machine: **21 of 24** project directories
/// were `/tmp` throwaways, so the launcher's list was almost entirely noise
/// with the real repos buried in it.
///
/// Hiding is safe here in a way it would not be elsewhere: `/tmp` does not
/// survive a reboot, so these sessions are ephemeral by construction. Nothing
/// is deleted — the transcripts stay on disk and a session still running in a
/// temp directory is unaffected, since that list is built from live processes
/// rather than from this scan.
fn is_scratch(cwd: &str) -> bool {
    let p = Path::new(cwd);
    // $TMPDIR first: honouring it is what makes this correct on a machine that
    // puts temp somewhere other than /tmp, macOS being the common case.
    if let Some(tmp) = std::env::var_os("TMPDIR") {
        let tmp = Path::new(&tmp);
        if !tmp.as_os_str().is_empty() && p.starts_with(tmp) {
            return true;
        }
    }
    ["/tmp", "/var/tmp", "/private/tmp", "/private/var/folders"]
        .iter()
        .any(|root| p.starts_with(root))
}

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
            if is_scratch(&cwd) {
                continue;
            }
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

/// Text between two markers, or `None` if either is missing.
fn between<'a>(hay: &'a str, open: &str, close: &str) -> Option<&'a str> {
    let start = hay.find(open)? + open.len();
    let end = hay[start..].find(close)? + start;
    Some(hay[start..end].trim())
}

/// A slash command IS the prompt, so label the session with it.
///
/// The harness writes an invocation as a block of `<command-*>` tags, which the
/// generic skip-anything-starting-with-`<` rule discards as injected chrome. For
/// a session whose first prompt was `/wayfinder …` that threw away the only
/// label in reach and the session vanished from the launcher entirely — worst
/// for the long, heavily-resumed sessions most worth finding again.
fn slash_command_label(text: &str) -> Option<String> {
    let name = between(text, "<command-name>", "</command-name>")?;
    if name.is_empty() {
        return None;
    }
    let args = between(text, "<command-args>", "</command-args>").unwrap_or("");
    let label = if args.is_empty() {
        name.to_string()
    } else {
        format!("{name} {args}")
    };
    Some(truncate(&label, 140))
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
    if text.is_empty() || text.starts_with("Caveat:") {
        return None;
    }
    // Harness-injected blocks start with a tag. A slash command is one of them
    // and is worth reading; the rest (stdout echoes, reminders) are not.
    if text.starts_with('<') {
        return slash_command_label(text);
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

    /// A 38 MB session vanished from the launcher because its first prompt was
    /// `/wayfinder …`, written by the harness as `<command-*>` tags and thrown
    /// away by the skip-anything-in-angle-brackets rule.
    #[test]
    fn a_slash_command_is_a_prompt_not_chrome() {
        let raw = "<command-message>wayfinder</command-message>\n\
                   <command-name>/wayfinder</command-name>\n\
                   <command-args>improve trace and costing</command-args>";
        assert_eq!(
            slash_command_label(raw).as_deref(),
            Some("/wayfinder improve trace and costing")
        );
    }

    #[test]
    fn a_slash_command_with_no_arguments_still_labels_the_session() {
        let raw = "<command-name>/compact</command-name>\n<command-args></command-args>";
        assert_eq!(slash_command_label(raw).as_deref(), Some("/compact"));
    }

    /// Everything else in angle brackets is genuinely chrome and stays hidden.
    #[test]
    fn other_injected_blocks_are_still_skipped() {
        assert_eq!(slash_command_label("<local-command-stdout>ok</local-command-stdout>"), None);
        assert_eq!(slash_command_label("<system-reminder>be good</system-reminder>"), None);
        assert_eq!(slash_command_label("<command-name></command-name>"), None);
    }

    /// Opt-in: `CV_DUMP_SESSIONS=1 cargo test dump_sessions -- --nocapture`.
    /// Counts what the launcher shows against what is on disk.
    #[test]
    fn dump_sessions() {
        if std::env::var("CV_DUMP_SESSIONS").is_err() {
            return;
        }
        let shown = list().unwrap();
        let projects = dirs::home_dir().unwrap().join(".claude/projects");
        let mut total = 0;
        let mut scratch = 0;
        for d in fs::read_dir(&projects).unwrap().flatten() {
            if !d.path().is_dir() {
                continue;
            }
            total += 1;
            if d.file_name().to_string_lossy().starts_with("-tmp") {
                scratch += 1;
            }
        }
        eprintln!("project dirs on disk: {total}  (scratch-looking: {scratch})");
        eprintln!("sessions the launcher shows: {}", shown.len());
        let mut dirs_shown: Vec<_> = shown.iter().map(|s| s.cwd.clone()).collect();
        dirs_shown.sort();
        dirs_shown.dedup();
        eprintln!("distinct cwds shown: {}", dirs_shown.len());
        for c in dirs_shown.iter().take(12) {
            eprintln!("  {c}");
        }
        for x in shown.iter().take(6) {
            eprintln!(
                "  id={} preview={:?}",
                &x.session_id[..8],
                x.preview.as_deref().map(|p| &p[..p.len().min(40)])
            );
        }
        assert!(
            !shown.iter().any(|s| is_scratch(&s.cwd)),
            "a scratch session reached the launcher"
        );
    }

    /// 21 of 24 project directories on one real machine were `/tmp`
    /// throwaways left by agent tooling. The launcher is for finding your work.
    #[test]
    fn scratch_directories_are_hidden_from_the_launcher() {
        assert!(is_scratch("/tmp/rd21-w1"));
        assert!(is_scratch("/tmp/claude-1000/x/scratchpad"));
        assert!(is_scratch("/var/tmp/build"));
        assert!(is_scratch("/private/var/folders/ab/cd/T/agent"));
    }

    #[test]
    fn real_work_is_never_hidden() {
        assert!(!is_scratch("/home/u/WorkPersonal/claude-view"));
        assert!(!is_scratch("/home/u/code/app"));
        // A path that merely CONTAINS the word is not a temp path — matching on
        // a substring rather than a path prefix would hide real repos.
        assert!(!is_scratch("/home/u/tmp-notes"));
        assert!(!is_scratch("/home/u/projects/tmpfs-experiments"));
        assert!(!is_scratch("/opt/tmp-tools/src"));
    }

    #[test]
    fn tmpdir_is_honoured_where_temp_is_not_slash_tmp() {
        // macOS puts it under /var/folders; a machine can put it anywhere.
        std::env::set_var("TMPDIR", "/scratchvol/ephemeral");
        assert!(is_scratch("/scratchvol/ephemeral/run-4/work"));
        assert!(!is_scratch("/scratchvol/keepme"));
        std::env::remove_var("TMPDIR");
    }
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
