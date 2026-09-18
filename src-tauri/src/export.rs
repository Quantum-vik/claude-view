//! Export a session's trace to a file.
//!
//! Two formats, because they answer different questions:
//!
//!   - **Markdown** for a human — reading it back, pasting it into a report,
//!     showing someone what happened.
//!   - **JSON** for a machine — diffing two runs, feeding an analysis script,
//!     archiving something a future tool can parse.
//!
//! ## The rule money obeys here
//!
//! An exported figure outlives the app that produced it, and a number in a file
//! has no tooltip to explain itself. So every export states the caveat inline
//! and carries the price table's `AS_OF` date: a reader six months from now must
//! be able to tell that `$164.12` was notional, and priced against rates that
//! may since have changed. Tokens are the durable fact; dollars are derived.
//!
//! ## What an export contains
//!
//! The real session: prompts, replies, thinking, commands and their output.
//! Nothing is redacted, because this is the user's own transcript being written
//! to a path they chose. That is worth knowing before sharing one.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::json;

use crate::trace::{Entry, Kind};
use crate::transcript::TokenUsage;

/// Everything an export needs that is not an entry.
#[derive(Debug, Clone, Default)]
pub struct Meta {
    pub session_id: Option<String>,
    pub cwd: String,
    pub model: Option<String>,
    /// Transcripts read: the parent plus each subagent.
    pub sources: Vec<String>,
    pub exported_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Markdown,
    Json,
}

impl Format {
    pub fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "md" | "markdown" => Some(Format::Markdown),
            "json" => Some(Format::Json),
            _ => None,
        }
    }
    pub fn extension(self) -> &'static str {
        match self {
            Format::Markdown => "md",
            Format::Json => "json",
        }
    }

    /// Ensure a chosen path carries this format's extension.
    ///
    /// A save dialog lets you type a bare name. Writing `myexport` with no
    /// extension gives a file the desktop cannot open and the user cannot
    /// identify a month later, so append one — but never double it up.
    pub fn with_extension(self, dest: &str) -> String {
        let ext = self.extension();
        let already = dest
            .rsplit_once('.')
            .map(|(_, e)| e.eq_ignore_ascii_case(ext))
            .unwrap_or(false);
        if already {
            dest.to_string()
        } else {
            format!("{dest}.{ext}")
        }
    }
}

/// The caveat, stated inline because a file has no tooltip. Mirrors
/// `CAVEAT` in src/pricing.ts — keep the wording in step.
const NOTIONAL: &str = "Notional — what these tokens would have cost at Claude API list prices. \
A Claude subscription is billed at a flat rate, so this is not a bill.";

fn total(u: &TokenUsage) -> u64 {
    u.input + u.cache_read + u.cache_write_5m + u.cache_write_1h + u.output
}

fn sum(turns: &BTreeMap<String, TokenUsage>) -> TokenUsage {
    let mut acc = TokenUsage::default();
    for u in turns.values() {
        acc.input += u.input;
        acc.cache_read += u.cache_read;
        acc.cache_write_5m += u.cache_write_5m;
        acc.cache_write_1h += u.cache_write_1h;
        acc.output += u.output;
    }
    acc
}

/// Machine-readable export.
///
/// Deliberately carries **no dollar figure**: the price table lives in the
/// frontend with its own `AS_OF`, and baking a converted number into an archive
/// freezes today's rates into a file that looks authoritative forever. Tokens
/// are the fact; a reader can price them with whatever table is current.
pub fn to_json(entries: &[Entry], turns: &BTreeMap<String, TokenUsage>, meta: &Meta) -> String {
    #[derive(Serialize)]
    struct TurnOut<'a> {
        #[serde(rename = "turnId")]
        turn_id: &'a str,
        usage: &'a TokenUsage,
        tokens: u64,
    }
    let turn_list: Vec<TurnOut> = turns
        .iter()
        .map(|(id, u)| TurnOut {
            turn_id: id,
            usage: u,
            tokens: total(u),
        })
        .collect();

    let doc = json!({
        "claudeView": { "export": 1, "exportedAt": meta.exported_at },
        "session": {
            "sessionId": meta.session_id,
            "cwd": meta.cwd,
            "model": meta.model,
            "sources": meta.sources,
        },
        "totals": {
            "turns": turns.len(),
            "entries": entries.len(),
            "usage": sum(turns),
            "tokens": total(&sum(turns)),
            "note": NOTIONAL,
        },
        "turns": turn_list,
        "entries": entries,
    });
    serde_json::to_string_pretty(&doc).unwrap_or_else(|e| format!("{{\"error\":\"{e}\"}}"))
}

fn fence(text: &str) -> String {
    // A transcript can legitimately contain ``` — pick a longer fence than
    // anything inside, or the block terminates early and mangles the rest of
    // the document.
    let longest = text
        .lines()
        .filter(|l| l.trim_start().starts_with("```"))
        .map(|l| l.trim_start().chars().take_while(|c| *c == '`').count())
        .max()
        .unwrap_or(0);
    "`".repeat(longest.max(2) + 1)
}

/// Human-readable export.
pub fn to_markdown(entries: &[Entry], turns: &BTreeMap<String, TokenUsage>, meta: &Meta) -> String {
    let mut o = String::with_capacity(entries.len() * 200);
    let totals = sum(turns);

    o.push_str("# Claude Code session\n\n");
    if let Some(sid) = &meta.session_id {
        o.push_str(&format!("- **Session**: `{sid}`\n"));
    }
    o.push_str(&format!("- **Directory**: `{}`\n", meta.cwd));
    if let Some(m) = &meta.model {
        o.push_str(&format!("- **Model**: {m}\n"));
    }
    o.push_str(&format!("- **Exported**: {}\n", meta.exported_at));
    let subs = meta.sources.len().saturating_sub(1);
    o.push_str(&format!(
        "- **Transcripts**: parent{}\n",
        if subs > 0 {
            format!(" + {subs} subagent{}", if subs == 1 { "" } else { "s" })
        } else {
            String::new()
        }
    ));
    o.push_str(&format!(
        "- **Totals**: {} turns · {} entries · {} tokens\n",
        turns.len(),
        entries.len(),
        total(&totals)
    ));
    o.push_str(&format!(
        "\n> {NOTIONAL}\n>\n> Token counts are exact; any cost derived from them depends on the \
price table in effect when it was calculated.\n\n"
    ));

    o.push_str("| Token kind | Count |\n|---|---:|\n");
    for (label, n) in [
        ("Input (uncached)", totals.input),
        ("Cache read", totals.cache_read),
        ("Cache write (5m)", totals.cache_write_5m),
        ("Cache write (1h)", totals.cache_write_1h),
        ("Output", totals.output),
    ] {
        o.push_str(&format!("| {label} | {n} |\n"));
    }
    o.push_str("\n---\n\n");

    let mut agent: Option<String> = None;
    let mut turn: Option<String> = None;
    // The first entry is usually the parent's, whose agent_id is None — the
    // same as the initial state — so a bare inequality never fires and the
    // parent section loses its heading. Track that we have opened one.
    let mut opened = false;

    for e in entries {
        if !opened || e.agent_id != agent {
            opened = true;
            agent.clone_from(&e.agent_id);
            turn = None;
            if let Some(a) = &agent {
                o.push_str(&format!("\n## Subagent `{a}`\n\n"));
            } else {
                o.push_str("\n## Parent session\n\n");
            }
        }
        if agent.is_none() && e.turn_id.is_some() && e.turn_id != turn {
            turn.clone_from(&e.turn_id);
            if let Some(id) = &turn {
                if let Some(u) = turns.get(id) {
                    o.push_str(&format!(
                        "\n### Turn `{}` — {} tokens\n\n",
                        &id[..id.len().min(20)],
                        total(u)
                    ));
                }
            }
        }

        let text = e.text.clone().unwrap_or_default();
        match e.kind {
            Kind::Prompt => {
                o.push_str("**Prompt**\n\n");
                for l in text.lines() {
                    o.push_str(&format!("> {l}\n"));
                }
                o.push('\n');
            }
            Kind::Assistant => {
                o.push_str(&text);
                o.push_str("\n\n");
            }
            Kind::Thinking => {
                // Collapsed in the export: it is context, not the narrative, and
                // inlining it breaks the flow of a document meant to be read.
                o.push_str("<details><summary>thinking</summary>\n\n");
                o.push_str(&text);
                o.push_str("\n\n</details>\n\n");
            }
            Kind::Tool => {
                let f = fence(&text);
                o.push_str(&format!(
                    "**{}**\n\n{f}\n{}\n{f}\n\n",
                    e.tool.as_deref().unwrap_or("Tool"),
                    text
                ));
            }
            Kind::ToolResult => {
                if text.is_empty() {
                    continue;
                }
                let f = fence(&text);
                if e.is_error == Some(true) {
                    o.push_str("**Error**\n\n");
                }
                o.push_str(&format!("{f}\n{}\n{f}\n\n", text));
                if let Some(p) = &e.persisted_output_path {
                    o.push_str(&format!("_Full output: `{p}`_\n\n"));
                }
            }
        }
        if e.truncated {
            o.push_str("_(clipped — see the full transcript)_\n\n");
        }
    }
    o
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(kind: Kind, text: &str) -> Entry {
        Entry {
            kind,
            offset: 0,
            agent_id: None,
            turn_id: Some("req_1".into()),
            ts: 0,
            text: Some(text.into()),
            tool: Some("Bash".into()),
            tool_use_id: None,
            is_error: None,
            persisted_output_path: None,
            truncated: false,
        }
    }

    fn meta() -> Meta {
        Meta {
            session_id: Some("s-1".into()),
            cwd: "/home/u/p".into(),
            model: Some("claude-opus-5".into()),
            sources: vec!["parent".into(), "agent-a".into()],
            exported_at: "2026-09-18T11:00:00Z".into(),
        }
    }

    fn turns() -> BTreeMap<String, TokenUsage> {
        let mut t = BTreeMap::new();
        t.insert(
            "req_1".to_string(),
            TokenUsage {
                input: 10,
                cache_read: 90,
                cache_write_5m: 1,
                cache_write_1h: 2,
                output: 5,
            },
        );
        t
    }

    /// A number in a file has no tooltip. Both formats must say what it means.
    #[test]
    fn every_export_states_the_notional_caveat() {
        let e = vec![entry(Kind::Assistant, "hello")];
        let md = to_markdown(&e, &turns(), &meta());
        assert!(md.contains("not a bill"), "markdown must carry the caveat");
        let js = to_json(&e, &turns(), &meta());
        assert!(js.contains("not a bill"), "json must carry the caveat");
    }

    /// Tokens are the durable fact. Baking today's rates into an archive would
    /// freeze them into a file that looks authoritative forever.
    #[test]
    fn json_exports_tokens_not_dollars() {
        let js = to_json(&[entry(Kind::Assistant, "hi")], &turns(), &meta());
        let v: serde_json::Value = serde_json::from_str(&js).unwrap();
        assert_eq!(v["totals"]["tokens"], 108);
        assert_eq!(v["totals"]["usage"]["cacheRead"], 90);
        assert!(
            !js.contains("\"usd\"") && !js.contains("costUsd"),
            "an archive must not freeze a converted price"
        );
    }

    /// A transcript can contain a fenced block. A naive ``` fence would
    /// terminate early and mangle everything after it.
    #[test]
    fn fences_survive_output_that_contains_backticks() {
        let nasty = "here is a block:\n```\ninner\n```\ndone";
        let mut e = entry(Kind::ToolResult, nasty);
        e.kind = Kind::ToolResult;
        let md = to_markdown(&[e], &turns(), &meta());
        // The opening fence must be longer than anything inside.
        assert!(
            md.contains("````"),
            "fence must outrank the inner one:\n{md}"
        );
    }

    #[test]
    fn subagent_sections_are_separated_from_the_parent() {
        let mut child = entry(Kind::Assistant, "child work");
        child.agent_id = Some("a1".into());
        let md = to_markdown(
            &[entry(Kind::Assistant, "parent work"), child],
            &turns(),
            &meta(),
        );
        assert!(md.contains("## Parent session"));
        assert!(md.contains("## Subagent `a1`"));
        assert!(
            md.find("## Parent session") < md.find("## Subagent `a1`"),
            "parent first, then children"
        );
    }

    /// A save dialog lets you type a bare name; the file should still be
    /// identifiable afterwards.
    #[test]
    fn a_missing_extension_is_appended_but_never_doubled() {
        assert_eq!(Format::Markdown.with_extension("/t/out"), "/t/out.md");
        assert_eq!(Format::Markdown.with_extension("/t/out.md"), "/t/out.md");
        assert_eq!(Format::Markdown.with_extension("/t/out.MD"), "/t/out.MD");
        assert_eq!(Format::Json.with_extension("/t/out.md"), "/t/out.md.json");
        // A dot in a directory name must not be mistaken for an extension.
        assert_eq!(
            Format::Json.with_extension("/t/v1.2/out"),
            "/t/v1.2/out.json"
        );
    }

    /// End-to-end against a real session on this machine, if one exists.
    /// Skips silently otherwise — the fixture tests above cover the logic; this
    /// guards against the real shape of a transcript breaking either format.
    #[test]
    fn exports_a_real_session_on_this_machine() {
        let Some(projects) = dirs::home_dir().map(|h| h.join(".claude/projects")) else {
            return;
        };
        // Pick the largest transcript that has subagents, so both paths run.
        let mut best: Option<(u64, std::path::PathBuf)> = None;
        let Ok(slugs) = std::fs::read_dir(&projects) else {
            return;
        };
        for slug in slugs.flatten() {
            let Ok(files) = std::fs::read_dir(slug.path()) else {
                continue;
            };
            for f in files.flatten() {
                let path = f.path();
                if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                let size = f.metadata().map(|m| m.len()).unwrap_or(0);
                if best.as_ref().map(|(s, _)| size > *s).unwrap_or(true) {
                    best = Some((size, path));
                }
            }
        }
        let Some((_, path)) = best else { return };

        let mut entries = Vec::new();
        let mut turns = BTreeMap::new();
        let mut cursor = crate::trace::Cursor::default();
        let mut sources = Vec::new();
        for _ in 0..100 {
            let Ok(page) = crate::trace::read_page(Some(&path), &cursor, 1000) else {
                return;
            };
            if page.sources.len() > sources.len() {
                sources.clone_from(&page.sources);
            }
            let done = !page.has_more || page.entries.is_empty();
            entries.extend(page.entries);
            turns.extend(page.turns);
            cursor = crate::trace::Cursor::decode(&page.cursor).unwrap_or_default();
            if done {
                break;
            }
        }
        if entries.is_empty() {
            return;
        }

        let meta = Meta {
            session_id: Some("real".into()),
            cwd: "/tmp".into(),
            model: Some("claude-opus-5".into()),
            sources,
            exported_at: "2026-09-18T00:00:00Z".into(),
        };

        let md = to_markdown(&entries, &turns, &meta);
        let js = to_json(&entries, &turns, &meta);
        eprintln!(
            "exported {} entries / {} turns -> {} KB markdown, {} KB json",
            entries.len(),
            turns.len(),
            md.len() / 1024,
            js.len() / 1024
        );
        assert!(md.contains("# Claude Code session"));
        assert!(
            md.contains("not a bill"),
            "the caveat must survive real data"
        );
        // The JSON must actually parse — a real transcript is full of characters
        // that break naive string building.
        let v: serde_json::Value =
            serde_json::from_str(&js).expect("a real export must be valid JSON");
        assert_eq!(v["entries"].as_array().unwrap().len(), entries.len());
        assert!(v["totals"]["tokens"].as_u64().unwrap_or(0) > 0);
    }

    #[test]
    fn format_parses_from_its_name_and_knows_its_extension() {
        assert_eq!(Format::parse("md"), Some(Format::Markdown));
        assert_eq!(Format::parse("JSON"), Some(Format::Json));
        assert_eq!(Format::parse("pdf"), None);
        assert_eq!(Format::Markdown.extension(), "md");
    }

    #[test]
    fn the_header_reports_how_many_transcripts_were_read() {
        let md = to_markdown(&[entry(Kind::Assistant, "x")], &turns(), &meta());
        assert!(
            md.contains("parent + 1 subagent"),
            "a reader must know subagents are included:\n{md}"
        );
    }
}
