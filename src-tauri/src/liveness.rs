//! Is a watched session still going?
//!
//! A session claude-view launched answers this with a process. A **watched**
//! session has none (#40), and hooks never arrive from one — the bridge exits
//! unless the app injected its environment (#41). So the only evidence is the
//! transcript on disk, and this module reads it.
//!
//! **An outstanding tool call is the signal; the clock is the fallback.** A
//! `tool_use` with no matching `tool_result` at the tail means a tool has not
//! returned, which *explains* the silence instead of guessing at it. Measured on
//! 2,507 real tool calls: p50 0.2 s, p99 60 s, max 296 s — so a one-minute timer
//! alone would have declared a session dead 26 times, including through a
//! four-minute release build.
//!
//! The clock's threshold is [`LIVE_MS`] = 180 s, where exactly **one** of those
//! 2,507 calls would misfire.
//!
//! Nothing here ever says "ended". A file that stopped growing may have ended,
//! crashed, or be thinking, and disk cannot tell those apart — see `CONTEXT.md`.

use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// How much of the tail to read. Measured: 400 KB of a 41 MB transcript yields
/// ~92 records, which is far more than enough to find an unmatched tool call —
/// and reading the whole file to answer "is it alive" would cost 41 MB a poll.
const TAIL_BYTES: u64 = 400 * 1024;

/// A write this recent means it is producing output right now. p90 of the gap
/// between records is 10.5 s, so 20 s is comfortably past the routine pause.
const WRITING_MS: u64 = 20_000;

/// Beyond this with nothing outstanding, liveness is only a guess.
const LIVE_MS: u64 = 180_000;

/// Beyond this it is not live at all. Also bounds a tool call that never
/// returned because the process died mid-flight — otherwise an outstanding call
/// would read as live forever.
const IDLE_MS: u64 = 15 * 60_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Liveness {
    /// Producing output, or waiting on a tool that has not returned.
    Live {
        /// The tool being waited on, when that is why it is quiet.
        #[serde(skip_serializing_if = "Option::is_none")]
        tool: Option<String>,
    },
    /// Written to recently, nothing outstanding — inferred from the file, so the
    /// UI must word it as a question rather than a fact (#43).
    Guessed,
    /// Quiet for a while, but not long enough to give up on.
    Idle,
    /// No longer live. Never "ended": disk cannot tell that apart from a crash.
    NoLongerLive,
}

/// The last unmatched `tool_use` in the tail, if any. `None` for a file that
/// cannot be read.
///
/// Deliberately reads no timestamps. An earlier draft derived "how long has this
/// call been outstanding" from the records' own ISO timestamps, which meant
/// parsing dates by hand and reasoning across two clocks; the file's mtime
/// answers the same question with one. The first version of that parser was
/// twelve hours out.
fn scan_tail(path: &Path) -> Option<String> {
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let from = len.saturating_sub(TAIL_BYTES);
    f.seek(SeekFrom::Start(from)).ok()?;
    // Read bytes and decode lossily, as `past_sessions::scan_tail` does: a
    // 400 KB offset lands mid-character often enough, and `read_to_string`
    // fails the WHOLE read when it does — throwing away the outstanding-call
    // signal and leaving only the clock, which cannot tell thinking from dead.
    let mut bytes = Vec::new();
    f.take(TAIL_BYTES).read_to_end(&mut bytes).ok()?;
    let buf = String::from_utf8_lossy(&bytes);

    // The first line is partial whenever we did not start at 0.
    let skip = usize::from(from > 0);
    let mut open: HashMap<String, String> = HashMap::new();
    let mut order: Vec<String> = Vec::new();

    for line in buf.lines().skip(skip) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let Some(items) = v["message"]["content"].as_array() else {
            continue;
        };
        for b in items {
            match b["type"].as_str() {
                Some("tool_use") => {
                    if let Some(id) = b["id"].as_str() {
                        let name = b["name"].as_str().unwrap_or("a tool").to_string();
                        open.insert(id.to_string(), name);
                        order.push(id.to_string());
                    }
                }
                Some("tool_result") => {
                    if let Some(id) = b["tool_use_id"].as_str() {
                        open.remove(id);
                    }
                }
                _ => {}
            }
        }
    }
    // The most recently STARTED call still open — a session can have several in
    // flight, and the newest is the one it is waiting on now.
    order.iter().rev().find_map(|id| open.get(id).cloned())
}

/// [`probe`], but skipping the tail read for a file that is plainly cold.
///
/// The launcher scans every transcript on the machine. Reading 400 KB of each to
/// discover that a three-week-old session is not running would cost megabytes a
/// poll; beyond [`IDLE_MS`] the answer cannot be anything but `NoLongerLive`, so
/// the read is skipped rather than performed and discarded.
pub fn probe_recent(path: &Path, mtime_ms: u64, now_ms: u64) -> Liveness {
    if now_ms.saturating_sub(mtime_ms) > IDLE_MS {
        return Liveness::NoLongerLive;
    }
    probe(path, mtime_ms, now_ms)
}

/// Judge a watched session from its transcript.
///
/// `mtime_ms` is the file's modification time — the cheap signal, taken by the
/// caller who already stat'd the file. `now_ms` is passed in so this is a pure
/// function and its boundaries can be tested.
pub fn probe(path: &Path, mtime_ms: u64, now_ms: u64) -> Liveness {
    let quiet = now_ms.saturating_sub(mtime_ms);

    if let Some(name) = scan_tail(path) {
        // A tool that never returned — the process died mid-flight — would
        // otherwise read as live forever, so an outstanding call still expires.
        return if quiet < IDLE_MS {
            Liveness::Live { tool: Some(name) }
        } else {
            Liveness::NoLongerLive
        };
    }

    match quiet {
        q if q <= WRITING_MS => Liveness::Live { tool: None },
        q if q <= LIVE_MS => Liveness::Guessed,
        q if q <= IDLE_MS => Liveness::Idle,
        _ => Liveness::NoLongerLive,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static N: AtomicUsize = AtomicUsize::new(0);

    fn scratch(tag: &str) -> PathBuf {
        let n = N.fetch_add(1, Ordering::SeqCst);
        let d = std::env::temp_dir().join(format!("cv-live-{}-{n}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    const NOW: u64 = 1_800_000_000_000;

    fn write(dir: &Path, lines: &[&str]) -> PathBuf {
        let p = dir.join("t.jsonl");
        fs::write(&p, lines.join("\n")).unwrap();
        p
    }

    fn call(id: &str, name: &str, ts: &str) -> String {
        format!(
            r#"{{"timestamp":"{ts}","message":{{"content":[{{"type":"tool_use","id":"{id}","name":"{name}"}}]}}}}"#
        )
    }

    fn result(id: &str, ts: &str) -> String {
        format!(
            r#"{{"timestamp":"{ts}","message":{{"content":[{{"type":"tool_result","tool_use_id":"{id}"}}]}}}}"#
        )
    }

    /// The point of the module. A four-minute build leaves the transcript silent,
    /// and a clock alone would call the session dead — measured, that would have
    /// happened 26 times in one real corpus.
    /// Probe the REAL transcripts on this machine. Opt-in:
    /// `CV_DUMP_LIVENESS=1 cargo test dump_liveness -- --nocapture`.
    #[test]
    fn dump_liveness() {
        if std::env::var("CV_DUMP_LIVENESS").is_err() {
            return;
        }
        let root = dirs::home_dir().unwrap().join(".claude/projects");
        let now = crate::session::now_ms();
        let mut rows = vec![];
        for proj in fs::read_dir(&root).unwrap().flatten() {
            let Ok(files) = fs::read_dir(proj.path()) else {
                continue;
            };
            for f in files.flatten() {
                let p = f.path();
                if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                let Ok(md) = f.metadata() else { continue };
                let mtime = md
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                rows.push((
                    (now.saturating_sub(mtime)) / 1000,
                    p.file_stem().unwrap().to_string_lossy()[..8].to_string(),
                    probe(&p, mtime, now),
                ));
            }
        }
        rows.sort_by_key(|(quiet, id, _)| (*quiet, id.clone()));
        for (quiet, id, state) in rows.iter().take(8) {
            eprintln!("  quiet={quiet:>7}s  {id}  {state:?}");
        }
        eprintln!("  ({} transcripts probed)", rows.len());
    }

    #[test]
    fn a_session_waiting_on_a_long_tool_is_live_however_quiet_the_file_is() {
        let d = scratch("outstanding");
        let p = write(&d, &[&call("t1", "Bash", "2026-09-19T04:20:16.000Z")]);
        let quiet_for_4_minutes = NOW - 240_000;
        assert_eq!(
            probe(&p, quiet_for_4_minutes, NOW),
            Liveness::Live {
                tool: Some("Bash".into())
            }
        );
    }

    #[test]
    fn a_finished_tool_leaves_nothing_outstanding() {
        let d = scratch("finished");
        let p = write(
            &d,
            &[
                &call("t1", "Bash", "2026-09-19T04:20:16.000Z"),
                &result("t1", "2026-09-19T04:20:18.000Z"),
            ],
        );
        // Same four minutes of silence, but nothing explains it now.
        assert_eq!(probe(&p, NOW - 240_000, NOW), Liveness::Idle);
    }

    #[test]
    fn the_newest_outstanding_call_is_the_one_being_waited_on() {
        let d = scratch("newest");
        let p = write(
            &d,
            &[
                &call("t1", "Read", "2026-09-19T04:20:10.000Z"),
                &call("t2", "Bash", "2026-09-19T04:20:12.000Z"),
                &result("t1", "2026-09-19T04:20:13.000Z"),
            ],
        );
        assert_eq!(
            probe(&p, NOW - 5_000, NOW),
            Liveness::Live {
                tool: Some("Bash".into())
            }
        );
    }

    /// A process killed mid-tool never writes the result, so an outstanding call
    /// must expire — otherwise the session reads as live for ever.
    #[test]
    fn an_outstanding_call_that_never_returned_stops_being_live() {
        let d = scratch("stuck");
        let p = write(&d, &[&call("t1", "Bash", "2026-09-19T04:20:16.000Z")]);
        assert_eq!(probe(&p, NOW - IDLE_MS - 1, NOW), Liveness::NoLongerLive);
    }

    #[test]
    fn the_clock_carries_the_four_states_when_nothing_is_outstanding() {
        let d = scratch("clock");
        let p = write(
            &d,
            &[r#"{"timestamp":"2026-09-19T04:20:16.000Z","type":"user"}"#],
        );
        let at = |quiet: u64| probe(&p, NOW - quiet, NOW);

        assert_eq!(at(5_000), Liveness::Live { tool: None });
        assert_eq!(at(WRITING_MS), Liveness::Live { tool: None }); // boundary is inclusive
        assert_eq!(at(WRITING_MS + 1), Liveness::Guessed);
        assert_eq!(at(LIVE_MS), Liveness::Guessed);
        assert_eq!(at(LIVE_MS + 1), Liveness::Idle);
        assert_eq!(at(IDLE_MS), Liveness::Idle);
        assert_eq!(at(IDLE_MS + 1), Liveness::NoLongerLive);
    }

    /// 180 s, not 60 s: of 2,507 measured tool calls, 26 ran longer than a
    /// minute and only one longer than three.
    #[test]
    fn the_threshold_is_three_minutes_not_one() {
        let d = scratch("threshold");
        let p = write(
            &d,
            &[r#"{"timestamp":"2026-09-19T04:20:16.000Z","type":"user"}"#],
        );
        assert_ne!(
            probe(&p, NOW - 90_000, NOW),
            Liveness::Idle,
            "90s is not idle"
        );
        assert_ne!(
            probe(&p, NOW - 150_000, NOW),
            Liveness::Idle,
            "150s is not idle"
        );
    }

    #[test]
    fn an_unreadable_transcript_falls_back_to_the_clock_rather_than_erroring() {
        let d = scratch("missing");
        let p = d.join("does-not-exist.jsonl");
        assert_eq!(probe(&p, NOW - 1_000, NOW), Liveness::Live { tool: None });
    }

    /// Only the tail is read: a 41 MB transcript must not cost 41 MB a poll.
    #[test]
    fn only_the_tail_is_read() {
        let d = scratch("big");
        let filler = format!(
            "{}\n",
            r#"{"timestamp":"2026-09-19T04:00:00.000Z","message":{"content":[]}}"#
        )
        .repeat(9_000);
        let p = d.join("t.jsonl");
        fs::write(
            &p,
            format!("{filler}{}", call("t9", "Grep", "2026-09-19T04:20:16.000Z")),
        )
        .unwrap();
        assert!(
            fs::metadata(&p).unwrap().len() > TAIL_BYTES,
            "fixture must exceed the window"
        );
        assert_eq!(
            probe(&p, NOW - 1_000, NOW),
            Liveness::Live {
                tool: Some("Grep".into())
            }
        );
    }
}
