# When an agent run becomes discoverable

Research for [#21](https://github.com/Quantum-vik/claude-view/issues/21) (map [#19](https://github.com/Quantum-vik/claude-view/issues/19)).

**The question.** When does an agent run become discoverable, and what does its record look
like while it is still running?

**The answer, in one line.** A run is discoverable **~123 ms after the model emits the task
call** — fully labelled, before the parent transcript has even admitted the call happened, and
**~2.1 s before the run says anything at all**. A spawned-but-silent run can be shown, named,
and typed. There is no unlabelled-flicker state.

---

## How this was measured

Five real Claude Code sessions were spawned into throwaway `/tmp` working directories and
watched while they ran. Nothing here is inferred from finished files.

| | |
|---|---|
| Claude Code | 2.1.270 |
| Sessions | 5 (3 via `claude -p`, 2 driven through a real PTY — the way `pty.rs` launches one) |
| Agent runs observed live | 13 |
| Watcher | Python busy-loop: `listdir` + `stat` + tail-read of every file, no sleep |
| Sampling rate | 23,094–29,467 polls/s (**34–43 µs** between samples); 15.7M samples over runs 2–5 |
| Filesystem | btrfs, `~/.claude/projects` on the same volume as `$HOME` |
| Corpus cross-check | every transcript already on this machine: 13,403 records across 67 files |

Harness: `poll2.py` (directory watcher), `ptyrun.py` (PTY driver), `run2.sh` (`-p` driver).
Kept out of the repo deliberately — it is throwaway scaffolding, and the numbers below are what
survives.

> **Trap worth writing down.** `CLAUDE_CODE_CHILD_SESSION` is inherited by child processes and
> **disables transcript writing entirely**. Launching `claude` from inside an agent session
> without `env -u CLAUDE_CODE_CHILD_SESSION` produces a session that writes no transcript at
> all, which looks exactly like "discovery is broken".

---

## 1. Order of appearance — the sidecar always wins

**The `.meta.json` is on disk before the `.jsonl`, in 13 runs out of 13.**

| | min | median | max |
|---|---|---|---|
| `.meta.json` visible → `.jsonl` visible | **19.9 ms** | **75.4 ms** | **102.1 ms** |

n = 13. Never once the other way round, and never once simultaneous at 34 µs resolution.

Better than that: the sidecar is written **atomically**. The watcher caught the intermediate
`agent-<id>.meta.json.tmp.<8 hex>` file in 7 of 13 spawns, already holding the *complete* JSON
body, renamed into place within ~1 ms. A half-written sidecar is not merely unlikely — the
write-then-rename means it cannot be observed at all. Every one of the 13 sidecars parsed as
valid JSON on its very first read, and every one already carried `agentType`, `description`,
`toolUseId` and `spawnDepth`.

The sidecar is also written **exactly once**. Across runs 2–5 the watcher saw one and only one
`meta.json` content-change event per agent — it is never revised mid-run, so a row's name and
type never change under the user.

**Consequence for the UI: the unlabelled-flicker state does not exist.** `subagents_for()` keys
discovery off the `.jsonl`; by the time that file exists, its sidecar has been complete and
readable for 20–102 ms. A row can never render as `» subagent a1705fdcf7a8` for want of a
sidecar that has not arrived yet.

> The doc comment on `read_meta()` in `src-tauri/src/transcript.rs` currently says the sidecar
> lands "~33ms before the child's first transcript line". **The direction is right; the
> magnitude is low.** Measured median is 75.4 ms, range 19.9–102.1 ms.

### The one window that does exist, and it is 0.1 ms wide

In 5 of 13 spawns the watcher caught `agent-<id>.jsonl` **existing at zero bytes**. Its first
line then landed within:

`0.077 ms · 0.080 ms · 0.084 ms · 0.094 ms · 0.135 ms` (n = 5)

In each case one 33–37 KB write took the file from 0 bytes to its first eight complete records
in a single step (traces: `[[0.0, 0], [3.4e-05, 33388]]`).

During that sub-millisecond window `is_this_sessions_child()` reads an empty first line,
`serde_json::from_str("")` fails, and the function returns `false` — the run is **silently
dropped from that one poll** and appears on the next. That is the correct, safe outcome, and at
any realistic poll cadence the odds of landing in a 0.1 ms window are negligible. It is worth
knowing it is there, and worth *not* "fixing" it into something that admits a typeless run.

---

## 2. Timing against the parent's task call — the run beats its own tool call to disk

Reference points: `TU-ts` is the `timestamp` *inside* the parent's `tool_use` record (when the
model emitted the call); `TU-line` is when that record actually became readable on disk.

| measured | min | median | max |
|---|---|---|---|
| TU-ts → `.meta.json` on disk | 23.1 ms | **47.7 ms** | 105.5 ms |
| TU-ts → `.jsonl` on disk (**run discoverable**) | 111.4 ms | **123.1 ms** | 162.1 ms |
| child's own first-record `timestamp` → `.jsonl` on disk | 109.4 ms | 118.1 ms | 145.1 ms |
| **`.jsonl` on disk → parent's TU-line on disk** | **0.9 ms** | **747.0 ms** | **2147.0 ms** |

n = 13 for each row.

**The subagent record is on disk before the parent's `tool_use` line is, in 13 runs out of 13** —
by between 0.9 ms and 2.15 s. The parent transcript does not write per-record: it flushes a
whole assistant turn at once. In run 1, three `Agent` calls stamped one second apart
(`09:06:19.733`, `:20.723`, `:21.720`) all became readable in the *same* 34 µs sample, 2.1 s
after the first one was emitted. The children were already there.

So discovery must not wait on the parent. **A run that has been spawned but has produced nothing
is discoverable, and fully labelled.** The child `.jsonl` opens with 8 records written at spawn —
the run's *prompt* plus attachment records — none of which is output.

| measured | min | median | max |
|---|---|---|---|
| `.jsonl` on disk → run's **first `assistant` record** | 1,411 ms | **2,087 ms** | 3,911 ms |

n = 13; it was record **#9** in every single run.

That is the gap the section exists to fill: **~2.1 s of "spawned, named, silent"** on every run,
and much longer if the first thing it does is slow. Blind until it speaks would mean blind for
two seconds minimum.

---

## 3. Mid-run shape — a torn line is real, and it can never parse

### Yes, a read can catch a torn line

One was caught (run 3, parent transcript): a **46,701-byte fragment with no trailing newline**,
mid-write. So the writer's `write()` is **not** shielded from a concurrent reader, and "every
read sees whole lines" is false. It is merely very rare: **1 torn observation in 15.7M samples**
at 34 µs resolution.

### No, it can never parse as valid-but-partial

This is the part that matters, and it holds three ways:

1. **Structural.** Every one of the 13,403 records on this machine begins with `{`. A strict
   prefix of a serialized JSON *object* is never itself a valid JSON document — the closing `}`
   is missing.
2. **Brute-forced, Python.** 85,720 prefixes of 40 randomly sampled real records: **0** parse.
3. **Brute-forced, Rust / `serde_json`** — the parser claude-view actually uses: every prefix of
   a real 525-byte record, **0** parse. `serde_json::from_str::<Value>("{\"a\":1}xx")` is also
   `Err`, so trailing garbage after a complete object is rejected too.

The one theoretical escape — a truncated bare number, `12345` → `123`, which *is* valid JSON —
cannot occur, because no record is a bare number. And even if one did, `parse_line`/`parse_record`
index `v["type"]` on it, get `null`, and emit nothing.

### claude-view never even offers it to the parser

Both readers already refuse an unterminated line and re-read it next poll:

- `transcript.rs::read_new()` — *"Only advance the durable offset past COMPLETE lines, so a
  half-flushed final line is re-read next poll."*
- `trace.rs::read_file()` — same rule, same comment.

That guard is correct and load-bearing. **Do not relax it**, and any new reader on this path must
copy it.

### `\n` is a trustworthy delimiter

A torn read cannot be mistaken for a complete one, because a record can never contain a raw
newline: JSON escapes them as `\n` (two characters). Corpus check over every transcript on this
machine — subagent and parent — **13,403 records, 0 unparseable lines, 0 files missing a trailing
newline**. Newline count equals record count everywhere.

### Nothing truncates, nothing rewrites

Across all five runs the child `.jsonl` only ever grew. No `.jsonl.tmp.*` ever appeared (the
tmp-and-rename dance is the sidecar's alone), so the file is never swapped under a reader and the
inode is stable. `read_file()`'s `start > len` reset never fired.

### Even a killed run leaves a clean file

Three transcripts from an earlier experiment on this machine, of agents killed with SIGINT,
SIGTERM and SIGKILL (`-tmp-rt-exp-kill{int,term,kill}`, same 2.1.270): **all three end on a
complete, parseable line with a trailing newline.** A crash does not leave a torn tail behind on
disk; the torn state is transient, not durable.

---

## 4. Cadence — live enough to say "running", with a caveat

| measured | value |
|---|---|
| task call emitted → run discoverable | **123 ms** median, 162 ms worst (n = 13) |
| run discoverable → first output | **2,087 ms** median, 3,911 ms worst (n = 13) |
| median gap between consecutive records inside a live run | **0.00 s** — records land in bursts |
| max gap inside a live run | **2.0 s – 30.2 s** depending on what the run was doing (n = 13) |

The 123 ms figure is comparable to map #11's parent-transcript measurements (0.135 s for
`tool_use`, 0.244 s for `tool_result`). **Discovery is genuinely live** — well inside a frame of
human perception.

**Progress is not.** Records arrive in bursts separated by whatever the run is doing. A run
whose first action is `sleep 30` wrote its `tool_use` record and then **nothing for 30.22 s**
(run 3, measured) before the matching `tool_result`. The maximum silence of a healthy run is
unbounded: it is the duration of its longest tool call.

So the honest claim a row can make is **"running, last activity <n> ago"**. "Running" alone
invites the reader to believe something is happening *now*; the last-record timestamp is the only
honest liveness signal, and for a long tool call it will look stale while everything is fine.

---

## Adjacent finding: there is no completion marker in the run's own file

Worth recording because it constrains what the row can say, and it bears on #23.

A finished run's last record is `type: assistant`, `stop_reason: end_turn`, one `text` block.
A run **killed with SIGINT** ends exactly the same way. Runs killed with SIGTERM/SIGKILL end on
`thinking` or `tool_use` blocks. **Nothing in the child transcript says "done".** Reading the
`.jsonl` alone cannot separate running from finished from dead.

The completion signal lives in the **parent** transcript, as a `type: user` record whose text is:

```
<task-notification>
<task-id>a283fb610ea790077</task-id>
<tool-use-id>toolu_018D1yXpDNy52Qkf4KXFdDyj</tool-use-id>
<status>completed</status>
<summary>Agent "v two" finished</summary>
```

`task-id` is the agent id; `tool-use-id` is the sidecar's `toolUseId`. It landed within ~1 ms of
the run's own final record. For background runs this is the **only** completion signal — the
`tool_result` for the task call returns immediately at spawn with "Async agent launched
successfully", so it says nothing about whether the run finished.

## Adjacent finding: `run_in_background: false` is not honoured in 2.1.270

In run 2 the model passed `run_in_background: false` on two of three `Agent` calls. All three
sidecars recorded `requestShape: "background"` and all three tool_results said "Async agent
launched successfully". Three `foreground`-shaped sidecars do exist on this machine from an
earlier 2.1.270 experiment, so the foreground path is reachable — but **background is what this
version actually does by default**, and it is the shape all 13 live observations here cover. The
existing sidecar corpus is 21 background / 3 foreground.

---

## What the implementer must guard against

1. **Do not wait for the parent's `tool_use` line before showing a run.** It arrives after the
   run's own record — by up to 2.15 s. Discovery reads `subagents/`; linkage to the task call
   catches up on its own.
2. **Do not relax the complete-line rule** in `read_new()` / `read_file()`. Torn reads happen
   (1 in 15.7M samples, 46 KB fragment). They are always invalid JSON, but only because nothing
   hands the fragment to the parser in the first place. Any new reader on this path must break on
   a line lacking `\n`.
3. **Tolerate a run vanishing for exactly one poll.** The 0.077–0.135 ms empty-`.jsonl` window
   makes `is_this_sessions_child()` return `false` for one tick. A row should not be torn down and
   rebuilt on a single missed poll; treat a run's absence as provisional for at least one cycle.
4. **Never render a typeless run as a normal row.** The sidecar leads the `.jsonl` by 20–102 ms,
   so a missing sidecar means something genuinely wrong — not a race. The hex-id fallback should
   stay the rare exception it was designed to be, not a state the UI passes through.
5. **Say "last activity", not "running".** Silence of 30 s inside a healthy run is normal and
   measured. Liveness must be expressed against the last record's timestamp.
6. **Read completion from the parent's `<task-notification>`, not from the child's last record.**
   A killed run and a finished run look identical in the child file.
7. **Ignore `agent-<id>.meta.json.tmp.<hex>`.** `subagents_for()` already skips it (its extension
   is the random hex, not `jsonl`), but the name contains `meta.json`, so any future glob must not
   be written as `*meta.json*`.

---

## Measured / read / inferred

**Measured** (all numbers above): order of appearance, all latencies, the empty-`.jsonl` window,
the torn read, cadence and silence, sidecar atomicity and write-once behaviour, `run_in_background`
being overridden, the shape of `<task-notification>`, killed-run tail integrity.

**Read from source**: the complete-line guards in `read_new()` and `read_file()`; the extension
filter and `is_this_sessions_child()` gate in `subagents_for()`; `serde_json` prefix and
trailing-garbage behaviour, verified by running it rather than trusting it.

**Inferred**: that the 1-in-15.7M torn-read rate generalises from the parent transcript to
subagent files. No torn read was caught on a subagent file, but they are written by the same
writer, and a stress run with 33 KB+ records did not change the outcome either way. Treat torn
subagent reads as possible; the guard is identical regardless.

**Not established**: syscall-level proof of how many `write()` calls a record costs.
`LD_PRELOAD` interception was built and verified against Python, but produced nothing for
`claude` — the binary appears to issue file I/O without going through libc's `write`. No
`strace`, `perf`, `ltrace` or `bpftrace` on this machine. The observed 46 KB torn fragment is
the direct evidence that writes are not atomic against readers, and it is sufficient for the
decision at hand.
