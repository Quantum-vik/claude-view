# Research: subagent transcripts — discovery, attribution, double-counted tokens

Resolves Quantum-vik/claude-view#14 (parent map #11).

Evidence: real transcripts under `~/.claude/projects` on this machine, Claude Code
**v2.1.270 / v2.1.272**. 4 project dirs, 10 session transcripts, **15 subagent
transcripts** across 2 sessions, plus one subagent deliberately spawned during the
research to settle nesting depth. All ids below are real; no message content is
reproduced.

Analysis scripts live next to this file in `research/subagent-transcripts/`.

**Snapshot note.** Both sessions examined were *live* while this ran, so absolute
parent totals drift upward between tables taken minutes apart (`44d945fe…` went
646 → 668 requests mid-analysis). The **ratios, the zero requestId overlap, and the
double-counting verdict are invariant** — they are properties of the format, not of a
moment.

---

## TL;DR

| Question | Answer |
|---|---|
| Location | `~/.claude/projects/<slug>/<parent-session-id>/subagents/agent-<agentId>.jsonl` — a **subdirectory named after the parent session**, not a sibling file |
| Filename encodes | **Neither** session id nor tool_use_id — only an opaque 17-hex `agentId` |
| Parent linkage | **Yes, exact and in-band.** A sidecar `agent-<agentId>.meta.json` carries `toolUseId`; the parent's own `toolUseResult` carries `agentId`. Both directions. Zero heuristics. |
| Double-counting | **NO.** Parent `message.usage` does **not** include child tokens. Parent and child requestId sets are **disjoint**. Today the app **under**-counts. |
| Nesting | **Yes** (`spawnDepth: 2` observed). Naming does **not** express the chain; `meta.parentAgentId` does. |
| Lifecycle | **Live, line-buffered, newline-terminated.** Tailable exactly like the parent. |
| Separate bug found | Claude Code writes **one assistant record per content block**, each repeating the *same* `usage`. `usage_from()` over-counts by **2.16x–2.65x** *within the parent alone.* |

---

## 1. Naming and location

The `locate()` comment ("subagent transcripts live alongside session files") describes a
**layout that no longer exists.** On v2.1.27x the layout is:

```
~/.claude/projects/
└── -home-quantumvik-WorkPersonal-claude-view/       <- project dir (cwd slug)
    ├── ca79a6f4-1702-4446-ad43-2d954f07e92f.jsonl   <- the session transcript
    └── ca79a6f4-1702-4446-ad43-2d954f07e92f/        <- dir named for that session
        ├── subagents/
        │   ├── agent-af0b4a9aaa314d555.jsonl        <- subagent transcript
        │   ├── agent-af0b4a9aaa314d555.meta.json    <- sidecar (the linkage)
        │   ├── agent-ad4798744c289e0ee.jsonl
        │   └── agent-ad4798744c289e0ee.meta.json
        └── tool-results/                            <- overflow tool output, `<id>.txt`
```

- Same **project** directory as the parent, but **two levels down**, in a directory whose
  name *is* the parent session id.
- The stem is `agent-<agentId>`, `agentId` = 17 lowercase hex chars, observed always
  leading with `a` (15/15). It encodes **neither** the parent session id **nor** the
  parent `tool_use_id`. It is an opaque handle; the *path* carries the session, the
  *sidecar* carries the tool_use_id.
- The `<session-id>/` dir is created lazily — sessions that never spawned an agent have
  none (6 of 10 sessions here).
- Consequence: `transcript.rs:locate()`'s `starts_with("agent-")` skip and the identical
  guard in `past_sessions.rs:93` are now **dead code** — `read_dir` on the project dir
  never yields these files, and the `extension() != "jsonl"` check already skips the
  `<session-id>/` directory entry. **Keep both guards** for older CLI versions that used
  the flat layout, but they are not what makes subagents invisible; the *absence of
  recursion* is.

### The sidecar

```json
{
  "agentType": "general-purpose",
  "description": "Research live tool output",
  "toolUseId": "toolu_01B7VudshYX9hY9M4ukngS63",
  "spawnDepth": 1,
  "requestShape": "background",
  "requestNonInteractive": true
}
```
and for a depth-2 agent, additionally `"parentAgentId": "a7d221c1ddeba59a6"` and
`"model": "haiku"` when the spawn overrode the model.

The sidecar is written **at spawn**, not at completion — mtime `00:01:18.131` vs the
transcript's first record timestamp `00:01:18.098`, a 33 ms gap. It is therefore
available to a tailer the moment the agent starts.

---

## 2. Linkage — there IS one, in both directions

**Child → parent** (`agent-<id>.meta.json`): `toolUseId` is the `id` of the
`Agent` (formerly `Task`) `tool_use` block that spawned it.

**Parent → child** (parent transcript, `toolUseResult` on the Task tool_result record):

```json
{
  "isAsync": true,
  "status": "async_launched",
  "agentId": "af0b4a9aaa314d555",
  "description": "Research live tool output",
  "resolvedModel": "claude-opus-5[1m]",
  "prompt": "<str len=3823>",
  "outputFile": "/tmp/claude-1000/<project-slug>/<session-id>/tasks/af0b4a9aaa314d555.output",
  "canReadOutputFile": true
}
```

Verified 1:1 over **all 15** subagents in both sessions: every `meta.toolUseId` matches
exactly one `Agent` tool_use id in the owning transcript, and that call's
`toolUseResult.agentId` matches the file stem. No timestamp correlation needed anywhere.

Also inside every child record: `isSidechain: true`, `agentId: "<stem>"`,
`sessionId: "<root session id>"`, plus the parent's `cwd`, `version`, `gitBranch`.

**Naming note for the implementation:** in v2.1.27x the tool is emitted as
`name: "Agent"`, not `"Task"`. Match **both** — `("Task" | "Agent")` — or older
transcripts break.

**`outputFile` is not the transcript.** It is a live plain-text stream of the agent's
output under `/tmp/claude-1000/.../tasks/<agentId>.output`. Useful for live text; the
JSONL under `subagents/` remains the structured source of truth.

### What the parent sees when a subagent finishes

Not a tool_result update. A **`type: "attachment"`** record with
`attachment.commandMode: "task-notification"`, whose `prompt` holds the agent's final
report text, preceded by `type: "queue-operation"` records (`enqueue`, then `remove`
with `reason: "absorbed_mid_turn"`).

**A trap worth naming:** that notification text contains
`<usage><subagent_tokens>29534</subagent_tokens>...`. For the depth-2 probe the child's
own transcript sums to `input(18) + cache_creation(29,409) + output(48) = 29,475` —
so `subagent_tokens` ≈ new (non-cache-read) tokens, within ~0.2%. It is **advisory
text, not accounting**: it lives inside a `queue-operation`/`attachment` string, has no
`message.usage`, and `usage_from()` correctly ignores it. Do **not** start parsing it —
adding it to a summed child transcript is exactly how double-counting would get
*introduced*.

---

## 3. DOUBLE-COUNTING — verdict: the parent does NOT include the child

**No double-counting. Summing parent + children is correct. The app today
under-counts.**

Three independent proofs.

### Proof A — disjoint requestId sets

Every assistant record carries `requestId`, the API request that produced it. If the
parent re-billed the child's turns, the child's requestIds would have to appear in the
parent file.

Session `44d945fe-203a-46dd-9f3d-e248cc3108ae`, 11 subagents:

```
parent   distinct requestIds = 646
children distinct requestIds = 188   (11 agents)
OVERLAP                      =   0
union                        = 834   (= 646 + 188, exactly)
```

Session `ca79a6f4-1702-4446-ad43-2d954f07e92f`, 4 subagents:

```
parent   distinct requestIds =  35
children distinct requestIds =  75   (4 agents)
OVERLAP                      =   0
union                        = 110   (= 35 + 75, exactly)
```

834 and 110 distinct API requests, **zero** shared. Parent and child are separate API
conversations.

### Proof B — no sidechain records in the parent file

Scanning `ca79a6f4…jsonl`: `isSidechain` = `false` on all 129 records that carry the
field, `true` on all 53 records of `agent-af0b4a9aaa314d555.jsonl`. Subagent turns are
**not** inlined in the parent file on this version.

### Proof C — turn-level context delta (the decisive one)

Subagent `agent-a1705fdcf7a898a7e` (`claude-code-guide`, 14 API requests) ran
`18:24:24.277Z → 18:26:15.426Z` and consumed **377,211** input-side tokens. Parent
context across exactly that window:

```
18:24:14.331Z  ctx= 282,072   <- last parent request BEFORE the child started
18:24:25.693Z  ctx= 285,981
   …14 interleaved parent requests of its own…
18:26:13.900Z  ctx= 298,666
18:26:20.030Z  ctx= 299,285   <- first parent request AFTER the child finished

parent ctx delta across the child's entire run = +17,213
child's own consumption                        = 377,211
```

`+17,213` — and that includes the parent's **own** 14 tool calls in the same window.
Not `+377,211`. The parent pays only for the child's *final report text* as ordinary
input. The child's 377k is billed exclusively in the child's file.

### The arithmetic, both sessions

Per-request de-duplicated (see §6 — raw sums are inflated), input-side =
`input_tokens + cache_read_input_tokens + cache_creation_input_tokens`.

**Session `44d945fe…` — 11 subagents**

| | requests | input_tokens | cache_read | cache_create | input-side | output |
|---|---:|---:|---:|---:|---:|---:|
| parent | 646 | 1,324 | 198,095,199 | 1,884,011 | **199,980,534** | 471,753 |
| 11 children | 188 | 467 | 17,370,456 | 1,535,955 | **18,906,878** | 11,016 |
| **true total** | 834 | | | | **218,887,412** | **482,769** |

Subagents = **8.6%** of the true total — invisible today.

**Session `ca79a6f4…` (this research session) — 4 subagents**

| | requests | input-side | output |
|---|---:|---:|---:|
| parent | 35 | 3,559,861 | 49,954 |
| `agent-a7d221c1ddeba59a6` (depth 1) | 29 | 2,013,302 | 89 |
| `agent-a18df906d7f4b2fb5` (depth 2) | 2 | 57,283 | 48 |
| `agent-ad4798744c289e0ee` (depth 1) | 21 | 2,698,016 | 89 |
| `agent-af0b4a9aaa314d555` (depth 1) | 23 | 1,615,218 | 1,635 |
| **children subtotal** | 75 | **6,383,819** | 1,861 |
| **true total** | 110 | **9,943,680** | 51,815 |

`3,559,861 + 6,383,819 = 9,943,680`. Children are **1.79x** the parent —
**64.2% of this session's tokens are invisible to claude-view right now.**

A three-agent research fan-out is not exotic; it is what this repo's own workflow does
routinely. Shipping a cost number that omits two thirds of the spend would be worse
than shipping none.

---

## 4. Nesting depth — yes, and the filename does NOT express the chain

Settled **empirically**: a depth-1 subagent (this one) spawned a trivial haiku subagent.
Result:

```
agent-a18df906d7f4b2fb5.meta.json
{
  "agentType": "general-purpose",
  "description": "Nesting depth probe",
  "toolUseId": "toolu_017YfSfKUoH8g9A5FQNcFRjz",
  "parentAgentId": "a7d221c1ddeba59a6",     <- present only at depth > 1
  "spawnDepth": 2,
  "model": "haiku"
}
```

The depth-2 transcript landed at
`…/ca79a6f4-…/subagents/agent-a18df906d7f4b2fb5.jsonl` — **the same flat
`subagents/` directory of the ROOT session.** Not nested under the spawning agent. And
inside it, `sessionId` is still the **root** session id, `isSidechain: true`.

So:
- **Layout is flat, one level, keyed on the root session.** Depth is invisible in the path.
- The chain is in the sidecar only: `spawnDepth` + `parentAgentId`.
- `meta.toolUseId` resolves against **the parent agent's transcript** at depth ≥ 2, not
  the session transcript. Verified: `toolu_017YfSfKUoH8g9A5FQNcFRjz` appears as an
  `Agent` tool_use in `agent-a7d221c1ddeba59a6.jsonl` and in **no other** agent file.
  (It also appears in the root session file, but only inside `queue-operation`
  notification *text* — not as a tool_use block. Resolve by scanning **tool_use blocks
  only**, never substring-matching the raw line.)

Reconstruction rule: group by `parentAgentId` (absent ⇒ child of the session itself).
Reference implementation in `tree.py`; output for this session:

```
session ca79a6f4-…  requests=35 input-side=3,559,861 output=49,954
  +- agent-a7d221c1ddeba59a6  depth=1  spawned by toolu_01B1Hnnd… in the session transcript
    +- agent-a18df906d7f4b2fb5  depth=2  spawned by toolu_017YfSfK… in agent-a7d221c1ddeba59a6
  +- agent-ad4798744c289e0ee  depth=1  spawned by toolu_01CPrUMQ… in the session transcript
  +- agent-af0b4a9aaa314d555  depth=1  spawned by toolu_01B7Vuds… in the session transcript
```

Practical note: `spawnDepth` is bounded by the CLI, and the *sum over a tree* is what a
cost rollup needs — the tree shape is presentation. Recursion is safe because
`parentAgentId` can only point at an agent in the same flat directory; guard against a
cycle anyway and fall back to "child of session".

---

## 5. The privacy gate — how the rule holds the same line

`locate()`'s rule (transcript.rs:227-234) exists because a *guess* by directory could
adopt a different, possibly private session running in the same cwd. Hence: exact
`<session_id>.jsonl`, **or** a start-time gate.

**The subagent rule needs no guess at all, and is therefore strictly stronger.**

```
Given a session transcript already adopted by locate() at
    <project>/<session-id>.jsonl
its subagent transcripts are exactly the files matching
    <project>/<session-id>/subagents/agent-*.jsonl
and nothing else. Never scan any other directory. Never scan by mtime,
cwd, or start time.
```

Why this cannot mis-attribute:

1. **The directory name IS the session id** we already proved is ours. Discovery is
   *derived from* the adopted path by pure string construction — it inherits
   `locate()`'s guarantee rather than re-deriving it. There is no second guess to get
   wrong.
2. **No ambiguity is possible.** `locate()` needs a start-time gate only because many
   transcripts share one cwd and it must pick one. Here the set is fully determined:
   one directory, enumerate it. Two sessions in the same repo get two different
   `<session-id>/subagents/` directories; neither can see the other's.
3. **Defence in depth — verify, don't assume.** Adopt a child only if all three hold
   (checked across all 15 files here, 15/15 pass):
   - first record has `isSidechain == true`
   - first record's `sessionId == <session-id>` (the directory name)
   - first record's `agentId` == the filename stem after `agent-`

   Any mismatch ⇒ skip. A stray or hand-copied file in that directory is rejected.
4. **Strictly narrower than today's rule.** `locate()` *scans every project directory*
   and pattern-matches. This rule reads one known path. It cannot widen the blast
   radius; it can only look inside a session the app already established is this
   window's.
5. **If `locate()` returned nothing, discovery returns nothing.** No subagent is ever
   adopted for an unadopted session. The gate is not bypassed — it is a precondition.
6. **The start-time gate is not needed and must not be re-introduced as a substitute.**
   A long-running background agent can outlive its spawning turn and a child's first
   record can precede a naive window boundary; gating children on time would drop real
   data while adding no safety the directory containment does not already give. Time is
   the weaker signal here; containment is the stronger one. (Equally: do **not** gate
   children on `cwd` — an agent run in a git worktree legitimately has a different cwd,
   while still belonging to this session.)

One-line statement for the code comment:

> A subagent transcript is adopted **only** from `<adopted-session-path-without-.jsonl>/subagents/`,
> and only if its own `sessionId` field equals that session id and `isSidechain` is
> true. Containment in the session's own directory is the attribution proof; no
> time-based or cwd-based guess is involved.

---

## 6. Lifecycle — live and tailable

**Written live, line by line, newline-terminated. Not flushed at completion.**

- This agent's own transcript, sampled while it was still running:
  `239,480 → 431,509 → 463,548 → 465,786 → 529,659` bytes. It grows mid-run.
- All 15 agent `.jsonl` files end in `\n` — records are flushed as complete lines,
  identical to parent transcripts.
- The sidecar `.meta.json` is written **at spawn** (33 ms before the first transcript
  record), so `agentType`, `description` and `toolUseId` are known the instant the
  Task tool_use appears — the timeline can render the subagent node immediately and
  fill it in as lines arrive.

**Therefore live subagent traces are fully possible.** The existing `Tailer` works
unmodified per file: same JSONL shape, same `message.content` blocks, same half-line
guard (`if !line.ends_with('\n') { break; }`) — which is required here for the same
reason.

Implementation shape: on each poll, `read_dir` the `subagents/` directory (cheap; it
only changes when an agent spawns) and keep one `Tailer`-equivalent per `agentId`,
seeded from the sidecar. Since the directory appears only when the first agent spawns,
a missing directory is the normal case and must not be an error.

---

## 7. Separate, larger bug found on the way: in-parent triple counting

Independent of subagents, and it hits **every** cost figure.

Claude Code v2.1.27x writes **one assistant JSONL record per content block**. All
records of one API response repeat the **same** `message.id`, the **same** `requestId`,
and the **same, complete `message.usage`**, differing only in `apiBlockIndex`:

```
requestId req_011Cf9U8dfsMrQGQcgRrc5AR: 4 records, 1 distinct usage tuple, 1 distinct
  message.id, apiBlockIndex=[0,1,2,3], blocks=[['thinking'],['text'],['tool_use'],['tool_use']]
```

Across the parent of `ca79a6f4…`: **63 assistant records, 21 distinct requestIds**;
20 of 21 multi-record, **0** with differing usage. Across `44d945fe…`: **1,396 records,
646 requests**.

`usage_from()` is called per line and the caller sums, so today's totals are inflated:

| transcript | raw sum (input-side) | de-duped | inflation | records / requests |
|---|---:|---:|---:|---|
| `44d945fe…` parent | 463,588,902 | 207,309,632 | **2.24x** | 1433 / 668 |
| `ca79a6f4…` parent | 12,654,679 | 4,440,432 | **2.85x** | 119 / 41 |
| `agent-ad4798744c289e0ee` | 9,202,303 | 3,548,337 | **2.59x** | 73 / 26 |

**Fix: de-duplicate assistant usage by `requestId`** (fall back to `message.id`) before
summing — keep the first record per request, ignore the rest. Cheap: a `HashSet<String>`
on the tailer.

Note this bug is *not* symmetric with the context meter's needs: for **cost** you want
the de-duplicated **sum** over requests; for the **context meter** you want the
**latest** request's input-side figure (peak/last, not a sum). Today's code conflates
them. Peak context observed: `44d945fe…` = 777,941; `ca79a6f4…` children peak at
~168,668 each — each subagent has its **own** context window, so a per-agent meter is
meaningful and must not be folded into the parent's.

---

## 8. Implementable summary

```rust
// 1. locate() the session transcript as today (unchanged privacy gate).
// 2. subagents_dir = session_path.with_extension("").join("subagents")
//    -> ~/.claude/projects/<slug>/<session-id>/subagents/
// 3. For each agent-<id>.jsonl there:
//      read agent-<id>.meta.json  -> toolUseId, spawnDepth, parentAgentId,
//                                     agentType, description, model
//      verify first record: isSidechain == true
//                        && sessionId == <session-id>
//                        && agentId   == <id>
//      else skip.
// 4. Nest: parentAgentId.is_none() => child of the session, attach under the
//    Agent/Task tool_use whose id == meta.toolUseId in the session transcript.
//    Some(p)                       => attach under that id in agent-<p>.jsonl.
//    Match tool name in ("Task" | "Agent"). Scan tool_use BLOCKS, not raw text.
// 5. Tail each agent file with the existing Tailer logic (complete lines only).
// 6. Cost: total = parent + SUM(all agents), de-duplicated by requestId.
//    Do NOT also add toolUseResult / task-notification `subagent_tokens`.
// 7. Context meter: per-agent, from the LAST request of that file — never summed,
//    never merged into the parent's.
```

### Caveats / what would change this

- Single machine, Claude Code **2.1.270/2.1.272**, single account. The
  `<session-id>/subagents/` layout is version-dependent — the `locate()` comment proves
  an older flat layout existed. Keep the `agent-` stem guards for old data, and treat a
  missing `subagents/` dir as normal.
- **Every subagent observed here was `isAsync: true` / `status: "async_launched"`.** No
  *synchronous* Task ran on this machine, so the synchronous `toolUseResult` shape is
  unverified. Older Claude Code versions put `totalTokens` / `usage` on a synchronous
  Task's tool_result — **if such a field is ever seen, it is a summary of the child and
  must NOT be added on top of the child transcript.** The rule stands either way:
  sum the child's own transcript, ignore any parent-side summary.
- Proof C's window contains the parent's own concurrent work (background agents run in
  parallel), which makes `+17,213` an *upper* bound on the report absorption — the
  conclusion is only strengthened.
