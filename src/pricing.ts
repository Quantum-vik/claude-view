/**
 * pricing.ts
 * ----------
 * Adopted from the research on issue #13. The table is data, not logic:
 * re-verify it against the pricing page and bump AS_OF when it changes.
 *
 * Per-model list prices in USD per million tokens, for turning transcript
 * `message.usage` into a dollar figure.
 *
 * ┌───────────────────────────────────────────────────────────────────────┐
 * │ PRICES AS OF 2026-09-18                                               │
 * │ Source: https://platform.claude.com/docs/en/about-claude/pricing      │
 * │ (§ Model pricing, § Prompt caching, § Long context pricing)           │
 * └───────────────────────────────────────────────────────────────────────┘
 *
 * These are Anthropic FIRST-PARTY list prices. Bedrock and Google Cloud are
 * partner-operated with their own pricing; Claude Code does not use them, so
 * they are out of scope.
 *
 * ON A PRO/MAX SUBSCRIPTION NONE OF THIS IS BILLED. See CAVEAT below.
 */

/**
 * The date these prices were last verified against the pricing page. The UI
 * MUST surface this next to any total, so a stale table is visible rather than
 * silent. Bump it (and the CAVEAT footer) whenever PRICES changes.
 */
export const AS_OF = "2026-09-18";

/** The five token kinds that price differently. */
export interface Price {
  /** Uncached input — `usage.input_tokens`. */
  input: number;
  /** Cache write, 5-minute TTL — `usage.cache_creation.ephemeral_5m_input_tokens`. 1.25× input. */
  cacheWrite5m: number;
  /** Cache write, 1-hour TTL — `usage.cache_creation.ephemeral_1h_input_tokens`. 2× input. */
  cacheWrite1h: number;
  /** Cache read/refresh — `usage.cache_read_input_tokens`. 0.1× input (0.025× on Fable/Mythos 5.1). */
  cacheRead: number;
  /** Output, including thinking tokens — `usage.output_tokens`. */
  output: number;
}

/**
 * Keyed by NORMALIZED model id: the transcript's `message.model` with the
 * `claude-` prefix and any trailing `-YYYYMMDD` date stripped. See normalizeModelId().
 *
 * Long context: there is NO >200K premium. Every 1M-context model bills 1M at
 * standard rates with no beta header, so `sonnet[1m]` costs exactly what
 * `sonnet` costs — the alias picks a context window, not a price tier.
 */
export const PRICES: Readonly<Record<string, Price>> = {
  // ── Fable / Mythos tier ───────────────────────────────────────────────
  // NB: 5.1 cache reads are 0.025× base (a quarter of Fable 5's 0.1×). Same
  // headline $10/$50, 4× apart on cache read — the reason family fallback is unsafe.
  "fable-5-1":  { input: 10, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25, output: 50 },
  "mythos-5-1": { input: 10, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25, output: 50 },
  "fable-5":    { input: 10, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1.0,  output: 50 },
  "mythos-5":   { input: 10, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1.0,  output: 50 },

  // ── Opus tier ─────────────────────────────────────────────────────────
  "opus-5":   { input: 5,  cacheWrite5m: 6.25,  cacheWrite1h: 10, cacheRead: 0.5,  output: 25 },
  "opus-4-8": { input: 5,  cacheWrite5m: 6.25,  cacheWrite1h: 10, cacheRead: 0.5,  output: 25 },
  "opus-4-7": { input: 5,  cacheWrite5m: 6.25,  cacheWrite1h: 10, cacheRead: 0.5,  output: 25 },
  "opus-4-6": { input: 5,  cacheWrite5m: 6.25,  cacheWrite1h: 10, cacheRead: 0.5,  output: 25 },
  "opus-4-5": { input: 5,  cacheWrite5m: 6.25,  cacheWrite1h: 10, cacheRead: 0.5,  output: 25 },
  // 3× the current Opus price. Retired first-party, still reachable via old transcripts.
  "opus-4-1": { input: 15, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5,  output: 75 },
  "opus-4-0": { input: 15, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5,  output: 75 },

  // ── Sonnet tier ───────────────────────────────────────────────────────
  // Sonnet 5's $2/$10 introductory price became the standard price; the
  // scheduled 2026-09-01 rise to $3/$15 was cancelled.
  "sonnet-5":   { input: 2, cacheWrite5m: 2.5,  cacheWrite1h: 4, cacheRead: 0.2,  output: 10 },
  "sonnet-4-6": { input: 3, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3,  output: 15 },
  "sonnet-4-5": { input: 3, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3,  output: 15 },
  "sonnet-4-0": { input: 3, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3,  output: 15 },

  // ── Haiku tier ────────────────────────────────────────────────────────
  "haiku-4-5": { input: 1,    cacheWrite5m: 1.25, cacheWrite1h: 2.0,  cacheRead: 0.1,  output: 5 },
  "3-5-haiku": { input: 0.8,  cacheWrite5m: 1.0,  cacheWrite1h: 1.6,  cacheRead: 0.08, output: 4 },
};

/**
 * `claude-haiku-4-5-20251001` → `haiku-4-5`; `claude-opus-5` → `opus-5`.
 * Also tolerates Bedrock (`anthropic.`, `us.anthropic.`) and Vertex (`@date`)
 * spellings so a transcript from another surface doesn't silently go unpriced.
 */
export function normalizeModelId(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/^(?:[a-z]{2}\.)?anthropic\./, "") // bedrock region + vendor prefix
    .replace(/@\d{8}$/, "")                      // vertex snapshot
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "")                      // dated snapshot
    .replace(/-v\d+:\d+$/, "");                  // bedrock model-version suffix
}

/**
 * Look up a price. Returns null for an UNKNOWN or FUTURE model id — deliberately
 * NOT a family-prefix guess and NEVER a zero. Callers must render the labelled
 * "unpriced" state, not $0.00.
 *
 * Why no family fallback: within a single family, adjacent releases differ by up
 * to 4× on cache read (Fable 5 $1.00 → Fable 5.1 $0.25) and 3× on base input
 * (Opus 4.1 $15 → Opus 4.5 $5), all under the same family prefix. A new id is
 * exactly the case where the family price is most likely to have moved, so the
 * fallback is most wrong precisely when it is used. Family prefix is fine for
 * sizing a context window (ContextMeter's WINDOWS table); it is not fine for money.
 */
export function priceFor(modelId: string | null): Price | null {
  if (!modelId) return null;
  return PRICES[normalizeModelId(modelId)] ?? null;
}

/** The per-kind token split for one assistant turn, straight out of `message.usage`. */
export interface TurnTokens {
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
  /** `usage.server_tool_use.web_search_requests` — billed per search, not per token. */
  webSearches?: number;
  /** `usage.inference_geo === "us"` → ×1.1 on every category. */
  inferenceGeoUs?: boolean;
  /** `usage.speed === "fast"` — Opus 5 / Opus 4.8 only; replaces the base rates. */
  fast?: boolean;
  /** `usage.service_tier === "batch"` → ×0.5. Claude Code never batches. */
  batch?: boolean;
}

/** $10 per 1,000 searches. Web fetch is free. */
const WEB_SEARCH_USD = 0.01;

/** Fast mode (research preview) reprices Opus 5 / 4.8 base rates to $10 / $50. */
const FAST_MODE: Price = {
  input: 10, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1.0, output: 50,
};
const FAST_MODE_MODELS = new Set(["opus-5", "opus-4-8"]);

/**
 * Cost one turn in USD. Returns null when the model is unpriced — callers show
 * the labelled unpriced state.
 *
 * IMPORTANT — the caller must have already:
 *   1. deduped by `message.id` (Claude Code writes one JSONL line PER CONTENT
 *      BLOCK, each repeating the same `usage`; naive accumulation over-counts
 *      ~3× within a file, and resumed sessions replay ids across files), and
 *   2. NOT added `output_tokens_details.thinking_tokens` — thinking is already
 *      inside `output_tokens`.
 */
export function costOfTurn(modelId: string | null, t: TurnTokens): number | null {
  const key = modelId ? normalizeModelId(modelId) : "";
  const base = priceFor(modelId);
  if (!base) return null;

  const p = t.fast && FAST_MODE_MODELS.has(key) ? FAST_MODE : base;

  let usd =
    (t.input * p.input +
      t.cacheWrite5m * p.cacheWrite5m +
      t.cacheWrite1h * p.cacheWrite1h +
      t.cacheRead * p.cacheRead +
      t.output * p.output) /
    1_000_000;

  if (t.batch) usd *= 0.5;
  if (t.inferenceGeoUs) usd *= 1.1; // data-residency multiplier, all categories
  usd += (t.webSearches ?? 0) * WEB_SEARCH_USD; // flat, not multiplied

  return usd;
}

/**
 * CAVEAT — the exact strings the UI must use. A figure from this module is
 * NOTIONAL: on a Pro/Max subscription no per-token charge is made.
 */
export const CAVEAT = {
  /** Prefix every figure. e.g. `Notional $1.83`. */
  prefix: "Notional",
  /** Tooltip on any cost figure, and the body of the rollup's info popover. */
  tooltip:
    "Notional cost — what these tokens would have cost at Claude API list prices. " +
    "Your Claude subscription is billed at a flat rate, so this is not a bill and you were not charged this amount.",
  /** One-line footer under any total or rollup. */
  footer: "Notional · API list prices as of 18 Sep 2026 · not a bill",
  /** Shown in place of a figure when the model has no table entry. */
  unpricedLabel: "Unpriced",
  /** Tooltip for the unpriced state. Interpolate the raw transcript model id. */
  unpricedTooltip: (modelId: string) =>
    `No list price on file for “${modelId}”. Its tokens are counted but not costed, ` +
    `so totals that include this turn are understated.`,
  /** Appended to a rollup that contains unpriced turns. */
  unpricedRollupSuffix: (n: number) =>
    `+ ${n} ${n === 1 ? "turn" : "turns"} unpriced`,
} as const;
