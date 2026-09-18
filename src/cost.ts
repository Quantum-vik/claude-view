/**
 * cost.ts
 * -------
 * Turns the backend's de-duplicated token rollup into something displayable.
 *
 * The split of responsibility is deliberate. Rust counts tokens: it owns the
 * tailer, so it is the only place that can de-duplicate turns across the parent
 * transcript and every subagent file. This module prices them, because the
 * price table lives in `pricing.ts` with its own `AS_OF` date — putting a
 * second copy in Rust would give the app two sources of truth for money.
 *
 * So the wire carries tokens, never dollars.
 */

import { CAVEAT, costOfTurn, type TurnTokens } from "./pricing";

/** Per-kind token counts, matching `TokenUsage` in src-tauri/src/transcript.rs. */
export interface TokenUsage {
  input: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
}

/** One model's share of a session, matching `ModelTotal` in session.rs. */
export interface ModelTotal {
  model: string;
  turns: number;
  usage: TokenUsage;
}

/** The `cost` control frame's payload — `CostRollup` in session.rs. */
export interface CostRollup {
  turns: number;
  subagentTurns: number;
  byModel: ModelTotal[];
  total: TokenUsage;
  subagentTotal: TokenUsage;
}

export interface PricedRollup {
  /** Total USD across every model we have a price for. */
  usd: number;
  /** Turns whose model has no table entry. Counted, never costed. */
  unpricedTurns: number;
  /** Model ids that had no price, for the unpriced tooltip. */
  unpricedModels: string[];
  /** Every input-side token plus output — what "N tokens" means in the UI. */
  tokens: number;
  turns: number;
  subagentTurns: number;
  /** The subagent share of `usd`, which is routinely the majority. */
  subagentUsd: number;
  /** 0–1. Worth surfacing: measured at 64.2% of tokens on a real session. */
  subagentShare: number;
}

const EMPTY: TokenUsage = {
  input: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  output: 0,
};

function toTurnTokens(u: TokenUsage): TurnTokens {
  return {
    input: u.input,
    cacheWrite5m: u.cacheWrite5m,
    cacheWrite1h: u.cacheWrite1h,
    cacheRead: u.cacheRead,
    output: u.output,
  };
}

/** Every token that was paid for, input side and output. */
export function totalTokens(u: TokenUsage): number {
  return u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h + u.output;
}

/**
 * Price a rollup.
 *
 * Pricing is linear in tokens for a given model, so costing each model's
 * aggregate equals costing its turns individually — which is why the backend
 * can send per-model sums rather than every turn.
 *
 * The exception is per-turn modifiers (`fast`, `inferenceGeoUs`, `batch`).
 * Those are not carried in the rollup, so a session run in fast mode is
 * understated. Claude Code never batches, and geo/fast are rare enough that
 * folding them in would mean shipping every turn over the wire for a correction
 * most sessions never need.
 */
export function priceRollup(r: CostRollup): PricedRollup {
  let usd = 0;
  let unpricedTurns = 0;
  const unpricedModels: string[] = [];

  for (const m of r.byModel) {
    // "unknown" is the backend's placeholder for a turn whose transcript
    // carried no model id. Either way there is no price.
    const priced = m.model === "unknown" ? null : costOfTurn(m.model, toTurnTokens(m.usage));
    if (priced === null) {
      unpricedTurns += m.turns;
      unpricedModels.push(m.model);
      continue;
    }
    usd += priced;
  }

  // The subagent share is priced against the same models. It is a share of the
  // same turns, so it cannot be derived by re-pricing; approximate it by token
  // proportion, which is exact when a session runs one model (the common case).
  const tokens = totalTokens(r.total);
  const subTokens = totalTokens(r.subagentTotal);
  const subagentShare = tokens > 0 ? subTokens / tokens : 0;

  return {
    usd,
    unpricedTurns,
    unpricedModels,
    tokens,
    turns: r.turns,
    subagentTurns: r.subagentTurns,
    subagentUsd: usd * subagentShare,
    subagentShare,
  };
}

/** `0.004` → `¢0.4`; `1.83` → `$1.83`. Sub-cent figures read as nothing at all. */
export function formatUsd(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `¢${(usd * 100).toFixed(1)}`;
  return usd > 0 ? "<¢1" : "¢0";
}

/** The full label for a cost figure, caveat included. Never a bare number. */
export function costLabel(p: PricedRollup): string {
  const base = `${CAVEAT.prefix} ${formatUsd(p.usd)}`;
  return p.unpricedTurns > 0
    ? `${base} ${CAVEAT.unpricedRollupSuffix(p.unpricedTurns)}`
    : base;
}

export const EMPTY_USAGE = EMPTY;
