# How an agent run ends — and whether failure is distinguishable from success

Research for [#20](https://github.com/Quantum-vik/claude-view/issues/20) (map [#19](https://github.com/Quantum-vik/claude-view/issues/19)).
Measured against Claude Code **2.1.270** on this machine, 2026-09-18.

Every claim below is tagged:

- **MEASURED** — observed in a transcript on this machine, path given.
- **READ** — read out of a primary source: the shipped `claude` binary's own embedded
  schemas/system prompt, or `code.claude.com` docs. Quoted.
- **INFERRED** — reasoning from the two above. Called out as such, never asserted.

---

## Verdict

**A dead run is *not* reliably distinguishable from a live one by the transcripts alone.**

There are three *terminal* signals, and when one of them is present it is decisive — it tells
you not only that the run ended but *how*. But a run can end with **none of them written**,
because the process that would have written them is gone. In that state the record of a run
killed an hour ago is byte-identical to the record of a run that is mid-tool-call right now.

So the status model needs **two layers**:

1. A **truth** layer — the terminal signals (§3). When present, they are exact.
2. A **liveness** layer — one out-of-band check (§6). Not staleness-by-timestamp: an actual
   liveness oracle exists, and claude-view is unusually well placed to use it, because it
   **launches the session process itself and therefore owns its PID**.

The staleness heuristic the ticket feared is *not* required. A timestamp heuristic would be
strictly worse than the PID check and should not be built.

The ticket's stated premise — *"the parent holds a matching `tool_result`"* is the success
marker — **is wrong for every one of the 18 pre-existing agent runs on this machine.** See §1; this is the single
most important finding here.

---

## 1. The trap that invalidates the premise: two completely different task-call contracts

A task call is either **foreground** (blocking) or **background** (async). The sidecar records
which, in a field the panel does not read today:

```json
{"agentType":"general-purpose","description":"long sleeper",
 "toolUseId":"toolu_01JdPtF1nQB4Artu5uURLp2L","spawnDepth":1,
 "requestShape":"foreground","requestNonInteractive":true}
```

**MEASURED** — `requestShape` is `"foreground"` or `"background"`, and the two shapes give the
task call's `tool_result` **opposite meanings**:

| shape | parent's `tool_result` for the task call | when it is written |
| --- | --- | --- |
| `foreground` | the run's **final output** (or its error) | when the run **ends** |
| `background` | `"Async agent launched successfully…"` | **milliseconds after launch** |

The async acknowledgement in full (parent transcript, `-tmp-rt-exp-esc4`):

```
Async agent launched successfully. (This tool result is internal metadata — never quote or
paste any part of it, including the agentId below, into a user-facing reply.)
agentId: a76fef8de717e588b (internal ID …  Use SendMessage with to: 'a76fef8de717e588b' … )
The agent is working in the background. You will be notified …
```

**MEASURED — survey of every subagent record written by a real session on this machine (18 runs
across the two everyday project directories): `requestShape` is `"background"` for all 18, and
every one of those 18 parent `tool_result`s is the async acknowledgement.** The only `foreground`
runs in existence here are five I manufactured today via `claude -p`. (Runs under `-tmp-rd21-*`
belong to another agent's concurrent experiments and are excluded from every count here.)

Two further measurements pin down why:

- **In the interactive TUI of 2.1.270 the `Agent` tool has no `run_in_background` parameter at
  all.** Told three times, in three separate pty-driven interactive sessions, to pass
  `run_in_background: false`, the model could not: the field never appears in the logged
  `tool_use.input`, and in `-tmp-rt-exp-esc6` the model says so itself —
  *"the `run_in_background: false` field isn't part of this tool's schema, so the agent launched
  in the background regardless"*. **Every run spawned from an interactive session is async.**
- In `claude -p` (SDK/print entrypoint) the parameter *does* exist and `false` does block
  (`-tmp-rt-exp-killint`, `-tmp-rt-exp-maxtok`, `-tmp-rt-exp-failfg`).

**INFERRED, and load-bearing:** claude-view renders *interactive* sessions. For its entire
corpus, **the presence of a `tool_result` on a task call carries no information about the run
at all.** Reading it as "finished" marks every run complete the instant it starts.

---

## 2. The success marker

### 2.1 Foreground runs — the `tool_result` is the answer

**MEASURED** (`-tmp-rt-exp-killint`). Child's last record and the parent's `tool_result` agree,
and the `tool_result` carries the run's own final text:

```json
{"type":"assistant","agentId":"aa62f5678111c0b4d","isSidechain":true,
 "message":{"role":"assistant","stop_reason":"end_turn","model":"claude-opus-5",
            "content":[{"type":"text","text":"The command was blocked by this environment's policy…"}]}}
```
```json
{"type":"user","isSidechain":false,
 "message":{"role":"user","content":[{"tool_use_id":"toolu_01RHDk1osN5J9NdNkaCtkuLs",
   "type":"tool_result","content":"[{\"type\":\"text\",\"text\":\"The command was blocked…\"}]"}]}}
```

Note `is_error` is **absent** (not `false`) on a successful tool result.

### 2.2 Background runs — the `<task-notification>` is the answer

**MEASURED.** When an async run stops, the harness injects a `<task-notification>` XML block
into the **parent** transcript, keyed by both the agent id and the task call's tool-use id:

```xml
<task-notification>
<task-id>a23802bc0ecfec111</task-id>
<tool-use-id>toolu_01FmUs3ZcfwHvurdLwJoqn7X</tool-use-id>
<output-file>/tmp/claude-1000/…/tasks/a23802bc0ecfec111.output</output-file>
<status>completed</status>
<summary>Agent "turn limited" stopped at its 1-turn limit (partial result; SendMessage to task-id to continue)</summary>
<note>A task-notification fires each time this agent stops with no live background children of its own. The user can send it another message and resume it, so the same task-id may notify more than once.</note>
<result>NOTE: this agent stopped at its 1-turn limit before finishing. …</result>
<usage><subagent_tokens>10782</subagent_tokens><tool_uses>1</tool_uses><duration_ms>3513</duration_ms></usage>
</task-notification>
```

**READ** — the format and its status vocabulary are specified verbatim in the system prompt
shipped inside the `claude` binary:

> ```xml
> <task-notification>
> <task-id>{agentId}</task-id>
> <status>completed|failed|killed|blocked</status>
> <summary>{human-readable status summary}</summary>
> <result>{agent's final text response}</result>
> …
> ```
> - `<result>` and `<usage>` are optional sections
> - The `<summary>` describes the outcome: "finished", "failed: {error}", "was stopped", or
>   "stopped at its N-turn limit" (partial result; continue it with SendMessage to the task-id)

**MEASURED — three of the four statuses reproduced today**: `completed` (corpus + `-tmp-rt-exp-maxturns`),
`failed` (`-tmp-rt-exp-failagent`), `killed` (`-tmp-rt-exp-stopped2`). `blocked` is **unobserved**.

**Trap — the notification lands in three different record shapes** depending on whether the
parent was idle or mid-turn when it fired. A parser must accept all of them:

| record `type` | discriminator | seen in |
| --- | --- | --- |
| `user` | `origin.kind === "task-notification"`, `promptSource` `"system"`/`"sdk"`, XML in `message.content` (a **string**) | corpus, `-tmp-rt-exp-maxturns` |
| `attachment` | `attachment.type === "queued_command"` **and** `attachment.commandMode === "task-notification"`, XML in `attachment.prompt` | `-tmp-rt-exp-failagent` |
| `queue-operation` | `operation: "enqueue"`, XML in `content` | both |

The same notification is written **two or three times** across those shapes for one stop.
Deduplicate on `(task-id, status, summary)`.

### 2.3 Do the child's `stop_reason` and the parent's result ever disagree? Yes — routinely.

**MEASURED, four independent ways:**

1. **Async, always.** The `tool_result` says "launched" while the child is still running, and
   keeps saying it after the child dies. All 18 pre-existing runs.
2. **`end_turn` is not terminal.** A finished run can be **resumed** with `SendMessage` and keep
   going under the same agent id and the same task call. `-tmp-rt-exp-killterm`'s child reaches
   `end_turn` at record 32 and then continues to record 34; corpus run `a18df906d7f4b2fb5`
   contains **two** `end_turn` records. The notification's own `<note>` says the same thing:
   *"the same task-id may notify more than once."*
3. **Mid-run `stop_reason`s that are not failures.** `-tmp-rt-exp-maxtok` (child forced against
   `CLAUDE_CODE_MAX_OUTPUT_TOKENS=1024`) contains three `"stop_reason":"max_tokens"` records.
   The harness auto-recovers each time by injecting a synthetic `isMeta: true` user turn —
   `"Output token limit hit. Resume directly — no apology…"` — and the run still ends `end_turn`
   and still reports success. `max_tokens` on a record is **not** a failed run.
4. **A finished-looking parent over a dangling child.** In `-tmp-rt-exp-killterm` the parent's
   last record is `end_turn` ("Waiting on it now") while the child's last record is a
   half-written assistant block with `stop_reason: null`.

**Trap — `stop_reason` is per *content block*, not per message.** One API turn is written as
several records sharing a `message.id` and increasing `apiBlockIndex`; only the **last** block of
the message carries a non-null `stop_reason`. In the corpus, `stop_reason: null` is the most
common value on assistant records (72 of the 140 assistant records in corpus run `af0b4a9aa`). Never read the last *record*'s
`stop_reason` — read the last *assistant* record's, and expect null when a message was cut off.

---

## 3. Failure

Three distinct failure surfaces, all measured today by pinning a custom agent to a model that
does not exist (`--agents '{"brokenmodel":{…,"model":"claude-does-not-exist-99"}}'`).

### 3.1 In the child's own record — `isApiErrorMessage`

**MEASURED** (`-tmp-rt-exp-failfg`, last record of the child):

```json
{"type":"assistant","agentId":"a9b58ad98c15e3659","isSidechain":true,
 "error":"model_not_found","isApiErrorMessage":true,
 "message":{"role":"assistant","stop_reason":"stop_sequence","model":"<synthetic>",
   "content":[{"type":"text","text":"There's an issue with the selected model (claude-does-not-exist-99)…"}]}}
```

Three markers on one record: wrapper `isApiErrorMessage: true`, wrapper `error` carrying a
machine code, and `message.model === "<synthetic>"`. **READ** — the binary's own predicate is
exactly that conjunction:

```js
function vG(e){ return e.type==="assistant" && e.isApiErrorMessage===true && e.message?.model===El }   // El === "<synthetic>"
```

**READ** — the wrapper also admits `apiError` (enum `max_output_tokens | dlp_request_denied |
claude_code_version_too_old`) and `api_error_status` (*"HTTP status code of the API error when
is_api_error_message is true"*). Neither appeared in any transcript on this machine: **unobserved**.

### 3.2 Foreground task call — `is_error: true`

**MEASURED** (`-tmp-rt-exp-failfg`, parent):

```json
{"type":"user","toolUseResult":"Error: Agent terminated early due to an API error: …",
 "message":{"role":"user","content":[{"type":"tool_result","is_error":true,
   "tool_use_id":"toolu_0144fHToGBCXK15MDyjJuCw9",
   "content":"Agent terminated early due to an API error: … (error type model_not_found, HTTP 404…)"}]}}
```

So **yes — the parent's `tool_result` does carry `is_error: true`** — but only for foreground
calls, which is the rare shape here (§1). `Agent terminated early due to an API error` is a
documented error string on `code.claude.com/docs/en/errors`.

### 3.3 Background task call — `<status>failed</status>`

**MEASURED** (`-tmp-rt-exp-failagent`):

```xml
<status>failed</status>
<summary>Agent "doomed run" failed: Agent terminated early due to an API error: There's an issue
with the selected model (claude-does-not-exist-99). … (error type model_not_found, HTTP 404,
request id req_011CfAfHrU6Vcw69aodhD2HQ, model sent to the API: claude-does-not-exist-99)</summary>
```

`<result>` and `<usage>` are **absent** on a failure.

### 3.4 A task call that fails before any run exists

**MEASURED** (`-tmp-rt-exp-badtype`): an unknown `subagent_type` is rejected client-side.

```json
{"type":"tool_result","is_error":true,"tool_use_id":"toolu_01EJpfDsHQTnT8MuYe48XW5r",
 "content":"Agent type 'totally-nonexistent-agent-9000' not found. Available agents: claude, Explore, general-purpose, Plan, statusline-setup"}
```

**There is no `subagents/` directory, no child transcript and no sidecar.** A failed task call
with `is_error: true` and *nothing to attach it to* is a real state. The Agents section is built
from sidecars, so such a call produces **no row** — which is arguably correct, but the code must
not assume every `is_error` task call has a run behind it.

### 3.5 Context window exceeded — UNOBSERVED

**READ**, from the binary. `stop_reason` is one of:

```js
["end_turn","max_tokens","stop_sequence","tool_use","pause_turn","compaction","refusal","model_context_window_exceeded"]
```

and `max_tokens` / `model_context_window_exceeded` are handled together, both turned into a
synthetic assistant message:

```js
if(_h==="model_context_window_exceeded")
  yield Ho({content:`${el}: The model has reached its context window limit.`,
            apiError:"max_output_tokens", error:"max_output_tokens"});
```

**INFERRED** (not measured): a context-window blow-out therefore lands as the same
`isApiErrorMessage` record shape as §3.1, with `apiError: "max_output_tokens"`. I did not
manufacture it — forcing a real 200k-token overflow costs a quadratic amount of re-sent context
and I judged the spend unjustified for a shape §3.1 already pins down. **Recorded as unobserved.**

### 3.6 Refusal — UNOBSERVED

**READ**: `stop_reason: "refusal"` is in the enum above, and the stream handler emits
`refusal_no_fallback` carrying `stop_details.category` and `stop_details.explanation` (the
`stop_details` field is present on every real assistant message in the corpus). Not manufactured
— deliberately: producing a genuine model refusal means composing a request designed to be
refused. **Unobserved.**

---

## 4. Interruption

### 4.1 Esc does not interrupt an agent run — because nothing is blocking on it

**MEASURED** in three pty-driven *interactive* sessions (`-tmp-rt-exp-esc4/5/6`; a real terminal,
real keystrokes, real `\x1b`). Because every interactive task call is async (§1), at the moment
Esc is pressed the main loop is **not** inside the `Agent` tool — it has already had its
`tool_result` and is idle, waiting on the notification. Two Esc presses four seconds apart did
**not** stop the run: the child kept executing and died only when the session process did.

For comparison, what Esc *does* write when it lands on a genuinely in-flight foreground tool —
**MEASURED**, six naturally-occurring instances in the pre-existing corpus
(`-home-quantumvik/44d945fe…`, `…/b1e5115b…`, `…/ca79a6f4…`) — is a pair of records:

```json
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","is_error":true,
  "content":"The user doesn't want to proceed with this tool use. The tool use was rejected…"}]},
 "toolUseResult":"User rejected tool use"}
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]}}
```

and, with nothing in flight, the bare `[Request interrupted by user]`. All six are
`isSidechain: false` — main thread only. **No interrupt marker has ever been written into an
agent run's own record on this machine by Esc.**

**READ** — the binary's own interrupted-call predicate, for reference; it matches a `tool_result`
with `is_error: true` whose text starts with one of five markers, or a wrapper
`toolUseResult === "User rejected tool use"`:

```js
function okt(e){ if(e?.type!=="user")return!1; let n=e.message.content.at(0);
  if(n?.type!=="tool_result"||n.is_error!==!0)return!1;
  if(e.toolUseResult==="User rejected tool use")return!0;
  let r=n.content; return typeof r==="string"&&["[Request interrupted by user]",
    "[Request interrupted by user for tool use]", "[Tool call did not complete: …]",
    "The user doesn't want to take this action right now. …", "[Tool call skipped: …]"]
    .some(s=>r.startsWith(s)) }
```

### 4.2 A *stopped* run does mark itself — `[Request interrupted by user]` in the child

**MEASURED, reproduced twice** (`-tmp-rt-exp-stopped`, `-tmp-rt-exp-stopped2`). Stopping a live
run through the harness (`TaskStop`, which is what `x` in `/tasks` and the kill-agents gesture
drive) writes a final record into the **child's own transcript**:

```json
{"type":"user","agentId":"ab0cfa48a038b01b1","isSidechain":true,
 "message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]}}
```

and a notification into the parent:

```xml
<status>killed</status>
<summary>Agent "victim two" was stopped by Claude</summary>
<result>I'll run the wait loop as requested.</result>
```

**This is the one interruption that is fully legible from the record, on both sides.**

### 4.3 The session dying — nothing is written, on either side

This is the case the ticket was right to fear.

**MEASURED — SIGKILL mid-run** (`-tmp-rt-exp-killkill`, foreground run, `kill -9` at t+55s):

- **Parent**: last record is the `tool_use` for the task call. **No `tool_result`. Nothing after.**
- **Child**: last record is a normal `tool_use` for `Bash`, `stop_reason: "tool_use"`, with **no
  matching `tool_result`**.
- Nothing anywhere says the run is over.

```json
{"type":"assistant","agentId":"a17305f3f064c6e3f","isSidechain":true,
 "message":{"role":"assistant","stop_reason":"tool_use","model":"claude-opus-5",
   "content":[{"type":"tool_use","id":"toolu_01DBFgqCm4c2q7F7SxdveDPv","name":"Bash","input":{…}}]}}
```

**MEASURED — session exits while a background run is live** (`-tmp-rt-exp-esc4`, `-tmp-rt-exp-esc5`):

- **Parent**: the async acknowledgement, then `end_turn`. The parent looks **finished and healthy**.
- **Child**: the run's in-flight `Bash` gets killed with the process and the very last thing
  written is its tool result — `{"is_error":true,"content":"Exit code 137"}` — after which the
  transcript simply stops. No assistant record, no `end_turn`, no notification.

**There is no `[Request interrupted by user]`, no `isApiErrorMessage`, no notification, and no
abort flag in any of these.** A dead-by-process-death run is, in the transcripts, exactly a
running run.

### 4.4 `isAbortedMidStream` is a red herring — do not build on it

The transcript schema *has* a field for this. **READ**, from the binary's own doc comment:

> *"True when this assistant message was truncated by an interrupt/abort before the stream
> completed: stop_reason was never received and the content may end mid-word. Absent on normally
> completed messages."* — wire `aborted`, transcript `isAbortedMidStream`.

But the writer is gated:

```js
let xq=()=>{ if(m.querySource!=="sdk" && m.keepPartialMessageOnAbort!==!0) return; … 
             return { …, type:"assistant", isAbortedMidStream:!0, … } }
```

**INFERRED from that gate, and MEASURED as consistent:** on the ordinary CLI path the partial
message is *discarded*, not stamped. `"isAbortedMidStream":true` appears in **zero** of the
`.jsonl` files under `~/.claude/projects` on this machine — including the ones I deliberately
aborted. Treat the field as unavailable.

---

## 5. Answer to each of the ticket's four questions

1. **The success marker.** Neither of the two candidates the ticket names. For an interactive
   session it is the **`<task-notification>` for that `tool-use-id` / `task-id`** in the parent
   (§2.2). The child's trailing `end_turn` is a *supporting* signal that can be undone by a
   resume; the parent's `tool_result` is, for every pre-existing run here, a launch receipt.
   For foreground runs (print/SDK only) the `tool_result` *is* the marker.
2. **Failure.** `<status>failed</status>` in the notification (background) or `is_error: true`
   on the task call's `tool_result` (foreground); and independently, in the run's own record,
   a final assistant record with `isApiErrorMessage: true`, `error: "<code>"` and
   `message.model === "<synthetic>"`. All measured. Context-overflow and refusal are unobserved
   but their record shape is specified in shipped code.
3. **Interruption.** A *harness-mediated* stop is fully legible: `<status>killed</status>` in the
   parent and `[Request interrupted by user]` as the last record of the child. A *process death*
   writes nothing at all, on either side. In the interactive TUI, Esc is not an agent interrupt
   — nothing blocks on the run, so it keeps going.
4. **Live vs dead.** **Not distinguishable from the transcripts alone.** §4.3 is real and common
   (every `Ctrl-C`, every closed terminal, every crash with an agent in flight). Two runs whose
   records are identical can be one that is thinking right now and one that died yesterday.

---

## 6. What to build

**INFERRED throughout this section** — it is design, resting on the measurements above.

### The status ladder — first match wins, per run

Key everything off the sidecar: `toolUseId` and the agent id in the filename.

1. **`stopped`** — the child's last record is a `user` record whose only text block is
   `[Request interrupted by user]`. *(Also confirmable by `<status>killed</status>` in the parent.)*
2. **`failed`** — the child's last assistant record has `isApiErrorMessage === true`
   *(equivalently `message.model === "<synthetic>"`)*. *(Also `<status>failed</status>`, or, for a
   foreground call, `is_error === true` on the task call's `tool_result`.)*
3. **`completed`** — a `<task-notification>` for this `task-id` exists with
   `<status>completed</status>`; **or** the task call is `requestShape: "foreground"` and its
   `tool_result` exists and is not the async acknowledgement. Surface `<summary>` next to the row
   — `"stopped at its N-turn limit"` is a completed run that did **not** finish its job, and the
   row should say so.
4. **`running` | `abandoned`** — nothing above matched. **Now, and only now**, consult liveness:
   - the owning session's process is **alive** → `running`;
   - it is **gone** → `abandoned` (died with its session; the work is lost and unrecoverable).

### The liveness oracle

**MEASURED.** `~/.claude/sessions/<pid>.json` is a registry of *live* Claude Code processes:

```json
{"pid":2226159,"sessionId":"4e432142-3b8e-4dad-8bee-4193e7fec8e1","cwd":"/tmp/rt-exp/esc5",
 "startedAt":1789723027295,"procStart":"26016373","version":"2.1.270","kind":"interactive",
 "status":"busy","updatedAt":1789723044122,"statusUpdatedAt":1789723044122}
```

Verified: every entry present named a live PID; all three of my killed experiment sessions
(including the `SIGKILL`ed one, which had no chance to clean up after itself) were **absent**.
`procStart` is there to defeat PID reuse. `status` is `busy` / `idle`.

**But claude-view does not need the registry for its own windows: it spawns the session process
and already holds the PID.** Use the registry only for sessions it did not launch. Both beat a
timestamp heuristic, which should not be built.

### Traps, in the order they will bite

1. **Never read a task call's `tool_result` as completion** without first checking the sidecar's
   `requestShape`. In the interactive corpus it is always the async receipt.
2. **`<task-notification>` arrives in three record shapes** (`user` / `attachment` / `queue-operation`)
   and is written 2–3× per stop. Match on `<task-id>`, dedupe on `(task-id, status, summary)`.
3. **`status: completed` ≠ the job was done.** Read `<summary>`; `"stopped at its N-turn limit"`
   is a partial result.
4. **A run can be resumed after it ends.** `end_turn` is not terminal, a notification is not
   final, and the same `task-id` can notify repeatedly. A row must be able to go
   `completed → running` again. Resumption happens via `SendMessage` and produces **no second
   task call**, so a run's activity is not bounded by its task call.
5. **`stop_reason` is per content block.** Only the last block of a message carries one; null is
   the majority value. Use the last *assistant* record, and treat a trailing null as
   "cut off mid-stream", not "unknown".
6. **`max_tokens` mid-run is not a failure** — the harness recovers from it silently.
7. **A failed task call may have no run at all** (unknown `subagent_type`): `is_error: true` and
   no sidecar, no child, no `subagents/` directory.
8. **`isAbortedMidStream` is never written on the CLI path.** Don't key on it.
9. **Depth-2 runs' task calls live in a *sibling subagent's* transcript**, not the session
   transcript. A `toolUseId` lookup that only scans `<session-id>.jsonl` will report "no task
   call" for them — it did in my first survey pass, for corpus run `a18df906d7f4b2fb5`.

---

## 7. Method, and what it cost

Everything new was manufactured in throwaway sessions under `/tmp/rt-exp/<name>`, one cwd per
case so each gets its own project slug under `~/.claude/projects/-tmp-rt-exp-<name>`. No existing
transcript was modified or deleted; all reads of the pre-existing corpus were read-only.

| case | how | project slug |
| --- | --- | --- |
| success, foreground | `-p`, `run_in_background:false` | `-tmp-rt-exp-killint` |
| success, background + turn limit | `--agents '{"stubborn":{…,"maxTurns":1}}'` | `-tmp-rt-exp-maxturns` |
| failure, foreground | `--agents '{…,"model":"claude-does-not-exist-99"}'` | `-tmp-rt-exp-failfg` |
| failure, background | same, `run_in_background:true` | `-tmp-rt-exp-failagent` |
| task call fails, no run | unknown `subagent_type` | `-tmp-rt-exp-badtype` |
| output-token limit | `CLAUDE_CODE_MAX_OUTPUT_TOKENS=1024` | `-tmp-rt-exp-maxtok` |
| stopped mid-run | `TaskStop` on a live run (×2) | `-tmp-rt-exp-stopped`, `-tmp-rt-exp-stopped2` |
| Esc, interactive | real pty, real `\x1b` (×3) | `-tmp-rt-exp-esc4/5/6` |
| `SIGKILL` mid-run | `kill -9` at t+55s | `-tmp-rt-exp-killkill` |
| `SIGTERM` mid-run | `kill -15` at t+55s | `-tmp-rt-exp-killterm` |

Two environment traps worth recording for whoever repeats this:

- `CLAUDE_CODE_CHILD_SESSION` is inherited by child processes and **disables transcript
  writing**. Launch with `env -u CLAUDE_CODE_CHILD_SESSION …` (I also cleared
  `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_BRIDGE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_SOCKET`,
  `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`).
- An interactive session in a fresh directory opens on the **"do you trust this folder?"** dialog
  and swallows the first typed prompt. A pty driver has to answer it (`↓`, `Enter`) first; a
  prior `claude -p` run in that directory does **not** pre-trust it.

### Sources

- **Transcripts** under `~/.claude/projects/` — the 18 pre-existing agent runs from this
  machine's two everyday project directories, plus 12 runs manufactured for this ticket.
- **The shipped `claude` binary**, 2.1.270 (`~/.local/share/mise/installs/claude/latest/claude`) —
  its embedded zod schemas, doc comments and system-prompt text, extracted with `strings`. This
  is the first-party source of record for the `<task-notification>` contract, the `stop_reason`
  enum, `isAbortedMidStream`, `isApiErrorMessage` and the interrupt-marker constants.
- **`code.claude.com/docs/en/sub-agents`** — confirms that a background subagent's results
  *"reach Claude as a completion notification in a later turn"*; that at `maxTurns` *"Claude Code
  returns its output marked as partial"*; that the panel *"keeps its row for 30 seconds"* when a
  subagent *"fails or you stop it"* but clears it immediately on success; and that a subagent
  *"you stopped yourself… doesn't auto-resume"*.
- **`code.claude.com/docs/en/errors`** — `Agent terminated early due to an API error` is a
  documented error, as are the context-limit and mid-response-cutoff families.
