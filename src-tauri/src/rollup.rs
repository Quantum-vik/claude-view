//! Spend across every session on this machine, not just the open one.
//!
//! ## The constraint that shapes all of this
//!
//! A resumed session **replays earlier turns verbatim into a new transcript** —
//! same `requestId`, same `message.id`, same usage. Measured on the reference
//! corpus: 35 ids appearing in more than one file, and 2,434,181 input tokens
//! that a per-file sum would count twice.
//!
//! So de-duplication here is **global across every file**, not per session. That
//! is the whole reason this cannot be "ask each session for its total and add
//! them up": the per-session ledgers are individually correct and still sum to
//! the wrong number.
//!
//! Within a turn the rule matches the ledger's — **last-wins** — because input is
//! identical across a turn's records but `output_tokens` grows across them.
//!
//! ## Scope
//!
//! Every transcript under `~/.claude/projects`, parent and subagent alike. This
//! deliberately includes sessions claude-view never launched: the question
//! "what did I spend today" is about the machine, not about this app.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use serde::Serialize;
use serde_json::Value;

use crate::session::now_ms;
use crate::transcript::{self, TokenUsage};

/// One bucket of spend: a model, a repo, or a day.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Bucket {
    pub key: String,
    pub turns: usize,
    pub usage: TokenUsage,
    pub tokens: u64,
}

/// Everything the launcher needs to show spend, in tokens.
///
/// Carries **no dollar figure**, for the same reason the per-session rollup does
/// not: the price table lives in the frontend with its own `AS_OF`, and a second
/// copy here would be a second source of truth for money.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Spend {
    /// Distinct turns after global de-duplication.
    pub turns: usize,
    /// Turns that were replays of a turn already counted — the double-count a
    /// per-file sum would have made. Surfaced because it is the whole reason
    /// this is not a simple addition.
    #[serde(rename = "duplicatesSkipped")]
    pub duplicates_skipped: usize,
    pub total: TokenUsage,
    pub today: TokenUsage,
    #[serde(rename = "todayTurns")]
    pub today_turns: usize,
    #[serde(rename = "byModel")]
    pub by_model: Vec<Bucket>,
    #[serde(rename = "byRepo")]
    pub by_repo: Vec<Bucket>,
    /// Newest first, at most 14 entries. `YYYY-MM-DD`.
    #[serde(rename = "byDay")]
    pub by_day: Vec<Bucket>,
    /// Transcripts scanned, so a caller can tell an empty result from a failure.
    pub transcripts: usize,
    #[serde(rename = "scanMs")]
    pub scan_ms: u64,
}

/// `1789707895039` → `2026-09-18`, UTC — the inverse of the transcript parser,
/// so a day bucket and a timestamp can never disagree.
fn day_of(ms: u64) -> String {
    let (y, m, d) = transcript::civil_from_days((ms / 86_400_000) as i64);
    format!("{y:04}-{m:02}-{d:02}")
}

/// One turn, as scanned.
struct Turn {
    key: String,
    usage: TokenUsage,
    model: Option<String>,
    ts: u64,
}

/// Collect turns from one transcript file.
fn scan_file(path: &Path, out: &mut Vec<Turn>) {
    let Ok(text) = fs::read_to_string(path) else {
        return;
    };
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(usage) = TokenUsage::parse(&v) else {
            continue;
        };
        let Some(key) = transcript::dedup_key(&v) else {
            continue;
        };
        out.push(Turn {
            key: key.to_string(),
            usage,
            model: v["message"]["model"].as_str().map(str::to_string),
            ts: v["timestamp"]
                .as_str()
                .and_then(transcript::parse_iso_ms)
                .unwrap_or(0),
        });
    }
}

/// The repo a transcript's session ran in, from its first `cwd`.
fn cwd_of(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    for line in text.lines().take(40) {
        if let Ok(v) = serde_json::from_str::<Value>(line) {
            if let Some(c) = v["cwd"].as_str() {
                return Some(c.to_string());
            }
        }
    }
    None
}

/// Scan every transcript under `root` (normally `~/.claude/projects`).
pub fn scan(root: &Path) -> Spend {
    let started = now_ms();
    let mut out = Spend::default();

    // file -> (turns, repo label). Subagents inherit their parent's repo.
    let mut per_file: Vec<(Vec<Turn>, String)> = Vec::new();

    let Ok(slugs) = fs::read_dir(root) else {
        return out;
    };
    for slug in slugs.flatten() {
        let dir = slug.path();
        if !dir.is_dir() {
            continue;
        }
        let Ok(files) = fs::read_dir(&dir) else {
            continue;
        };
        for f in files.flatten() {
            let path = f.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            // Label by the directory's own name. A cwd of "/" or a trailing
            // slash yields no file_name at all, which rendered as a blank row
            // with real tokens against it — worse than saying "unknown".
            let label = cwd_of(&path)
                .and_then(|c| {
                    Path::new(&c)
                        .file_name()
                        .and_then(|s| s.to_str())
                        .map(str::to_string)
                        .filter(|s| !s.trim().is_empty())
                })
                .unwrap_or_else(|| "(unknown)".into());

            let mut turns = Vec::new();
            scan_file(&path, &mut turns);
            out.transcripts += 1;

            // Subagents live one level down, under <session-id>/subagents/, and
            // their spend belongs to the same repo as their parent.
            let subs = path.with_extension("").join("subagents");
            if let Ok(kids) = fs::read_dir(&subs) {
                for k in kids.flatten() {
                    let kp = k.path();
                    if kp.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                        scan_file(&kp, &mut turns);
                        out.transcripts += 1;
                    }
                }
            }
            per_file.push((turns, label));
        }
    }

    // GLOBAL de-duplication. A resumed session replays turns verbatim into a new
    // file, so a per-file sum double-counts them. Last-wins within a key,
    // matching the per-session ledger: output grows across a turn's records.
    let mut seen: HashSet<String> = HashSet::new();
    let mut by_model: HashMap<String, Bucket> = HashMap::new();
    let mut by_repo: HashMap<String, Bucket> = HashMap::new();
    let mut by_day: HashMap<String, Bucket> = HashMap::new();
    let today = day_of(now_ms());

    for (turns, label) in &per_file {
        // Fold within the file first so last-wins applies to a turn's repeated
        // records, then let the global set reject replays across files.
        let mut folded: HashMap<&str, &Turn> = HashMap::new();
        let mut order: Vec<&str> = Vec::new();
        for t in turns {
            if folded.insert(t.key.as_str(), t).is_none() {
                order.push(t.key.as_str());
            }
        }
        for key in order {
            let t = folded[key];
            if !seen.insert(t.key.clone()) {
                out.duplicates_skipped += 1;
                continue;
            }
            out.turns += 1;
            out.total.add(&t.usage);

            let day = day_of(t.ts);
            if day == today {
                out.today_turns += 1;
                out.today.add(&t.usage);
            }

            for (map, k) in [
                (
                    &mut by_model,
                    t.model.clone().unwrap_or_else(|| "unknown".into()),
                ),
                (&mut by_repo, label.clone()),
                (&mut by_day, day),
            ] {
                let b = map.entry(k.clone()).or_insert_with(|| Bucket {
                    key: k,
                    ..Default::default()
                });
                b.turns += 1;
                b.usage.add(&t.usage);
            }
        }
    }

    let finish = |map: HashMap<String, Bucket>, by_key_desc: bool| -> Vec<Bucket> {
        let mut v: Vec<Bucket> = map
            .into_values()
            .map(|mut b| {
                b.tokens = b.usage.total();
                b
            })
            .collect();
        if by_key_desc {
            v.sort_by(|a, b| b.key.cmp(&a.key)); // newest day first
        } else {
            // Biggest spend first, so the launcher's first row is the one that
            // actually accounts for the bill.
            v.sort_by_key(|b| std::cmp::Reverse(b.tokens));
        }
        v
    };

    out.by_model = finish(by_model, false);
    out.by_repo = finish(by_repo, false);
    out.by_day = finish(by_day, true);
    out.by_day.truncate(14);
    out.scan_ms = now_ms().saturating_sub(started);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("cv-rollup-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn turn_line(req: &str, model: &str, input: u64, out: u64, ts: &str) -> String {
        format!(
            "{}\n",
            serde_json::json!({
                "type":"assistant","requestId":req,"timestamp":ts,"cwd":"/home/u/myrepo",
                "message":{"id":format!("msg_{req}"),"model":model,
                  "usage":{"input_tokens":input,"cache_read_input_tokens":0,"output_tokens":out}}
            })
        )
    }

    /// THE point of this module. A resumed session replays turns verbatim into a
    /// new file; summing per file counts them twice.
    #[test]
    fn a_turn_replayed_into_a_resumed_session_is_counted_once() {
        let root = tmp("dedupe");
        let slug = root.join("slug");
        fs::create_dir_all(&slug).unwrap();

        let a = turn_line(
            "req_1",
            "claude-opus-5",
            100,
            10,
            "2026-09-18T10:00:00.000Z",
        );
        let b = turn_line(
            "req_2",
            "claude-opus-5",
            200,
            20,
            "2026-09-18T10:01:00.000Z",
        );
        fs::write(slug.join("s1.jsonl"), format!("{a}{b}")).unwrap();
        // The resumed session replays req_1 and req_2, then adds req_3.
        let c = turn_line(
            "req_3",
            "claude-opus-5",
            400,
            40,
            "2026-09-18T11:00:00.000Z",
        );
        fs::write(slug.join("s2.jsonl"), format!("{a}{b}{c}")).unwrap();

        let s = scan(&root);
        assert_eq!(s.turns, 3, "three distinct turns across two files");
        assert_eq!(s.duplicates_skipped, 2, "the two replayed turns");
        assert_eq!(s.total.input, 700, "not 1000 — the naive per-file sum");
        let _ = fs::remove_dir_all(&root);
    }

    /// Within a turn the input side repeats but output grows, so the last
    /// record wins — the same rule the per-session ledger follows.
    #[test]
    fn repeated_records_of_one_turn_fold_last_wins() {
        let root = tmp("lastwins");
        let slug = root.join("slug");
        fs::create_dir_all(&slug).unwrap();
        let body: String = [10u64, 40, 90]
            .iter()
            .map(|o| {
                turn_line(
                    "req_1",
                    "claude-opus-5",
                    100,
                    *o,
                    "2026-09-18T10:00:00.000Z",
                )
            })
            .collect();
        fs::write(slug.join("s.jsonl"), body).unwrap();

        let s = scan(&root);
        assert_eq!(s.turns, 1);
        assert_eq!(s.total.output, 90, "last-wins, not 10 and not 140");
        assert_eq!(
            s.total.input, 100,
            "input must not be summed across records"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn spend_splits_by_model_repo_and_day() {
        let root = tmp("buckets");
        let slug = root.join("slug");
        fs::create_dir_all(&slug).unwrap();
        fs::write(
            slug.join("s.jsonl"),
            format!(
                "{}{}",
                turn_line("r1", "claude-opus-5", 100, 10, "2026-09-18T10:00:00.000Z"),
                turn_line("r2", "claude-haiku-4-5", 50, 5, "2026-09-17T10:00:00.000Z")
            ),
        )
        .unwrap();

        let s = scan(&root);
        assert_eq!(s.turns, 2);
        // Biggest spend first, so the launcher's first row is the one that matters.
        assert_eq!(s.by_model[0].key, "claude-opus-5");
        assert_eq!(s.by_model.len(), 2);
        assert_eq!(
            s.by_repo[0].key, "myrepo",
            "repo comes from the session cwd"
        );
        // Newest day first.
        assert_eq!(s.by_day[0].key, "2026-09-18");
        assert_eq!(s.by_day[1].key, "2026-09-17");
        let _ = fs::remove_dir_all(&root);
    }

    /// Subagent spend is routinely the majority, and belongs to its parent's repo.
    #[test]
    fn subagent_transcripts_are_included_under_the_parent_repo() {
        let root = tmp("subs");
        let slug = root.join("slug");
        fs::create_dir_all(slug.join("s1").join("subagents")).unwrap();
        fs::write(
            slug.join("s1.jsonl"),
            turn_line(
                "r_parent",
                "claude-opus-5",
                10,
                1,
                "2026-09-18T10:00:00.000Z",
            ),
        )
        .unwrap();
        fs::write(
            slug.join("s1").join("subagents").join("agent-x.jsonl"),
            turn_line(
                "r_child",
                "claude-opus-5",
                990,
                99,
                "2026-09-18T10:00:01.000Z",
            ),
        )
        .unwrap();

        let s = scan(&root);
        assert_eq!(s.turns, 2);
        assert_eq!(s.total.input, 1000, "the child's spend must be counted");
        assert_eq!(s.by_repo.len(), 1, "the child belongs to its parent's repo");
        assert_eq!(s.by_repo[0].turns, 2);
        let _ = fs::remove_dir_all(&root);
    }

    /// A cwd of "/" has no file_name, which rendered as a blank row carrying
    /// real tokens — worse than admitting it is unknown.
    #[test]
    fn a_rootless_cwd_is_labelled_rather_than_left_blank() {
        let root = tmp("blank");
        let slug = root.join("slug");
        fs::create_dir_all(&slug).unwrap();
        let line = format!(
            "{}\n",
            serde_json::json!({
                "type":"assistant","requestId":"r1","timestamp":"2026-09-18T10:00:00.000Z",
                "cwd":"/",
                "message":{"id":"m","model":"claude-opus-5",
                  "usage":{"input_tokens":10,"output_tokens":1}}
            })
        );
        fs::write(slug.join("s.jsonl"), line).unwrap();
        let s = scan(&root);
        assert_eq!(s.by_repo.len(), 1);
        assert_eq!(s.by_repo[0].key, "(unknown)");
        assert!(!s.by_repo[0].key.trim().is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn an_empty_or_missing_root_is_zero_not_a_panic() {
        let s = scan(Path::new("/definitely/not/here"));
        assert_eq!(s.turns, 0);
        assert_eq!(s.transcripts, 0);
    }

    #[test]
    fn day_conversion_matches_the_transcript_parser() {
        let ms = transcript::parse_iso_ms("2026-09-18T23:59:59.000Z").unwrap();
        assert_eq!(day_of(ms), "2026-09-18");
        let ms2 = transcript::parse_iso_ms("2026-01-01T00:00:00.000Z").unwrap();
        assert_eq!(day_of(ms2), "2026-01-01");
    }

    /// Against this machine's real corpus, if it has one.
    #[test]
    fn scans_the_real_corpus_on_this_machine() {
        let Some(root) = dirs::home_dir().map(|h| h.join(".claude/projects")) else {
            return;
        };
        if !root.is_dir() {
            return;
        }
        let s = scan(&root);
        eprintln!(
            "scanned {} transcripts in {} ms: {} turns ({} replays skipped), {} tokens, {} repos",
            s.transcripts,
            s.scan_ms,
            s.turns,
            s.duplicates_skipped,
            s.total.total(),
            s.by_repo.len()
        );
        if s.transcripts > 0 {
            assert!(s.turns > 0, "a real corpus should yield turns");
            assert!(!s.by_model.is_empty());
        }
    }
}
