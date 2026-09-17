# Research #12 — Is there any source for live, in-progress tool output?

**Verdict: NO for foreground tools. The achievable tier is C, with two upgrades worth naming.
The destination needs redrawing.**

Environment: Claude Code **v2.1.270**, Linux (arch 7.2.3), 2026-09-18. All results below are from
captured runs in this directory; nothing here is quoted from documentation.

---

## Summary table

| Channel | In-progress tool output? | Evidence |
|---|---|---|
| `--output-format stream-json --include-partial-messages` | **No.** 7.0s of total silence between `task_started` and the completed `tool_result` | `e1_partial.log` |
| Interactive PTY (Ink TUI) | **Counters only** (elapsed / line count / KB). A 4-line rolling content tail appeared in **1 of 5** runs | `e2/e3/e8/e9/e14_pty.frames` |
| Hooks | **No mid-tool hook exists.** 11 event names in the binary, none fires during a tool | binary strings |
| OTel | **No.** `tool_decision` at start, `tool_result` at end, **sizes only, no content** | `e7_otel.log` |
| Transcript JSONL | **No** in-progress output — but writes land **≤0.25s** after each event | `e6_jsonl.log` |
| **Backgrounded tasks only** | **YES — grows line-by-line in real time** | `e5_growth.log` |

---

## Q1 — Does `stream-json` emit anything incremental for a *running* tool call?

**No.** `claude -p --output-format stream-json --include-partial-messages --verbose`, running a
Bash loop that printed one line per second for 10s (`e1_partial.log`):

```
[   8.596] {"type":"system","subtype":"task_started","task_id":"bflzjzds7",
           "tool_use_id":"toolu_01AhZ...","is_backgrounded":false,"task_type":"local_bash",...}
                        <-- 7.04 seconds of absolute silence; 10 lines printed in here -->
[  15.632] {"type":"system","subtype":"task_notification","task_id":"bflzjzds7",
           "status":"completed","output_file":"",...}
[  15.654] {"type":"user","message":{...{"tool_use_id":"toolu_01AhZ...","type":"tool_result",
           "content":"TICKLINE-1\nTICKLINE-2\n...TICKLINE-10"}}}
```

Not one event in the 7-second window. The result arrives whole, 22ms after the completion
notification.

**What `--include-partial-messages` *does* give** (and this is genuinely useful, just not for
output): token-level `text_delta` for assistant prose, and `input_json_delta` for a tool's
**input** as the model types it — you can watch a Bash command being composed character by
character *before* it runs. Also `thinking_delta`. Live **input**, never live **output**.

## Q2 — Is `stream-json` usable at all here? **No. Mutually exclusive, verified both directions.**

- **Non-TTY:** `claude --output-format stream-json --verbose` (no `-p`) →
  `Error: Input must be provided either through stdin or as a prompt argument when using --print`.
  The flag *implies* `--print`.
- **Inside a PTY:** the same flag is **silently ignored** — the full Ink TUI boots
  (`Claude Code v2.1.270` splash captured). No JSON is emitted at all.

`--help` confirms the design: `--output-format`, `--include-partial-messages`,
`--include-hook-events`, `--forward-subagent-text` are all documented "only works with `--print`".

A second `claude` process as a side-channel is not an option either: it would start its own turn,
and two processes on one conversation corrupt the transcript — `pty.rs` already guards against
exactly that (`registry.has_session_id`).

## Q3 — What does the PTY actually carry while a long Bash command runs?

Five captures at 120x34 with `TERM=xterm-256color`, matching `spawn_in_pty`:

| run | command | live content in PTY? | live counter? | render at completion |
|---|---|---|---|---|
| e2 | 12 lines / 12s | none | `(3s · 4 lines)`, `(10s · 11 lines)` | `Ran 1 shell command` — **no output at all** |
| e3 | 30 lines / 12s, `--verbose` | none | none | full tail, at completion only |
| e8 | 2000 lines / 20s | **yes — 4-line rolling tail from T+3.2s** | `1021 lines`, `57.5KB` | 3 lines + `… +508 lines (ctrl+o to expand)` |
| e9 | 4000 lines / 28s | none | `(10s · 1502 lines)` | — |
| e14 | 3000 lines / 20s, clean env | none | `(3s · 457 lines)` | — |

So a live content tail is **possible but not dependable** — 1 of 5 runs, with no way for the app to
know which case it is in.

**And when it does appear, it is unparseable without a terminal emulator.** The first paint is
whole; every update after it is a differential *character* patch. From `e8_pty.frames`:

```
T=13.231 n=2321  ...NOISE-297-xxxx...|NOISE-298-xxxx...|NOISE-299-xxxx...|NOISE-300-xxxx...
T=14.219 n=152   |3||3||3||4||4|7|4|22|9|         <- overwrites only the changed DIGITS
T=15.220 n=151   |4||4||4||5||5|9|5|8|7|
T=20.221 n=211   |9||9||9||1|0-|x||1021 lines| |(10s · timeout 5m)| |57.5KB|
```

Because consecutive lines share the `NOISE-` prefix and `-xxxx` suffix, Ink emits only the digits
that changed, cursor-addressed. Recovering the string `NOISE-1403` from a 152-byte frame requires
maintaining the full screen model. There is no delimiter, no per-tool framing, no `tool_use_id`
anywhere in the byte stream.

**The frontend already has that screen model** (xterm.js), and the app already scrapes it
(`Terminal.tsx: detectDialog`). So scraping is *possible*. Note what that costs: `detectDialog`'s
doc comment is pinned to a sample capture from *"Claude Code v2.1.220"*, and its heuristics are
caret glyphs and line positions. A trace built on region-scraping inherits that, per tool card.

**Correction to README.** The README's "hooks, SDK, stream-json, transcripts, OTel emit only after
a command finishes" is **confirmed**. But the implicit contrast — that the PTY makes up for it —
does not hold: the PTY does not reliably carry live tool output either. In run e2 the terminal
**never showed the command's output at all**, before or after.

## Q4 — Is there a fourth option?

**Hooks — no.** `strings` over the 224MB binary yields exactly these lifecycle names:
`PreToolUse, PostToolUse, SessionStart, SessionEnd, UserPromptSubmit, Notification, Stop,
SubagentStop, SubagentStart, PreCompact, PostCompact`. Nothing mid-tool.

**OTel — no, and worse than the transcript.** With
`CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_LOGS_EXPORTER=console` (`e7_otel.log`):
`claude_code.tool_decision` at T+9.4, `claude_code.tool_result` at T+17.6, nothing between. The
`tool_result` event carries `tool_result_size_bytes: "63"` — **the size, never the content**
(`grep -c OTICK e7_otel.log` = 0). `traceId: undefined` — no spans. Batched export adds latency.

**Backgrounded tasks — YES, a genuine live source.** A Bash call with `run_in_background=true`
writes to `/tmp/claude-<uid>/<cwd-slug>/<session-id>/tasks/<task_id>.output`, and that file
**grows line by line in real time** (`e5_growth.log`, 0.5s polling):

```
1789670207.512 b58zkcta1.output size=11  lines=1  last=GROWTICK-1
1789670208.545 b58zkcta1.output size=22  lines=2  last=GROWTICK-2
...
1789670217.383 b58zkcta1.output size=123 lines=11 last=GROWTICK-11
1789670217.902 b58zkcta1.output size=133 lines=13 last=[killed]
```

Caveats: only for backgrounded tasks (the TUI's `ctrl+b ctrl+b`, or the model setting the flag);
**foreground tasks create the `tasks/` directory and leave it empty** (verified). The app owns the
PTY and *could* inject `ctrl+b ctrl+b` to force backgrounding — but that changes the session's
semantics (the model gets "task running in background" and must poll `BashOutput`), so it is an
opt-in trick, not a default.

**Full-output spill files — a real find, for completeness not liveness.** Large tool results are
persisted whole to `~/.claude/projects/<slug>/<session-id>/tool-results/<task_id>.txt`, and the
transcript hands you the path explicitly (`e14_transcript_toolresult.json`):

```json
"toolUseResult": {
  "stdout": "<30000 chars, hard cap — 684 of 3000 lines>",
  "persistedOutputPath": ".../e4a85895-.../tool-results/b4xp6ttdb.txt",
  "persistedOutputSize": 133893
}
```
and the `tool_result` the model sees is only 2223 chars: `<persisted-output> Output too large
(130.8KB). Full output saved to: ... Preview (first 2KB): ...`.

Written **atomically at completion**, never incrementally — polled at 0.5s across a 28s run and
the file appeared exactly once, already complete at 206893 bytes / 4000 lines (`e9_tr.log`).
So: no liveness, but the panel can show **more than the terminal does** (terminal: 3 lines +
"ctrl+o to expand"; panel: the whole 133KB).

**Transcript write latency — the 1.5s is ours, not Claude Code's.** Measured by tailing the JSONL
at 0.2s and comparing each record's own timestamp to the moment it hit disk (`e6_jsonl.log`):

| record | record timestamp | on disk | lag |
|---|---|---|---|
| `assistant … tool_use:Bash` | 18:37:31.376 | 1789670251.511 | **0.135s** |
| `user … tool_result` | 18:37:41.603 | 1789670261.847 | **0.244s** |

`pty.rs:428`'s `sleep(1500ms)` is claude-view's own choice. Sub-300ms event liveness is available
today for the cost of a shorter interval or an inotify watch.

---

## Verdict: tier C (upgraded). Not A. Not B.

- **A — fully live, all entries: impossible.** No channel carries in-progress output for a
  foreground tool. Not stream-json, not hooks, not OTel, not the transcript, and not dependably the
  PTY.
- **B — live for the in-flight entry only: not achievable for output *text*.** What *is* achievable
  for the in-flight entry is progress **metadata**: a live elapsed timer (free — compute it
  client-side from the `tool_use` record's timestamp) and, only by scraping the xterm.js screen, a
  line count and byte count. Live output text for the in-flight entry exists solely in the
  background-task file, i.e. only for commands someone chose to background.
- **C — per-event: recommended, and better than the ticket assumes.** Sub-second, not 1.5s; and
  *more complete* than the terminal, because `persistedOutputPath` yields output the TUI truncates
  away.

### Recommended mechanism

1. **Start of a tool call** — `PreToolUse` hook (instant, already wired) and/or the transcript's
   `assistant … tool_use` record (~0.14s). Gives tool name and **full input** immediately.
2. **While it runs** — show tool + full input + status + a **client-side elapsed timer**. No source
   needed; nothing else is honestly available.
3. **Completion** — `PostToolUse` hook / transcript `tool_result` (~0.24s). For output, prefer in
   order: `toolUseResult.persistedOutputPath` (read the file — full output), else
   `toolUseResult.stdout` (≤30000 chars), else the `tool_result` content block.
4. **Optional, opt-in** — for tasks the user backgrounds, tail
   `/tmp/claude-<uid>/<slug>/<sid>/tasks/<id>.output` for genuine live output.
5. Drop `pty.rs`'s 1500ms to ~200ms or move to inotify.

### Fragility, and how loudly it breaks

| Dependency | Breaks when | How loudly |
|---|---|---|
| `PreToolUse`/`PostToolUse` hooks | event renamed/removed | **Loud** — documented, user-visible config; timeline goes empty and the Install button is the obvious suspect |
| Transcript JSONL shape (`message.content[].tool_use`) | internal format change | Medium — already a shipped dependency; a schema change empties the timeline |
| `toolUseResult.persistedOutputPath` / `.stdout` | field renamed | **SILENT** — output silently truncates to 30k or the block vanishes. *Mitigate:* assert the field exists on first tool result and surface a visible warning; fall back to parsing the `<persisted-output>` marker in the `tool_result` text |
| Screen-region scraping for line counts | **any TUI restyle** | **SILENT** — this is why the trace should not depend on it. `detectDialog` is already pinned to a v2.1.220 capture |
| Background-task file path | path scheme change | Loud-ish if opt-in and absent → just no live output |

**Claude Code updates itself.** `Update available! Run: mise upgrade claude` appeared *inside* a
capture. Version bumps arrive without user intent, so anything shape-dependent breaks unannounced.
Prefer named fields (`persistedOutputPath`) over derived paths, and derived paths over screen
geometry.

## Skepticism / threats to validity

- **Env confound, found and corrected.** Nested `claude` processes inherit `CLAUDECODE=1`,
  `CLAUDE_CODE_CHILD_SESSION`, etc. Under that env an interactive session writes **no transcript at
  all** — I nearly reported that as a finding. With the vars scrubbed the transcript appears
  normally within seconds (`exittest.py` vs `exittest2.py`). Every load-bearing claim was either
  re-run with a scrubbed env (e14) or is independent of it (file observations, stream-json, OTel).
- The PTY tail appeared in 1/5 runs; I cannot state the trigger. That uncertainty is itself the
  argument against depending on it.
- Only `Bash` was exercised. Read/Edit/Grep produce output instantaneously, so the liveness
  question does not arise for them; `Task` (subagents) was not tested and is a separate ticket.
- All runs used `--model haiku` for cost. Model choice does not touch the tool-execution or
  rendering paths.
- Single machine, single CLI version, Linux only.
