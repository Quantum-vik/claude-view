/**
 * agents.ts
 * ---------
 * The agent-run roster, priced.
 *
 * Same split of responsibility as `cost.ts`: Rust counts tokens because it owns
 * the global, cross-file de-duplication; this module applies `pricing.ts`,
 * because the price table has an `AS_OF` date and a second copy in Rust would
 * give the app two sources of truth for money.
 *
 * An **agent run** is one spawned execution — the unit of the Agents section.
 * An **agent type** (`general-purpose`, …) is a property of a run, never a
 * thing that runs or costs money. See `CONTEXT.md`.
 */

import { costOfTurn } from "./pricing";
import { totalTokens, type TokenUsage } from "./cost";

/** Liveness, mirroring `Status` in src-tauri/src/agents.rs. */
export type RunStatus = "done" | "stopped" | "failed" | "running" | "unknown";

/** One run, mirroring `AgentRun` in src-tauri/src/agents.rs. */
export interface AgentRun {
  id: string;
  agentType?: string;
  description?: string;
  depth: number;
  parentAgentId?: string;
  toolUseId?: string;
  model?: string;
  turns: number;
  tools: number;
  usage: TokenUsage;
  startedAt: number;
  endedAt: number;
  status: RunStatus;
}

/** The whole partition, mirroring `Roster` in src-tauri/src/agents.rs. */
export interface Roster {
  runs: AgentRun[];
  parentTurns: number;
  parentUsage: TokenUsage;
  duplicatesFolded: number;
  /** Typed absence — the panel says WHICH failure, never an empty roster. */
  unavailable?: string;
}

/** A run with its price attached. `usd === null` means unpriced, never zero. */
export interface PricedRun extends AgentRun {
  usd: number | null;
  tokens: number;
  /** 0–1 of the whole session's dollars. 0 when the run is unpriced. */
  share: number;
  /** Milliseconds from its first record to its last. */
  durationMs: number;
}

export interface PricedRoster {
  runs: PricedRun[];
  /** Dollars across every priced run. */
  runsUsd: number;
  /** The parent's own dollars — the other half of the partition. */
  parentUsd: number | null;
  /** runsUsd / (runsUsd + parentUsd). 0 when the parent is unpriced. */
  runsShare: number;
  tools: number;
  unpricedRuns: number;
  duplicatesFolded: number;
}

/**
 * Price a roster.
 *
 * Each run is costed at **its own model's** rate, not the session's. That is
 * not pedantry: on the reference session ten runs were opus and one was haiku,
 * and the haiku run made the *most* tool calls of any run (34) for $0.113
 * against opus runs up to $3.715. Costing runs by a session-wide token
 * proportion — which is how `priceRollup` approximates the subagent share —
 * gets that run wrong by more than an order of magnitude. Where this module and
 * that approximation disagree, this one is right, because it has the per-run
 * model and the approximation does not.
 *
 * The parent is costed from the session's dominant model, which is the only
 * thing the roster carries for it; a parent that switched models mid-session is
 * therefore approximate, and only the `runsShare` denominator depends on it.
 */
export function priceRoster(r: Roster, parentModel: string | null): PricedRoster {
  let runsUsd = 0;
  let unpricedRuns = 0;
  let tools = 0;

  const priced = r.runs.map((run) => {
    const usd = run.model ? costOfTurn(run.model, run.usage) : null;
    if (usd === null) unpricedRuns += 1;
    else runsUsd += usd;
    tools += run.tools;
    return {
      ...run,
      usd,
      tokens: totalTokens(run.usage),
      share: 0,
      durationMs: Math.max(0, run.endedAt - run.startedAt),
    };
  });

  const parentUsd = parentModel ? costOfTurn(parentModel, r.parentUsage) : null;
  const sessionUsd = runsUsd + (parentUsd ?? 0);
  for (const run of priced) {
    run.share = sessionUsd > 0 && run.usd !== null ? run.usd / sessionUsd : 0;
  }

  return {
    runs: priced,
    runsUsd,
    parentUsd,
    runsShare: sessionUsd > 0 ? runsUsd / sessionUsd : 0,
    tools,
    unpricedRuns,
    duplicatesFolded: r.duplicatesFolded,
  };
}

/**
 * Shorten a run description, keeping BOTH ends.
 *
 * Agent descriptions share long common prefixes and carry their identifying
 * token at the end — "…group A" / "…group C", "…plugin xray" / "…plugin
 * omaplug". Measured across the 11 runs of the reference session: truncating
 * from the right at 18 characters leaves **7 of 11** distinct (3 of 11 at
 * twelve); truncating the middle leaves **11 of 11** at eighteen and 10 of 11
 * at twelve. Never truncate one from the right.
 */
export function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = (max - 1) >> 1;
  return `${text.slice(0, head)}…${text.slice(-(max - 1 - head))}`;
}

/** What to call a run in one line. The description is the identity; the hex id
 *  is a fallback for a missing sidecar, never the primary label. */
export function runLabel(run: AgentRun): string {
  return run.description?.trim() || `agent-${run.id.slice(0, 12)}`;
}

/**
 * A run's cost, for a COLUMN of them.
 *
 * `formatUsd` switches to cents below a dollar, which is right for a single
 * headline figure and wrong in a sorted column: rendered beside `$1.36`, the
 * cheapest run in the reference session read as `¢11.3` — a bigger-looking
 * number in the row the whole feature exists to point at. Money in a column
 * gets one unit and a fixed number of decimals so the digits line up and the
 * sort is visible.
 */
export function formatRunUsd(usd: number): string {
  return `$${usd.toFixed(usd >= 10 ? 2 : 3)}`;
}

/**
 * How long a run has been quiet, or null when it has stopped.
 *
 * Measured on live runs (#21): a healthy run can go **30.2 seconds** between
 * records, so silence is not death and the row must not imply it is. Saying
 * "last activity 12s ago" is a fact; saying "running" about a process that may
 * have been killed an hour ago is a guess wearing a fact's clothes.
 */
export function idleMs(run: AgentRun, now = Date.now()): number | null {
  if (run.status !== "running") return null;
  return Math.max(0, now - run.endedAt);
}

/**
 * `210000` → `3m30s`. Durations are machine language, so the caller renders
 * them in mono with tabular figures.
 *
 * Carries past an hour, because it is not only used for run length: an
 * abandoned run's quiet time is open-ended, and `4295m47s` is a number nobody
 * reads as "three days".
 */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}
