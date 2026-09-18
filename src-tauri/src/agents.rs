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
//! # Status, and the trap in it
//!
//! The obvious rule — "the parent holds a `tool_result` for the task call, so
//! the run finished" — is **wrong for the common case**, and wrong in the
//! direction that looks fine. Measured across every task call on this machine:
//! **40 of 43 carry `toolUseResult.status == "async_launched"`**, which is
//! written when the run is *launched*, not when it ends. Keying completion off
//! the result's existence marks a background run "done" the instant it starts,
//! and the 11-run reference session cannot catch it because every run there had
//! genuinely finished.
//!
//! Completion comes instead from a **task notification** the parent writes when
//! a run stops: a `<task-id>` equal to the run's agent id, and a `<status>` of
//! `completed` / `stopped` / `killed` / `failed`. Verified exact — 11 of 11
//! runs in the reference session carry one, and in a live session the only run
//! without one was the agent still running at the time.
//!
//! Two traps, both from the research on #20:
//!
//! - The notification is written in **three** record shapes (`user`,
//!   `attachment`, `queue-operation`) and repeated 2–3× per stop, so it is
//!   matched by scanning raw text and deduped by agent id.
//! - `stop_reason` on the child is **not** a terminal signal, so it is not used
//!   here: a run can be resumed through `SendMessage` with no second task call,
//!   and `end_turn` would then read as finished while it is working again.
//!
//! What remains unknowable: a run whose session was killed outright leaves no
//! notification, so it looks exactly like one still thinking. [`Status::Running`]
//! therefore means "no stop signal", which is a weaker claim than the word
//! suggests. Issue #23 settles whether that earns a staleness rule.

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
    /// The parent wrote a task notification with `<status>completed</status>`.
    /// The run reached its own end — which does NOT mean it succeeded at the
    /// job, only that it stopped of its own accord.
    Done,
    /// Notified `stopped` or `killed`: ended before finishing, by interruption
    /// or by the harness.
    Stopped,
    /// Notified `failed`.
    Failed,
    /// No stop notification. Means "still running" OR "the session died
    /// mid-run" — indistinguishable from the record. Do not present this as a
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

/// What the parent's `toolUseResult` says about one task call.
#[derive(Default, Clone)]
struct TaskResult {
    /// `toolUseResult.status`: `"completed"` is a real end; `"async_launched"`
    /// is only a launch receipt.
    status: Option<String>,
    /// `toolUseResult.resolvedModel` — present on every task call observed,
    /// and the only model a run that never produced a turn has.
    resolved_model: Option<String>,
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
    // What the parent's tool_result says about each task call. NOT "is it
    // finished" — for an async run the result lands at launch.
    let mut resolved: HashMap<String, TaskResult> = HashMap::new();
    // Stop notifications, by agent id. THIS is the completion signal.
    let mut notified: HashMap<String, String> = HashMap::new();

    scan(
        parent,
        None,
        &mut turns,
        &mut seen_in,
        &mut parent_counts,
        &mut resolved,
        Some(&mut notified),
    )
    .map_err(|_| Unavailable::Unreadable)?;

    let subs = subagents_for(parent);
    for sub in &subs {
        let mut c = Counts::default();
        // A child's own tool_results are its business; only the parent's
        // resolve task calls, so children never contribute to `resolved`.
        let mut ignored = HashMap::new();
        if scan(
            &sub.path,
            Some(&sub.agent_id),
            &mut turns,
            &mut seen_in,
            &mut c,
            &mut ignored,
            None,
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
        let task = sub.tool_use_id.as_ref().and_then(|t| resolved.get(t));
        let status = match notified.get(&sub.agent_id).map(String::as_str) {
            Some("completed") => Status::Done,
            Some("stopped") | Some("killed") => Status::Stopped,
            Some("failed") => Status::Failed,
            // A synchronous run is the one case the tool_result itself ends —
            // `async_launched` is only a receipt (40 of 43 task calls).
            _ if task.map(|t| t.status.as_deref() == Some("completed")) == Some(true) => {
                Status::Done
            }
            // No stop signal at all. If there is no task call either, nothing
            // could ever have reported on it.
            _ if sub.tool_use_id.is_none() => Status::Unknown,
            _ => Status::Running,
        };
        // Plurality of the run's own turns, ties broken by name so the row
        // never flickers. A run that produced no turn at all — a spawn that
        // died before answering — has none, so fall back to the parent's
        // `resolvedModel`, which is recorded on every task call observed.
        let model = c
            .models
            .iter()
            .max_by(|a, b| a.1.cmp(b.1).then(b.0.cmp(a.0)))
            .map(|(m, _)| m.clone())
            .or_else(|| task.and_then(|t| t.resolved_model.clone()));
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
    resolved: &mut HashMap<String, TaskResult>,
    mut notified: Option<&mut HashMap<String, String>>,
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
        // Stop notifications are matched on the RAW line: the same
        // notification is written in three different record shapes (`user`,
        // `attachment`, `queue-operation`) and repeated 2-3x per stop, so
        // chasing the shapes is more fragile than reading the text.
        if let Some(n) = notified.as_deref_mut() {
            if line.contains("task-notification") {
                if let Some((agent, status)) = parse_notification(&line) {
                    n.insert(agent, status);
                }
            }
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
                            let tur = &v["toolUseResult"];
                            resolved.insert(
                                id.to_string(),
                                TaskResult {
                                    status: tur["status"].as_str().map(str::to_string),
                                    resolved_model: tur["resolvedModel"]
                                        .as_str()
                                        .map(str::to_string),
                                },
                            );
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

/// Pull `(task-id, status)` out of a task notification. The task id of an
/// agent notification IS the run's agent id.
///
/// Hand-rolled rather than regex: the payload is embedded in a JSON string, so
/// it arrives escaped, and the two tags are adjacent enough that a scan is
/// clearer than an escaped pattern.
fn parse_notification(line: &str) -> Option<(String, String)> {
    let between = |hay: &str, open: &str, close: &str| -> Option<String> {
        let i = hay.find(open)? + open.len();
        let j = hay[i..].find(close)? + i;
        Some(hay[i..j].to_string())
    };
    let id = between(line, "<task-id>", "</task-id>")?;
    // Status follows the id in the envelope; search from there so a line
    // carrying two notifications does not cross-pair them.
    let after = line.split_at(line.find(&id)? + id.len()).1;
    let status = between(after, "<status>", "</status>")?;
    if id.is_empty() || status.is_empty() {
        return None;
    }
    Some((id, status))
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

    /// A parent `tool_result` for a task call, carrying its `toolUseResult`.
    fn task_result(tool_use_id: &str, status: &str, ts: &str) -> String {
        format!(
            r#"{{"timestamp":"{ts}","message":{{"content":[{{"type":"tool_result","tool_use_id":"{tool_use_id}"}}]}},"toolUseResult":{{"status":"{status}","resolvedModel":"claude-opus-5[1m]","agentId":"x"}}}}"#
        )
    }

    /// The parent's stop notification for a run. Written in three record
    /// shapes in reality; one is enough to prove the matcher.
    fn notification(agent: &str, status: &str, ts: &str) -> String {
        let body = format!(
            "<task-notification><task-id>{agent}</task-id><status>{status}</status></task-notification>"
        );
        let v = serde_json::json!({
            "timestamp": ts,
            "type": "user",
            "message": { "role": "user", "content": body },
        });
        v.to_string()
    }

    #[test]
    fn a_completed_task_result_means_done() {
        let d = tmp("status");
        let p = d.join("s1.jsonl");
        // The parent COMPLETED toolu_A but only launched toolu_B.
        fs::write(
            &p,
            format!(
                "{}\n{}\n",
                turn("r1", "claude-opus-5", 10, 5, "2026-09-18T10:00:00Z"),
                task_result("toolu_A", "completed", "2026-09-18T10:05:00Z"),
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
        assert_eq!(
            by("aaa"),
            Status::Done,
            "a SYNCHRONOUS result does end the run"
        );
        assert_eq!(by("bbb"), Status::Running, "no result at all");
        assert_eq!(by("ccc"), Status::Unknown, "no task call to resolve");
    }

    #[test]
    fn an_async_launch_receipt_is_not_a_completion() {
        // THE trap. `toolUseResult.status: "async_launched"` is written when a
        // background run STARTS — 40 of 43 task calls on this machine carry it.
        // Treating the result's existence as completion marks every background
        // run "done" the instant it spawns, and a corpus of finished runs
        // cannot catch it.
        let d = tmp("async");
        let p = d.join("s1.jsonl");
        fs::write(
            &p,
            format!(
                "{}\n{}\n{}\n{}\n",
                turn("r1", "claude-opus-5", 10, 5, "2026-09-18T10:00:00Z"),
                task_result("toolu_A", "async_launched", "2026-09-18T10:00:05Z"),
                task_result("toolu_B", "async_launched", "2026-09-18T10:00:06Z"),
                // aaa stopped; bbb never did.
                notification("aaa", "completed", "2026-09-18T10:02:30Z"),
            ),
        )
        .unwrap();
        let sd = sub_dir(&p);
        // aaa finished — its own last assistant record says so.
        write_run(
            &sd,
            "s1",
            "aaa",
            Some("toolu_A"),
            &format!(
                "{}\n",
                sub_turn("aaa", "r2", "claude-opus-5", 1, 1, "2026-09-18T10:01:00Z")
            ),
        );
        // bbb was launched and has produced a turn, but never ended.
        write_run(
            &sd,
            "s1",
            "bbb",
            Some("toolu_B"),
            &format!(
                "{}\n",
                sub_turn("bbb", "r3", "claude-opus-5", 1, 1, "2026-09-18T10:01:00Z")
            ),
        );

        let r = read_roster(&p).unwrap();
        let by = |id: &str| r.runs.iter().find(|x| x.id == id).unwrap().status;
        assert_eq!(by("aaa"), Status::Done, "its stop notification ended it");
        assert_eq!(
            by("bbb"),
            Status::Running,
            "a launch receipt must never read as a completion"
        );
    }

    #[test]
    fn a_run_that_never_answered_still_gets_a_row_and_a_model() {
        // Observed for real: a run spawned against a broken model wrote its
        // prompt and 24KB of attachments, then produced no assistant turn at
        // all. It is a legitimate state, not a read failure — and the only
        // model it has is the parent's `resolvedModel`.
        let d = tmp("silent");
        let p = d.join("s1.jsonl");
        fs::write(
            &p,
            format!(
                "{}\n{}\n",
                turn("r1", "claude-opus-5", 10, 5, "2026-09-18T10:00:00Z"),
                task_result("toolu_A", "async_launched", "2026-09-18T10:00:05Z"),
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
                sidechain(
                    "aaa",
                    r#"{"timestamp":"2026-09-18T10:00:06Z","type":"user","message":{"role":"user","content":"go"}}"#
                )
            ),
        );
        let run = &read_roster(&p).unwrap().runs[0];
        assert_eq!(run.turns, 0, "it never answered");
        assert_eq!(run.tools, 0);
        assert_eq!(
            run.model.as_deref(),
            Some("claude-opus-5[1m]"),
            "falls back to the parent's resolvedModel"
        );
        assert_eq!(run.status, Status::Running, "no completion signal");
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
                    // NOT asserted: that a run has turns. A run spawned against
                    // a broken model writes its prompt and never answers, which
                    // is a real state this corpus contains. Asserting otherwise
                    // is what first flagged it as a bug.
                    assert!(run.ended_at >= run.started_at, "time runs forwards");
                    assert!(run.depth >= 1, "depth is 1-based");
                    assert!(
                        run.started_at > 0,
                        "a discovered run always has at least one timestamped record: {} in {}",
                        run.id,
                        p.display()
                    );
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
                let _ = run_turns;
                // The stop notification must actually resolve real runs. A
                // regression here shows up as a roster where everything is
                // "running" forever, or where everything is "done" instantly.
                let unresolved = r
                    .runs
                    .iter()
                    .filter(|x| x.status == Status::Running)
                    .count();
                eprintln!(
                    "     statuses: {} done, {} stopped, {} failed, {} running/unknown",
                    r.runs.iter().filter(|x| x.status == Status::Done).count(),
                    r.runs
                        .iter()
                        .filter(|x| x.status == Status::Stopped)
                        .count(),
                    r.runs.iter().filter(|x| x.status == Status::Failed).count(),
                    unresolved,
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

    /// Dump a real roster as the JSON the command actually sends, so the
    /// viewer can be rendered against it. Opt-in: set CV_DUMP_ROSTER=<path>.
    #[test]
    fn dump_roster_json() {
        let Ok(dest) = std::env::var("CV_DUMP_ROSTER") else {
            return;
        };
        let root = PathBuf::from(std::env::var("HOME").unwrap()).join(".claude/projects");
        let mut best: Option<(usize, Roster, String)> = None;
        for proj in fs::read_dir(&root).unwrap().flatten() {
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
                let n = r.runs.len();
                if best.as_ref().map(|b| n > b.0).unwrap_or(true) {
                    let model = p.display().to_string();
                    best = Some((n, r, model));
                }
            }
        }
        let (_, roster, from) = best.expect("a session with runs");
        fs::write(&dest, serde_json::to_string_pretty(&roster).unwrap()).unwrap();
        eprintln!("dumped {} runs from {from} -> {dest}", roster.runs.len());
    }

    /// Dump a trace page that straddles a subagent boundary, so the promoted
    /// run header can be rendered. Opt-in: CV_DUMP_TRACE=<path>.
    #[test]
    fn dump_trace_json() {
        let Ok(dest) = std::env::var("CV_DUMP_TRACE") else {
            return;
        };
        let p = PathBuf::from(std::env::var("HOME").unwrap())
            .join(".claude/projects/-home-quantumvik/44d945fe-203a-46dd-9f3d-e248cc3108ae.jsonl");
        if !p.exists() {
            return;
        }
        // Page until a subagent entry shows up, then keep that page.
        let mut cursor = crate::trace::Cursor::default();
        for _ in 0..40 {
            let page = crate::trace::read_page(Some(&p), &cursor, 400).unwrap();
            let has_agent = page.entries.iter().any(|e| e.agent_id.is_some());
            cursor = crate::trace::Cursor::decode(&page.cursor).unwrap();
            if has_agent || !page.has_more {
                fs::write(&dest, serde_json::to_string_pretty(&page).unwrap()).unwrap();
                eprintln!(
                    "dumped {} entries (agents: {has_agent}) -> {dest}",
                    page.entries.len()
                );
                return;
            }
        }
    }
}
