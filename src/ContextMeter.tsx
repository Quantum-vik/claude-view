import { T } from "./tokens";

// Context-window size per model family, in tokens. The token counts we show are
// exact (straight from the transcript's usage block); the PERCENTAGE is relative
// to these window sizes. Calibrated against the CLI's own meter (an Opus 4.8
// session reading 249K showed 25% → ~1M window). Tune here if a % looks off.
const WINDOWS: Array<[RegExp, number]> = [
  [/opus/i, 1_000_000],
  [/sonnet/i, 1_000_000],
  [/fable|mythos/i, 1_000_000],
  [/haiku/i, 200_000],
];
const DEFAULT_WINDOW = 200_000;

export function contextWindow(modelId: string | null): number {
  if (!modelId) return DEFAULT_WINDOW;
  for (const [re, w] of WINDOWS) if (re.test(modelId)) return w;
  return DEFAULT_WINDOW;
}

/** 248934 → "249K", 1_250_000 → "1.2M". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

/** Fill color by how full the context is — calm when low, red near the limit. */
function fillColor(pct: number): string {
  if (pct >= 0.85) return T.error;
  if (pct >= 0.6) return T.running;
  return T.success;
}

interface Props {
  /** Context tokens used (input side). */
  tokens: number;
  modelId: string | null;
  /** Bar width in px. */
  width?: number;
  /** Compact = bar + "%" only; full = "249K · 25%". */
  compact?: boolean;
}

/** A slim context-window usage meter, like the CLI's bottom bar. */
export default function ContextMeter({ tokens, modelId, width = 54, compact = false }: Props) {
  const window = contextWindow(modelId);
  const pct = Math.min(1, tokens / window);
  const color = fillColor(pct);
  const pctText = `${Math.round(pct * 100)}%`;
  const title = `Context: ${formatTokens(tokens)} of ${formatTokens(window)} (${pctText})`;
  return (
    <span
      title={title}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0 }}
    >
      <span
        style={{
          width,
          height: 4,
          background: T.surface2,
          borderRadius: 999,
          overflow: "hidden",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            display: "block",
            height: "100%",
            width: `${Math.max(3, pct * 100)}%`,
            background: color,
            borderRadius: 999,
          }}
        />
      </span>
      <span style={{ fontSize: 10.5, color: T.textFaint, fontFamily: T.mono, whiteSpace: "nowrap" }}>
        {compact ? pctText : `${formatTokens(tokens)} · ${pctText}`}
      </span>
    </span>
  );
}
