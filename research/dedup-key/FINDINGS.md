# Which key de-duplicates `message.usage` — `message.id` or `requestId`?

Settles the disagreement between the two prior passes (issue #13 / #14 resolution
comments) from real data on this machine. Contributes to #15 (trace model); does not
close it.

**Corpus.** Every JSONL under `~/.claude/projects` — **33 files, 31 with assistant
records, 2,772 assistant records**, 5 project dirs, 15 parent sessions + 16 subagent
transcripts, Claude Code **2.1.270 / 2.1.272**, models `claude-opus-5` (2,681 recs),
`claude-haiku-4-5-20251001` (90), `<synthetic>` (1). Includes one **resumed/forked**
session, one **compacted** session (778,247 → 17,417 tokens), and **10 interrupt
sites**. Scripts: `01_keymap.py` … `08_truncated_and_rule.py` in this directory.

**Snapshot caveat.** Two sessions were live while this ran; the assistant-record count
drifted 2,772 → 2,803 between the first and last script. Ratios, the 1:1 result and the
null counts are properties of the format, not of the moment.

---

## TL;DR

| | |
|---|---|
| **Verdict** | Key on **`requestId`**, falling back to `message.id`, falling back to `uuid`. On real data this is **bit-identical** to keying on `message.id`; `requestId` is chosen because billing is per API request. |
| **Do they ever disagree?** | **No.** 2,771 records carrying both keys → **1,222 distinct `message.id` and 1,222 distinct `requestId`, a perfect bijection.** Zero `message.id` spanning >1 `requestId`; zero `requestId` spanning >1 `message.id`. |
| **The premise is partly wrong** | "Every record repeats the SAME complete usage" is **true for the input side (0/1,258 groups differ) but FALSE for `output_tokens`** — 283 groups carry a growing partial. **Last record wins**; taking the first undercounts output by **27.9%**. |
| **Magnitude** | Record/key ratio spans **1.00 – 3.571** across 31 files, median **2.117**. Token-weighted inflation: input **2.204×**, output **2.079×** corpus-wide. Both prior figures are inside this spread. |
| **Nulls** | `message.id`: **0 missing** (2,803/2,803). `requestId`: **1 missing** — the single `<synthetic>` record, which has all-zero usage and is already dropped by `usage_from()`. |
| **Extra bug found** | De-dup must be **global across files**, not per file. A resumed session replays 35 turns verbatim into a second transcript — same `message.id`, same `requestId`, same `uuid`, same timestamp, same usage. Per-file de-dup still double-counts **2,434,181 input tokens (0.88%)**. |

---

## 1. Do `message.id` and `requestId` ever disagree?

**No — not once in the corpus.**

```
assistant records total               2,772
  … carrying BOTH keys                2,771
distinct message.id                   1,222
distinct requestId                    1,222
message.id spanning >1 requestId          0
requestId spanning >1 message.id          0
```

A strict bijection over 1,222 API responses. This is not a coincidence of sampling —
it is what the format is: the API mints one `message.id` per response and Claude Code
records the `request-id` of the HTTP call that carried it. One response, one request.

**Label this honestly:** this is absence of evidence at a corpus of 1,222 requests
across 31 transcripts, 2 CLI versions, 2 models, including compaction, resume and
interrupts. It is *not* a proof that the API can never diverge. Section 3 says which
key to pick for the case that isn't in the corpus.

### But they *do* both repeat across FILES

35 `message.id`s appear in two transcripts at once:

```
-home-quantumvik/44d945fe-203a-46dd-9f3d-e248cc3108ae.jsonl   (1,501 assistant recs, 709 msgids)
-home-quantumvik/a1532e8c-2eac-4442-8803-c9262b0298e4.jsonl   (   96 assistant recs,  43 msgids)

shared message.id = 35   identical usage = 35/35   identical requestId = 35/35
                         identical uuid  = 35/35   identical timestamp = 35/35
```

`a1532e8c` is a **fork/resume** of `44d945fe`: its first 74 assistant records replay
`44d945fe`'s turns from `06:58:05.456Z … 07:15:13.885Z` byte-for-byte, then 22 records
of genuinely new work from `07:32:21.038Z`. The replayed records carry the **new**
session's `sessionId` but the **old** `uuid`/`message.id`/`requestId`/`timestamp`.

Consequence for the trace model: **the de-dup set must be global to a rollup, not
scoped per file.** Keying per `(file, message.id)` leaves 2,434,181 input tokens and
17,411 output tokens double-counted (0.88%) the moment a rollup spans a resumed
session. Both keys catch this equally — they are 1:1 — so this is orthogonal to the
key choice, but it is the same bug one level up and it is live in this corpus.

---

## 2. Where would they diverge in principle — and is any of it here?

Five candidate sites, each looked for rather than assumed.

| Site | In the corpus? | What was found |
|---|---|---|
| **Compaction** | **Yes**, 1 boundary | `compact_boundary`, `trigger: manual`, `preTokens: 778,247 → postTokens: 17,417`. Context across it: `777,941 → 61,451`. **0 `message.id` repeat across the boundary.** Compaction starts fresh ids; it is not a divergence site. It *is* a reason the context meter must not assume monotonicity. |
| **Resume / fork** | **Yes**, 1 pair | 35 turns replayed verbatim into a second file (§1). Both keys duplicate together. |
| **Interrupted turns** | **Yes**, 10 sites | The last record before each interrupt has `stop_reason: null` and a tiny `output_tokens` (2, 3, 4, 17). **Both keys change across every interrupt** (10/10: `same message.id? False, same requestId? False`) — the resumed turn is a fresh API call. |
| **Retries** | **No evidence** | No `retry`/`attempt` field exists on any assistant record (full field inventory in `06_…py`). Zero adjacent distinct-`requestId` pairs with identical input-side totals. `isApiErrorMessage: true` appears on **0** records. |
| **Stream resumption under one message.id** | **No evidence** | Would show as one `message.id` → two `requestId`s. Count: 0. |

### The one real surprise: partial usage snapshots

The BACKGROUND premise says every per-block record repeats the *same complete*
`message.usage`. Half of that is wrong:

```
message.id groups                                  1,258   (973 with >1 record)
  groups where the INPUT side differs within           0
  groups where output_tokens differs within          283
  … of those, LAST record holds the max              283/283   (0 counterexamples)
```

Concretely, one subagent turn:

```
msg_011Cf9V1eCJL6dXtkmAPnGcx  blocks=[0,1,2]  types=[thinking, tool_use, tool_use]
   input-side = [37941, 37941, 37941]      <- identical, as expected
   output     = [    5,     5,   453]      <- a stream snapshot, then the real total
```

versus a parent-session turn, where the premise does hold:

```
msg_011Cf4nr45mvoKKeAAxSQ9rf  blocks=[0,1,2]
   input-side = [53080, 53080, 53080]
   output     = [  693,   693,   693]
```

**All 283 divergent groups are in `subagents/*.jsonl`; zero are in parent session
files.** Subagent transcripts are flushed live per block, so early records carry the
`output_tokens` count as of that flush; parent transcripts are written with the final
usage. This is not academic — #14 concluded the app must start reading subagent
transcripts, which is exactly where this lives.

Two implications:

- **Take the LAST record per key, never the first, never "any".** First-wins undercounts
  corpus output by **27.9%** (713,027 vs 989,384).
- Curiously, the naive *sum* of `output_tokens` in a subagent file is within
  **1.003–1.011×** of the truth, because the partials are 1–8 tokens. The naive sum of
  the *input* side in the same files is **1.82–3.45×** out. A "looks about right"
  output figure is not evidence the summing is correct.

### The truncated turns

7 `message.id` groups end with `stop_reason: null` — the interrupted ones. Their
recorded `output_tokens` is 1, 2, 3 or 17 while the context that produced them was
14k–377k. The user was billed for whatever was generated before the abort; **the
transcript cannot recover that number.** Any cost rollup is therefore a *lower* bound
by an unknowable amount on 7/1,258 turns (0.6%). Worth a footnote in the UI, not a
blocker.

---

## 3. Which key is correct for COST accounting?

**`requestId`.** Reasoning, and the honest limit of it:

The deciding question was: *if the API charged for a request that was retried, does the
transcript show it once or twice — and does the user pay once or twice?*

**The corpus cannot answer it directly: there are no retries in it.** No retry field, no
error turns, zero adjacent same-context request pairs. So the choice is made on
what each key *is*, checked against what the corpus does show:

- `requestId` (`req_…`) is the identity of **one HTTP call to the API**. Billing is per
  API call. If a call happens, it is billed; if two calls happen, two are billed.
- `message.id` (`msg_…`) is the identity of **one assistant message the server
  produced**.

These coincide today. They would come apart in exactly one direction that matters: if a
stream were ever resumed or continued under the *same* `message.id` across *two* HTTP
requests, `message.id` would collapse two billed calls into one charge, while
`requestId` would keep both. The reverse failure (one request, many messages) has no
mechanism in a non-batch, `service_tier: "standard"` workload — and every record in this
corpus is `standard`.

So `requestId` is right by construction and free: it costs nothing on real data, because
it is 1:1 with `message.id` there.

The corpus *does* show the retry-adjacent case working correctly under both keys: at all
10 interrupt sites the aborted turn and the resumed turn have **different** ids in both
schemes, so two partial charges are counted as two. That is the right answer — the user
paid for both.

**Caveat to state in the UI, not to solve in code:** a request that failed *before* any
response produces no assistant record at all, so it is invisible to the transcript and
absent from any total, however keyed. Cost figures are lower bounds.

---

## 4. Reconciling 3.26× vs 2.24×–2.85×

**Neither was wrong. They sampled different files, and one was a subagent.**

Record/key ratio across all 31 files: **min 1.000, median 2.117, max 3.571.**
Token-weighted input inflation: **min 1.000, median 2.114, max 3.449.**

| recs | keys | rec/key | input × | file |
|---:|---:|---:|---:|---|
| 50 | 14 | **3.571** | 3.449 | SUBAGENT `agent-a1705fdcf7a898a7e` |
| 49 | 15 | **3.267** | 3.196 | SUBAGENT `agent-a7fba05422b2523db` |
| 159 | 56 | 2.839 | 2.788 | session `ca79a6f4…` |
| 73 | 26 | 2.808 | 2.593 | SUBAGENT `agent-ad4798744c289e0ee` |
| 96 | 43 | 2.233 | 2.288 | session `a1532e8c…` (the fork) |
| 134 | 62 | 2.161 | 2.179 | session `44e62ea7…` |
| 1501 | 709 | 2.117 | 2.197 | session `44d945fe…` (the big one) |
| 67 | 33 | 2.030 | 2.018 | session `d04583b6…` |
| 47 | 26 | **1.808** | 1.821 | SUBAGENT `agent-a7e3c1660cfb7c256` |

**Pass A's sample is reproducible exactly.** The first 63 assistant records of
`ca79a6f4…` give **21 distinct `message.id`** — their stated numbers — for a record
ratio of **3.000** and a token-weighted ratio of **2.955**. Their headline 3.26× is a
touch above what that window yields now (the file was live and has since settled to
2.839 / 2.788), and `3.267` is also the exact standing ratio of subagent
`agent-a7fba05422b2523db`. Either way it is a **short-window, high-block-count reading,
not a corpus figure**.

**Pass B's 2.24×–2.85× is the parent-session band**, and it is the one to quote for
whole sessions: every parent transcript in the corpus lands in **2.00–2.84**.

The driver is simply blocks-per-message, which is workload shape, not model or version:

```
records per message.id:   1 → 285 msgs    2 → 518    3 → 381    4 → 64    5 → 9    7 → 1
per model:    opus-5  rec/key 2.255      haiku-4-5  rec/key 2.727
per version:  2.1.270 rec/key 2.198      2.1.272    rec/key 2.831
sliding 63-record windows over the largest session: min 1.500, p50 2.172, max 2.864
```

A 63-record window can read anywhere from 1.50× to 2.86× on the *same file*. **Quote a
range, never a single multiplier.** Corpus-wide the honest numbers are **2.204× on the
input side and 2.079× on the output side.**

---

## 5. Is either key ever absent?

```
records missing message.id : 0        (2,803 / 2,803 carry it)
records missing requestId  : 1
```

The single exception, in full:

```
44d945fe-…jsonl line 1053
  message.model   "<synthetic>"
  message.id      "21f59ac4-58b2-463e-b5c1-81cf1a5dea49"   <- a UUID, not "msg_…"
  requestId       absent
  apiBlockIndex   absent
  usage           all zero (input 0, cache_read 0, cache_creation 0, output 0)
  stop_reason     "stop_sequence"    isApiErrorMessage false
```

So: `requestId` is null exactly once, on a record that carries no tokens and is already
rejected by `usage_from()`'s `input == 0 && output == 0` guard. It never reaches the
accumulator. `message.id` is never null but its *shape* is not guaranteed — on synthetic
records it is a bare UUID, so never parse or assume the `msg_` prefix.

Record identity, for the fallback chain:

```
distinct uuid                              2,698 / 2,772   (74 repeats = the resumed-session replay)
distinct (file, message.id, apiBlockIndex) 2,772 / 2,772   (0 collisions)
```

`uuid` is a sound last-resort key *because* its 74 repeats are exactly the replayed
turns that should collapse anyway.

---

## 6. The implementable rule for `transcript.rs`

### 6.0 First, a correction to the brief

`usage_from()` is called per line, but today **nothing sums it.** `pty.rs:404` does
`*session.usage.write() = Some(usage)` — last record wins — and `session.rs:217` ignores
`Record::Usage` entirely. **The context meter is already correct today.** The inflation
described in #13/#14 is a bug in the *cost rollup that #15 is about to add*, not a live
one. Fix it before the accumulator exists, not after.

### 6.1 Emit the key alongside the usage

```rust
pub enum Record {
    Usage {
        /// De-dup key: `requestId`, else `message.id`, else `uuid`.
        key: String,
        input: u64,             // input + cache_read + cache_creation (context occupancy)
        output: u64,
        // for #15, split the input side rather than collapsing it:
        // input_tokens, cache_read, cache_creation_5m, cache_creation_1h, model, …
    },
}
```

```rust
fn dedup_key(v: &Value) -> Option<String> {
    v["requestId"].as_str()
        .or_else(|| v["message"]["id"].as_str())
        .or_else(|| v["uuid"].as_str())
        .map(str::to_owned)
}
```

Rationale for the order, restated: `requestId` is the billed unit; `message.id` is 1:1
with it on all real data and is never null; `uuid` is a per-record last resort that
happens to collapse replayed turns correctly. Drop the record only if all three are
absent — which never happens (`uuid` is on 2,803/2,803).

### 6.2 Accumulate with LAST-WINS, keyed, over a rollup-wide map

```rust
// NOT `total += input`.
totals.insert(key, Usage { input, output });   // later line replaces earlier
// then, on read:
let input_total: u64 = totals.values().map(|u| u.input).sum();
```

Four properties this must have, each forced by the data above:

1. **Last wins, not first, not "insert if absent".** 283 groups carry a growing
   `output_tokens`; first-wins undercounts corpus output by 27.9%. Verified: the max is
   on the last record in 283/283 groups.
2. **The map is scoped to the rollup, not the file.** One resumed session replays 35
   turns into a second transcript with identical ids; per-file de-dup leaves 0.88% of
   input tokens double-counted.
3. **The map must survive a `Tailer` restart**, or a re-read of an already-counted
   prefix re-adds it. Persist the key set with the offset, or recompute the rollup from
   scratch rather than incrementally.
4. **Subagents sum *into* the same map, not on top of a parent that already counts
   them.** #14 established parent and child `requestId` sets are disjoint (0 overlap
   over 834 and 110 requests), so the union is correct and the keying makes it
   idempotent even if a file is scanned twice.

### 6.3 Context meter vs cost: two different reads of the same map

They genuinely want different things, and one map serves both:

- **Context meter — latest, not sum.** The input side is *cumulative context occupancy*,
  already the whole window; summing it is meaningless. Keep today's behaviour: the most
  recent `Usage` record's `input` wins. Keying changes nothing here, because the input
  side is identical across every record of a message (0/1,258 groups differ) — so the
  meter reads the same number whether it sees block 0 or block 4.
  - **Do not assume it only grows.** Compaction drops it hard: `777,941 → 61,451` in
    this corpus, and that session's final record sits at 50.1% of its peak. Drive the
    meter off the latest record, never a running max.
- **Cost — de-duplicated sum over the map**, as §6.2.

### 6.4 Subagents

Each `<session-id>/subagents/agent-*.jsonl` is a **separate context window** with its
own meter, and its own `Tailer`/offset. The parent's meter must not include child
tokens; the parent's *cost* rollup must (they are disjoint API requests). Both fall out
of §6.2/§6.3 if the cost map is rollup-scoped and the meters are per-file.

### 6.5 Two footnotes for the UI

- 7 turns (0.6%) were interrupted and record a 1–17 token stream snapshot instead of
  what was generated. Requests that failed before any response are absent entirely.
  **Cost totals are lower bounds.**
- `<synthetic>` turns carry zero usage and no `requestId`; they must not trip an
  "unpriced model" banner.

---

## What would settle the remaining uncertainty

The one thing this corpus cannot show is a genuine API retry or a stream resumed under
one `message.id`. To close that:

- Force a mid-stream failure (kill the network during a long generation) and inspect
  whether the retry reuses `message.id`. If it does — and carries a second `requestId` —
  `requestId` is not merely the safer choice but the *only* correct one, and this
  finding upgrades from "free insurance" to "load-bearing".
- Until then the rule in §6.1 is correct either way, because the fallback chain makes
  `requestId` and `message.id` interchangeable on everything that actually occurs.
