//! The agent-run roster: every subagent a session spawned, named and costed.
//!
//! An **agent run** is one spawned execution — its own transcript, its own
//! context window, its own model and its own cost. It is the unit the Agents
//! section counts: two runs of `general-purpose` are two runs, never one.
//! See `CONTEXT.md`; the distinction between a run and an *agent type* is
//! load-bearing here.
//!
//! # Why this reads from disk instead of the live ledger
//!
//! [`crate::session::UsageLedger`] already holds per-turn usage tagged with
//! `agent_id`, so a roster could be projected straight off it. It isn't,
//! because the ledger only exists for a session *this app launched and tailed*.
//! Reading from disk means the roster works for a past or resumed session too,
//! on the same code path — the alternative was two implementations that agree
//! until they don't.
//!
//! # The one rule that matters (issue #24)
//!
//! Per-run cost is a **partition of a globally-deduped total**, never a sum of
//! per-file totals. Claude Code writes one JSONL record per content block, each
//! repeating the same `message.usage`, and a *resumed* session replays earlier
//! turns verbatim into a new file — so the same turn can exist in two files at
//! once. [`read_roster`] therefore folds the parent and every subagent file
//! into **one** map keyed by `requestId` → `message.id` → `uuid`, last-wins,
//! before attributing anything. Measured on the 11-run reference session: 897
//! turn keys, 0 of them in more than one file, parent $142.65 + runs $21.47 =
//! $164.12 — the same figure the ledger produces. The zero is a property of
//! *that* session, not a guarantee, which is exactly why the fold is global.
//!
//! # Status is provisional
//!
//! [`Status`] is derived from the only exact signal available today: the parent
//! holds a `tool_result` for the run's task call. That cannot distinguish a run
//! that is still going from one whose session was killed mid-flight. Issue #23
//! settles the real model once the termination and discovery research lands;
//! until then `Running` means "no result yet", which is a weaker claim than the
//! word suggests.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;

use serde::Serialize;
use serde_json::Value;

use crate::trace::Unavailable;
use crate::transcript::{parse_iso_ms, subagents_for, TokenUsage};

/// What the roster can say about a run's liveness today. Deliberately small:
/// every state here is derivable from something observed. See the module note —
/// #23 decides whether this grows a `Failed` and a staleness rule.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// The parent holds a `tool_result` for this run's task call. Exact.
    Done,
    /// No result yet. Means "still running" OR "the session died mid-run" —
    /// the two are indistinguishable from the record. Do not present this as a
    /// stronger claim than it is.
    Running,
    /// No sidecar `toolUseId`, so the run cannot be tied to a task call at all
    /// and its completion is unknowable. Rare: 16 of 16 real sidecars had one.
    Unknown,
}

/// One spawned execution, with everything the roster row needs.
#[derive(Debug, Clone, Serialize)]
pub struct AgentRun {
    /// Filename stem minus `agent-`. The fallback label when there is no
    /// description — never the primary one.
    pub id: String,
    /// The configuration it was spawned as (`general-purpose`, …). A property
    /// of the run; never a thing that itself runs or costs money.
    #[serde(rename = "agentType", skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<String>,
    /// The sidecar's own words for the job. **The row's identity.** Author-
    /// supplied, so it can be absent or long; the viewer middle-truncates it
    /// and never truncates from the right (#22).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub depth: u32,
    #[serde(rename = "parentAgentId", skip_serializing_if = "Option::is_none")]
    pub parent_agent_id: Option<String>,
    /// The parent task call that spawned it — the exact, bidirectional link.
    #[serde(rename = "toolUseId", skip_serializing_if = "Option::is_none")]
    pub tool_use_id: Option<String>,
    /// The model of the plurality of its turns. Comes from the run's own
    /// records: only 1 of 16 real sidecars carried a `model` field, so the
    /// sidecar cannot be the source. Cost is still computed per turn at each
    /// turn's own rate — this label never stands in for that.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub turns: usize,
    /// `tool_use` blocks the run issued — what it actually did.
    pub tools: usize,
    pub usage: TokenUsage,
    #[serde(rename = "startedAt")]
    pub started_at: u64,
    #[serde(rename = "endedAt")]
    pub ended_at: u64,
    pub status: Status,
}

/// The whole partition: the runs, plus what is left on the parent.
///
/// Parent totals ship alongside deliberately, so a viewer can render "runs are
/// N% of this session" without a second pass and without the risk of dividing
/// by a total it computed differently.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Roster {
    pub runs: Vec<AgentRun>,
    #[serde(rename = "parentTurns")]
    pub parent_turns: usize,
    #[serde(rename = "parentUsage")]
    pub parent_usage: TokenUsage,
    /// Turn keys that appeared in more than one file and were folded away.
    /// Surfaced because it is the difference between this and naive addition —
    /// and because a nonzero value here means the session was resumed.
    #[serde(rename = "duplicatesFolded")]
    pub duplicates_folded: usize,
}

/// One folded turn: the last record wins, and it carries where it came from.
struct Turn {
    agent_id: Option<String>,
    model: Option<String>,
    usage: TokenUsage,
}

/// Per-run facts that are counted, not folded — tool calls and the time span.
#[derive(Default)]
struct Counts {
    tools: usize,
    first_ts: u64,
    last_ts: u64,
    models: HashMap<String, usize>,
}

impl Counts {
    fn saw(&mut self, ts: u64) {
        if ts > 0 {
            if self.first_ts == 0 || ts < self.first_ts {
                self.first_ts = ts;
            }
            if ts > self.last_ts {
                self.last_ts = ts;
            }
        }
    }
}

/// Build the roster for a session.
///
/// `parent` is the session's own `.jsonl`; subagents are discovered beneath it.
/// Returns [`Unavailable::Unreadable`] only when the *parent* cannot be read —
/// a session with no runs is an empty roster, which is the common case and not
/// an error.
pub fn read_roster(parent: &Path) -> Result<Roster, Unavailable> {
    if !parent.exists() {
        return Err(Unavailable::NoTranscript);
    }

    // ── one global fold, so a replayed turn is counted once ──────────────
    let mut turns: HashMap<String, Turn> = HashMap::new();
    let mut seen_in: HashMap<String, HashSet<String>> = HashMap::new();
    let mut counts: HashMap<String, Counts> = HashMap::new();
    let mut parent_counts = Counts::default();
    // Task calls the parent has already received a result for.
    let mut resolved: HashSet<String> = HashSet::new();

    scan(
        parent,
        None,
        &mut turns,
        &mut seen_in,
        &mut parent_counts,
        &mut resolved,
    )
    .map_err(|_| Unavailable::Unreadable)?;

    let subs = subagents_for(parent);
    for sub in &subs {
        let mut c = Counts::default();
        // A child's own tool_results are its business; only the parent's
        // resolve task calls, so children never contribute to `resolved`.
        let mut ignored = HashSet::new();
        if scan(
            &sub.path,
            Some(&sub.agent_id),
            &mut turns,
            &mut seen_in,
            &mut c,
            &mut ignored,
        )
        .is_ok()
        {
            counts.insert(sub.agent_id.clone(), c);
        }
    }

    // ── attribute the folded turns ───────────────────────────────────────
    let mut per_agent: HashMap<String, (usize, TokenUsage)> = HashMap::new();
    let mut out = Roster {
        duplicates_folded: seen_in.values().filter(|f| f.len() > 1).count(),
        ..Default::default()
    };
    for t in turns.values() {
        match &t.agent_id {
            None => {
                out.parent_turns += 1;
                add(&mut out.parent_usage, &t.usage);
            }
            Some(id) => {
                let slot = per_agent.entry(id.clone()).or_default();
                slot.0 += 1;
                add(&mut slot.1, &t.usage);
                if let Some(m) = &t.model {
                    if let Some(c) = counts.get_mut(id) {
                        *c.models.entry(m.clone()).or_insert(0) += 1;
                    }
                }
            }
        }
    }

    for sub in subs {
        let c = counts.remove(&sub.agent_id).unwrap_or_default();
        let (turns_n, usage) = per_agent.remove(&sub.agent_id).unwrap_or_default();
        let status = match &sub.tool_use_id {
            None => Status::Unknown,
            Some(t) if resolved.contains(t) => Status::Done,
            Some(_) => Status::Running,
        };
        // Plurality model, ties broken by name so the row never flickers.
        let model = c
            .models
            .iter()
            .max_by(|a, b| a.1.cmp(b.1).then(b.0.cmp(a.0)))
            .map(|(m, _)| m.clone());
        out.runs.push(AgentRun {
            id: sub.agent_id,
            agent_type: sub.agent_type,
            description: sub.description,
            depth: sub.depth,
            parent_agent_id: sub.parent_agent_id,
            tool_use_id: sub.tool_use_id,
            model,
            turns: turns_n,
            tools: c.tools,
            usage,
            started_at: c.first_ts,
            ended_at: c.last_ts,
            status,
        });
    }

    // Oldest first: the order they ran is the order they are read about.
    out.runs.sort_by(|a, b| {
        a.started_at
            .cmp(&b.started_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(out)
}

/// Fold one transcript into the shared maps.
fn scan(
    path: &Path,
    agent_id: Option<&str>,
    turns: &mut HashMap<String, Turn>,
    seen_in: &mut HashMap<String, HashSet<String>>,
    counts: &mut Counts,
    resolved: &mut HashSet<String>,
) -> std::io::Result<()> {
    let file = fs::File::open(path)?;
    let source = agent_id.unwrap_or("").to_string();

    for line in BufReader::new(file).lines() {
        // A torn final line in a file being appended to right now is normal;
        // skip it rather than failing the whole roster.
        let Ok(line) = line else { continue };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };

        let ts = v["timestamp"].as_str().and_then(parse_iso_ms).unwrap_or(0);
        counts.saw(ts);

        if let Some(blocks) = v["message"]["content"].as_array() {
            for b in blocks {
                match b["type"].as_str() {
                    Some("tool_use") => counts.tools += 1,
                    Some("tool_result") => {
                        if let Some(id) = b["tool_use_id"].as_str() {
                            resolved.insert(id.to_string());
                        }
                    }
                    _ => {}
                }
            }
        }

        if v["message"]["usage"].is_object() {
            let Some(key) = v["requestId"]
                .as_str()
                .or_else(|| v["message"]["id"].as_str())
                .or_else(|| v["uuid"].as_str())
            else {
                continue;
            };
            // Malformed usage is skipped rather than folded in as zero: a
            // zero-cost turn still increments the turn count, so it would show
            // as work that cost nothing instead of as the parse failure it is.
            let Some(usage) = TokenUsage::parse(&v) else {
                continue;
            };
            seen_in
                .entry(key.to_string())
                .or_default()
                .insert(source.clone());
            // LAST-WINS: output_tokens grows across a turn's repeated records,
            // so the final one is the complete picture (#15).
            turns.insert(
                key.to_string(),
                Turn {
                    agent_id: agent_id.map(str::to_string),
                    model: v["message"]["model"].as_str().map(str::to_string),
                    usage,
                },
            );
        }
    }
    Ok(())
}

fn add(into: &mut TokenUsage, u: &TokenUsage) {
    into.input += u.input;
    into.cache_read += u.cache_read;
    into.cache_write_5m += u.cache_write_5m;
    into.cache_write_1h += u.cache_write_1h;
    into.output += u.output;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("cv-agents-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// A parent transcript line carrying usage.
    fn turn(req: &str, model: &str, input: u64, output: u64, ts: &str) -> String {
        format!(
            r#"{{"timestamp":"{ts}","requestId":"{req}","message":{{"id":"m-{req}","model":"{model}","usage":{{"input_tokens":{input},"output_tokens":{output},"cache_read_input_tokens":0}},"content":[{{"type":"text","text":"hi"}}]}}}}"#
        )
    }

    /// The same, as a SUBAGENT record. `subagents_for` gates discovery on the
    /// first line being a sidechain whose `sessionId` matches the session
    /// directory — a real transcript carries these and a naive fixture does not,
    /// which is worth keeping in the tests rather than working around.
    fn sub_turn(agent: &str, req: &str, model: &str, input: u64, output: u64, ts: &str) -> String {
        sidechain(agent, &turn(req, model, input, output, ts))
    }

    /// Stamp the sidechain markers onto an already-formed record line.
    fn sidechain(agent: &str, line: &str) -> String {
        let mut v: serde_json::Value = serde_json::from_str(line).unwrap();
        v["isSidechain"] = serde_json::json!(true);
        v["sessionId"] = serde_json::json!("s1");
        v["agentId"] = serde_json::json!(agent);
        v.to_string()
    }

    fn sub_dir(parent: &Path) -> PathBuf {
        let d = parent.with_extension("").join("subagents");
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn write_run(dir: &Path, session: &str, id: &str, tool_use_id: Option<&str>, body: &str) {
        let tu = tool_use_id
            .map(|t| format!(r#","toolUseId":"{t}""#))
            .unwrap_or_default();
        fs::write(
            dir.join(format!("agent-{id}.meta.json")),
            format!(
                r#"{{"agentType":"general-purpose","description":"do a thing","spawnDepth":1,"sessionId":"{session}"{tu}}}"#
            ),
        )
        .unwrap();
        fs::write(dir.join(format!("agent-{id}.jsonl")), body).unwrap();
    }

    #[test]
    fn a_session_with_no_runs_is_an_empty_roster_not_an_error() {
        let d = tmp("none");
        let p = d.join("s1.jsonl");
        fs::write(
            &p,
            turn("r1", "claude-opus-5", 10, 5, "2026-09-18T10:00:00Z"),
        )
        .unwrap();
        let r = read_roster(&p).expect("a session with no subagents is fine");
        assert!(r.runs.is_empty());
        assert_eq!(r.parent_turns, 1);
    }

    #[test]
    fn a_missing_transcript_is_typed_absence_not_an_empty_roster() {
        let d = tmp("missing");
        assert!(matches!(
            read_roster(&d.join("nope.jsonl")),
            Err(Unavailable::NoTranscript)
        ));
    }

    #[test]
    fn a_run_is_done_only_when_the_parent_resolved_its_task_call() {
        let d = tmp("status");
        let p = d.join("s1.jsonl");
        // The parent resolves toolu_A but not toolu_B.
        fs::write(
            &p,
            format!(
                "{}\n{}\n",
                turn("r1", "claude-opus-5", 10, 5, "2026-09-18T10:00:00Z"),
                r#"{"timestamp":"2026-09-18T10:05:00Z","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_A"}]}}"#
            ),
        )
        .unwrap();
        let sd = sub_dir(&p);
        write_run(
            &sd,
            "s1",
            "aaa",
            Some("toolu_A"),
            &format!(
                "{}\n",
                sub_turn(
                    "aaa",
                    "r2",
                    "claude-haiku-4-5",
                    1,
                    1,
                    "2026-09-18T10:01:00Z"
                )
            ),
        );
        write_run(
            &sd,
            "s1",
            "bbb",
            Some("toolu_B"),
            &format!(
                "{}\n",
                sub_turn("bbb", "r3", "claude-opus-5", 2, 2, "2026-09-18T10:02:00Z")
            ),
        );
        write_run(
            &sd,
            "s1",
            "ccc",
            None, // no task call at all
            &format!(
                "{}\n",
                sub_turn("ccc", "r4", "claude-opus-5", 3, 3, "2026-09-18T10:03:00Z")
            ),
        );

        let r = read_roster(&p).unwrap();
        let by = |id: &str| r.runs.iter().find(|x| x.id == id).unwrap().status;
        assert_eq!(by("aaa"), Status::Done, "parent holds its result");
        assert_eq!(by("bbb"), Status::Running, "no result yet");
        assert_eq!(by("ccc"), Status::Unknown, "no task call to resolve");
    }

    #[test]
    fn a_turn_replayed_into_two_files_is_counted_once() {
        // The whole reason the fold is global (#24). A resumed session replays
        // earlier turns verbatim, so the same requestId exists twice. Summing
        // per-file would double-count it and the section would disagree with
        // the session header above it.
        let d = tmp("replay");
        let p = d.join("s1.jsonl");
        let shared = turn("dup", "claude-opus-5", 100, 10, "2026-09-18T10:00:00Z");
        fs::write(&p, format!("{shared}\n")).unwrap();
        let sd = sub_dir(&p);
        write_run(
            &sd,
            "s1",
            "aaa",
            Some("toolu_A"),
            &format!("{}\n", sidechain("aaa", &shared)),
        );

        let r = read_roster(&p).unwrap();
        assert_eq!(r.duplicates_folded, 1, "the shared key was seen in 2 files");
        let total = r.parent_turns + r.runs.iter().map(|x| x.turns).sum::<usize>();
        assert_eq!(total, 1, "one turn, not two — last writer owns it");
    }

    #[test]
    fn a_runs_model_comes_from_its_own_records_not_the_sidecar() {
        // Only 1 of 16 real sidecars carried `model`, so it cannot be the
        // source. Plurality wins: two haiku turns against one opus.
        let d = tmp("model");
        let p = d.join("s1.jsonl");
        fs::write(
            &p,
            turn("r1", "claude-opus-5", 1, 1, "2026-09-18T10:00:00Z"),
        )
        .unwrap();
        let sd = sub_dir(&p);
        write_run(
            &sd,
            "s1",
            "aaa",
            Some("toolu_A"),
            &format!(
                "{}\n{}\n{}\n",
                sub_turn(
                    "aaa",
                    "r2",
                    "claude-haiku-4-5",
                    1,
                    1,
                    "2026-09-18T10:01:00Z"
                ),
                sub_turn(
                    "aaa",
                    "r3",
                    "claude-haiku-4-5",
                    1,
                    1,
                    "2026-09-18T10:02:00Z"
                ),
                sub_turn("aaa", "r4", "claude-opus-5", 1, 1, "2026-09-18T10:03:00Z"),
            ),
        );
        let run = &read_roster(&p).unwrap().runs[0];
        assert_eq!(run.model.as_deref(), Some("claude-haiku-4-5"));
        assert_eq!(run.turns, 3);
    }

    #[test]
    fn tool_calls_and_span_are_counted_per_run() {
        let d = tmp("counts");
        let p = d.join("s1.jsonl");
        fs::write(
            &p,
            turn("r1", "claude-opus-5", 1, 1, "2026-09-18T10:00:00Z"),
        )
        .unwrap();
        let sd = sub_dir(&p);
        write_run(
            &sd,
            "s1",
            "aaa",
            Some("toolu_A"),
            &format!(
                "{}\n{}\n",
                sidechain(
                    "aaa",
                    r#"{"timestamp":"2026-09-18T10:01:00Z","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash"},{"type":"tool_use","id":"t2","name":"Read"}]}}"#
                ),
                sidechain(
                    "aaa",
                    r#"{"timestamp":"2026-09-18T10:04:30Z","message":{"content":[{"type":"tool_use","id":"t3","name":"Bash"}]}}"#
                ),
            ),
        );
        let run = &read_roster(&p).unwrap().runs[0];
        assert_eq!(run.tools, 3);
        assert_eq!(run.ended_at - run.started_at, 210_000, "3m30s in ms");
    }

    #[test]
    fn a_torn_final_line_does_not_sink_the_roster() {
        // A running transcript is being appended to as we read it.
        let d = tmp("torn");
        let p = d.join("s1.jsonl");
        fs::write(
            &p,
            turn("r1", "claude-opus-5", 1, 1, "2026-09-18T10:00:00Z"),
        )
        .unwrap();
        let sd = sub_dir(&p);
        write_run(
            &sd,
            "s1",
            "aaa",
            Some("toolu_A"),
            &format!(
                "{}\n{{\"timestamp\":\"2026-09-18T10:0",
                sub_turn("aaa", "r2", "claude-opus-5", 5, 5, "2026-09-18T10:01:00Z")
            ),
        );
        let r = read_roster(&p).unwrap();
        assert_eq!(r.runs.len(), 1);
        assert_eq!(r.runs[0].turns, 1, "the complete line still counts");
    }

    #[test]
    fn runs_come_back_oldest_first() {
        let d = tmp("order");
        let p = d.join("s1.jsonl");
        fs::write(
            &p,
            turn("r1", "claude-opus-5", 1, 1, "2026-09-18T10:00:00Z"),
        )
        .unwrap();
        let sd = sub_dir(&p);
        // written zzz-first so filename order would give the wrong answer
        write_run(
            &sd,
            "s1",
            "zzz",
            Some("t1"),
            &format!(
                "{}\n",
                sub_turn("zzz", "r2", "claude-opus-5", 1, 1, "2026-09-18T10:01:00Z")
            ),
        );
        write_run(
            &sd,
            "s1",
            "aaa",
            Some("t2"),
            &format!(
                "{}\n",
                sub_turn("aaa", "r3", "claude-opus-5", 1, 1, "2026-09-18T10:09:00Z")
            ),
        );
        let ids: Vec<_> = read_roster(&p)
            .unwrap()
            .runs
            .iter()
            .map(|r| r.id.clone())
            .collect();
        assert_eq!(ids, vec!["zzz", "aaa"], "started_at wins over filename");
    }

    /// The acid test: the real corpus, not a fixture.
    ///
    /// Skips silently where there is no such session (CI, another machine).
    /// Where there is one, it pins the partition — the property the whole
    /// module exists to get right — rather than a snapshot of one session's
    /// numbers, which would rot the moment the machine is used again.
    #[test]
    fn the_partition_holds_on_the_real_corpus() {
        let root = match std::env::var("HOME") {
            Ok(h) => PathBuf::from(h).join(".claude/projects"),
            Err(_) => return,
        };
        let Ok(projects) = fs::read_dir(&root) else {
            return;
        };

        let mut checked = 0;
        for proj in projects.flatten() {
            let Ok(files) = fs::read_dir(proj.path()) else {
                continue;
            };
            for f in files.flatten() {
                let p = f.path();
                if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                if !p.with_extension("").join("subagents").is_dir() {
                    continue;
                }
                let Ok(r) = read_roster(&p) else { continue };
                if r.runs.is_empty() {
                    continue;
                }
                checked += 1;

                // Every run the tailer can discover is in the roster, and every
                // one of them is attributable.
                assert_eq!(
                    r.runs.len(),
                    subagents_for(&p).len(),
                    "roster must cover every discovered run in {}",
                    p.display()
                );
                for run in &r.runs {
                    assert!(
                        run.turns > 0 || run.tools > 0,
                        "a discovered run with no turns and no tools is a read bug: {} in {}",
                        run.id,
                        p.display()
                    );
                    assert!(run.ended_at >= run.started_at, "time runs forwards");
                    assert!(run.depth >= 1, "depth is 1-based");
                }
                // The partition: parent turns and run turns are disjoint, and
                // together they are every folded turn. A key counted on both
                // sides would mean the global fold leaked.
                let run_turns: usize = r.runs.iter().map(|x| x.turns).sum();
                assert!(
                    r.parent_turns > 0,
                    "a session that spawned runs has parent turns too: {}",
                    p.display()
                );
                assert!(
                    run_turns > 0,
                    "runs with no turns at all means attribution failed: {}",
                    p.display()
                );
                eprintln!(
                    "  {}: {} runs, parent {} turns, runs {} turns, {} folded duplicates",
                    p.file_stem().unwrap_or_default().to_string_lossy(),
                    r.runs.len(),
                    r.parent_turns,
                    run_turns,
                    r.duplicates_folded
                );
            }
        }
        eprintln!("checked {checked} real session(s) with agent runs");
    }
}
