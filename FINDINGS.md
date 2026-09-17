# Research: model pricing — table source, shape, and how it stays current

Resolves #13 (parent map #11). Branch: `research/pricing` (local, throwaway).
Draft source file: `src/pricing.ts` — not wired in.

**Prices verified 2026-09-18** against
<https://platform.claude.com/docs/en/about-claude/pricing> (§ Model pricing, § Prompt caching,
§ Long context pricing, § Batch processing, § Fast mode, § Data residency) and
<https://platform.claude.com/docs/en/build-with-claude/context-windows>, reached through the
`claude-api` skill. Nothing below is from memory. The skill's own cached table (2026-06-24)
covers input/output only and carries no cache rates, so the live doc is the source of record.

---

## The headline

I costed this machine's real transcripts (`~/.claude/projects`, 1,000 deduped Opus 5 turns +
16 Haiku 4.5 turns) two ways — correctly per token kind, and the way today's data shape forces:

| | Correct | Today's shape (collapsed input @ base rate) | Error |
|---|---|---|---|
| `claude-opus-5` | **$165.01** | $1,183.15 | **7.2× over** |
| `claude-haiku-4-5` | **$0.11** | $0.42 | 4.0× over |

`usage_from()` collapsing the three input kinds isn't a rounding problem — on a real Claude Code
workload it is a **7× overstatement**, because ~97% of input tokens are cache reads priced at
0.1× base. Splitting it is the whole ballgame.

---

## 1. The table (per model, per token kind, $/MTok)

Anthropic first-party list prices. Bedrock / Google Cloud are partner-operated with separate
pricing and Claude Code doesn't use them — out of scope.

| Model | Input | Cache write 5m | Cache write 1h | Cache read | Output |
|---|---|---|---|---|---|
| Claude Fable 5.1 | $10 | $12.50 | $20 | **$0.25** | $50 |
| Claude Mythos 5.1 | $10 | $12.50 | $20 | **$0.25** | $50 |
| Claude Fable 5 | $10 | $12.50 | $20 | **$1.00** | $50 |
| Claude Mythos 5 | $10 | $12.50 | $20 | **$1.00** | $50 |
| Claude Opus 5 | $5 | $6.25 | $10 | $0.50 | $25 |
| Claude Opus 4.8 | $5 | $6.25 | $10 | $0.50 | $25 |
| Claude Opus 4.7 | $5 | $6.25 | $10 | $0.50 | $25 |
| Claude Opus 4.6 | $5 | $6.25 | $10 | $0.50 | $25 |
| Claude Opus 4.5 | $5 | $6.25 | $10 | $0.50 | $25 |
| Claude Opus 4.1 | $15 | $18.75 | $30 | $1.50 | $75 |
| Claude Opus 4 | $15 | $18.75 | $30 | $1.50 | $75 |
| Claude Sonnet 5 | $2 | $2.50 | $4 | $0.20 | $10 |
| Claude Sonnet 4.6 | $3 | $3.75 | $6 | $0.30 | $15 |
| Claude Sonnet 4.5 | $3 | $3.75 | $6 | $0.30 | $15 |
| Claude Sonnet 4 | $3 | $3.75 | $6 | $0.30 | $15 |
| Claude Haiku 4.5 | $1 | $1.25 | $2 | $0.10 | $5 |
| Claude Haiku 3.5 | $0.80 | $1.00 | $1.60 | $0.08 | $4 |

Cache multipliers are **1.25× base for a 5-minute write, 2× for a 1-hour write, 0.1× for a
read** — except Fable 5.1 / Mythos 5.1, where reads are **0.025×**. Output includes thinking
tokens; `output_tokens_details.thinking_tokens` is a *subset* of `output_tokens`, so adding it
double-counts.

### Coverage against the app's catalog

`src/models.ts` ships `opus`/`opusplan` (4.8), `sonnet` (4.6), `sonnet[1m]` (4.6), `haiku` (4.5),
and `default`. All priced. `displayModelId()` already renders models outside the list (Fable) and
those are priced too. `default` is an *alias*, never a transcript value — always price off
`message.model`, never off the switcher's selection, since a `/model` switch can be declined.

### Modifiers that stack (all four are recorded in the transcript)

- `usage.service_tier == "batch"` → ×0.5. Claude Code never batches; observed `"standard"`.
- `usage.inference_geo == "us"` → ×1.1 on **every** category. Observed `"not_available"`.
- `usage.speed == "fast"` → Opus 5 / Opus 4.8 only, reprices base to **$10 in / $50 out** (cache
  multipliers then apply on top). Observed `"standard"`.
- `usage.server_tool_use.web_search_requests` → **$10 per 1,000 searches**, flat, not per token.
  Web fetch is free. Both counters are present in every record.

---

## 2. Long context: there is no premium

**`sonnet[1m]` costs exactly what `sonnet` costs.** For every 1M-context model, 1M is the
default, needs no beta header, and is billed at standard rates — "a 900k-token request is billed
at the same per-token rate as a 9k-token request". Caching and batch discounts apply unchanged
across the full window. The `[1m]` alias selects a context window, not a price tier.

So the question "does the transcript record enough to know which rate applied" has no >200K
branch to resolve. **And the answer is yes anyway, more completely than expected** — a real
record carries:

```json
"usage": {
  "input_tokens": 2,
  "cache_creation_input_tokens": 14499,
  "cache_read_input_tokens": 33814,
  "output_tokens": 993,
  "output_tokens_details": { "thinking_tokens": 654 },
  "server_tool_use": { "web_search_requests": 0, "web_fetch_requests": 0 },
  "service_tier": "standard",
  "cache_creation": { "ephemeral_1h_input_tokens": 14499, "ephemeral_5m_input_tokens": 0 },
  "inference_geo": "not_available",
  "speed": "standard"
}
```

The find that matters: **`cache_creation` splits the write by TTL.** Without it, cache writes
could not be priced at all — 5m and 1h differ by 1.6×. Verified consistent on **991/991 messages**
(`cache_creation_input_tokens == ephemeral_5m + ephemeral_1h`, zero mismatches).

And Claude Code writes **mostly 1-hour** cache: across this corpus, Opus 5 shows 2,468,415 tokens
at 1h vs 1,741,856 at 5m. Assuming a flat 1.25× write multiplier — the obvious shortcut — would
understate cache writes by ~60% on the majority of them.

---

## 3. Model id → price mapping

**Rule.** Normalize, then look up exactly:

1. lowercase, trim;
2. strip Bedrock (`anthropic.`, `us.anthropic.`) and Vertex (`@YYYYMMDD`) spellings;
3. strip the `claude-` prefix;
4. strip a trailing `-YYYYMMDD` snapshot date.

`claude-haiku-4-5-20251001` → `haiku-4-5`; `claude-opus-4-8` → `opus-4-8`; `claude-fable-5` →
`fable-5`. Exact key match against the table. Confirmed against every id in this machine's
transcripts: `claude-opus-5` (2,218 records), `claude-haiku-4-5-20251001` (54), `<synthetic>` (1).

**Unknown or future id → labelled `Unpriced`. Not a family-prefix guess, and never a zero.**

Justification, from the table above rather than from principle. Within one family, adjacent
releases diverge:

- **Fable 5 → Fable 5.1: cache read $1.00 → $0.25, a 4× swing** under an unchanged $10/$50
  headline. A prefix match on `fable-` would have been 4× wrong on the single largest token
  category in a Claude Code workload.
- **Opus 4.1 → Opus 4.5: base input $15 → $5**, a 3× swing under prefix `opus-`.
- **Sonnet 4.6 → Sonnet 5: $3 → $2** — and Sonnet 5's price was itself scheduled to *rise* to
  $3/$15 on 2026-09-01 before that increase was cancelled.

A family fallback is therefore most wrong exactly when it fires: on a model too new for the
table, which is the moment repricing is most likely. It converts "I don't know" into a confident
wrong number — the failure mode #11 calls out. Family-prefix matching is fine for *sizing a
context window* (what `ContextMeter`'s `WINDOWS` table does, where families really are uniform);
it is not fine for money.

`<synthetic>` is a live example of the unknown case — Claude Code emits it for
`"No response requested."` turns, with **all-zero usage**. Rule: drop zero-token turns before
pricing, so `<synthetic>` never trips the unpriced banner. Unpriced turns must still be **counted
in the token totals** and must visibly mark any rollup they're inside as understated.

---

## 4. How the table stays current

**Recommendation: a hardcoded TypeScript constant with an explicit `AS_OF` date, refreshed by
hand, plus a user override file.**

The trade-off in one line: **a hardcoded table can only be wrong in a way a human chose and
dated, whereas a runtime fetch can be wrong silently, offline, or not at all.**

Why the alternatives lose, given an offline-first desktop app with no server:

- **Runtime fetch** — needs a URL this project doesn't own, fails closed on a plane, and the
  pricing page is prose-with-tables (there is no pricing API), so the parse is the fragile part.
  It also turns a launcher into a phone-home.
- **Shipped JSON** — same staleness as a constant, but loses compile-time typing and adds a load
  path and a parse failure mode for zero benefit; nothing can edit it between releases anyway.
- **User-editable alone** — pushes a correctness burden onto the user and makes every screenshot
  unreproducible.

Concrete shape:

- `PRICES` + `AS_OF = "2026-09-18"` in `src/pricing.ts`, checked by CI reminder or a dated TODO.
- The UI **always shows the as-of date** next to any total, so a stale table is visible rather
  than silent.
- If `AS_OF` is older than ~90 days, soften the label (e.g. "prices may be out of date") rather
  than hiding the figure.
- **Optional override:** `~/.config/claude-view/prices.json`, same shape, merged over the
  built-in table at startup. Costs ~20 lines, covers the enterprise-discount and new-model cases
  between releases, and keeps the shipped default authoritative for everyone who ignores it.

---

## 5. The subscription framing — exact UI wording

On Pro/Max no per-token charge is made. Every figure is notional. The strings live in `CAVEAT`
in `src/pricing.ts` so they can't drift between call sites.

- **Prefix on every figure** (never a bare `$`):

  > `Notional $1.83`

- **Tooltip on any cost figure / body of the rollup info popover** — verbatim:

  > Notional cost — what these tokens would have cost at Claude API list prices. Your Claude
  > subscription is billed at a flat rate, so this is not a bill and you were not charged this
  > amount.

- **Footer line under any total or rollup** — verbatim:

  > Notional · API list prices as of 18 Sep 2026 · not a bill

- **Unpriced state** (in place of the figure):

  > `Unpriced`
  >
  > tooltip: No list price on file for "<model-id>". Its tokens are counted but not costed, so
  > totals that include this turn are understated.

- **Rollup containing unpriced turns**, appended after the total:

  > `+ 3 turns unpriced`

Rules for whoever builds the UI: never render a bare currency figure without the `Notional`
prefix or the footer in the same visual block; never render `$0.00` for an unknown model; never
use the words "spent", "charged", "billed", or "cost you".

---

## 6. What this implies for the build (hand-off to the cost-engine ticket)

Not decisions for #13, but discovered while verifying the table and needed for the number to be
right:

1. **Split `usage_from()` into five counters** — `input_tokens`, `ephemeral_5m_input_tokens`,
   `ephemeral_1h_input_tokens`, `cache_read_input_tokens`, `output_tokens`. Keep the collapsed
   sum as a separate field for `ContextMeter`, which legitimately wants context occupancy.
   (`src-tauri/src/transcript.rs:34-46`; `past_sessions.rs:10` shares it.)

2. **Dedupe by `message.id` before accumulating.** Claude Code writes **one JSONL line per
   content block**, each repeating the *same* `usage` object. Measured on one session: 63
   assistant lines, **21 distinct `message.id`**; naive output-token sum 122,609 vs deduped
   37,615 — a **3.26× over-count**. Harmless for the context meter (it reads the latest value);
   fatal for a running total.

3. **Dedupe across files too.** Resumed/forked sessions replay earlier assistant messages into
   the new transcript — 35 `message.id`s here appear in more than one file (997 distinct ids
   total). A cross-session rollup that unions transcript files must dedupe globally by
   `message.id`.

4. **Don't add `thinking_tokens` to `output_tokens`.** It's a subset.

5. **Carry `web_search_requests` through.** It's the one cost that isn't a token cost.

---

## Surprises

- **The transcript already records everything needed**, including the per-TTL cache-write split
  and all four price modifiers. The blocker was never the data — it was `usage_from()` throwing
  it away.
- **Claude Code prefers the 1-hour TTL**, so the "cache write ≈ 1.25×" assumption in #11's notes
  is the wrong default for this app; 2× fits the majority of writes.
- **`sonnet[1m]` carries no price premium at all** — the long-context surcharge that made this
  question worth asking no longer exists on any current model.
- **Cache reads are ~97% of all input tokens** in real sessions (229M of 231M for Opus 5 here),
  which is why the collapsed number is off by 7× rather than by a little.
