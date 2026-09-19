/**
 * Spend.tsx
 * ---------
 * Spend across every session on this machine — today, all time, and where it
 * went.
 *
 * The backend scans the whole transcript corpus rather than asking each session
 * for its total, because a resumed session replays earlier turns verbatim into a
 * new file. Per-session ledgers are individually correct and still sum to the
 * wrong number; de-duplication has to be global. The panel surfaces how many
 * replays were skipped for exactly that reason — it is the difference between
 * this and a simple addition.
 *
 * Money is applied here, not in Rust: the price table lives in `pricing.ts` with
 * its own `AS_OF`, and a second copy would be a second source of truth.
 */

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { T, tint } from "./tokens";
import { Button } from "./ui";
import { formatUsd, totalTokens, type TokenUsage } from "./cost";
import { CAVEAT, costOfTurn } from "./pricing";

interface Bucket {
  key: string;
  turns: number;
  usage: TokenUsage;
  tokens: number;
}

interface SpendData {
  turns: number;
  duplicatesSkipped: number;
  total: TokenUsage;
  today: TokenUsage;
  todayTurns: number;
  byModel: Bucket[];
  byRepo: Bucket[];
  byDay: Bucket[];
  transcripts: number;
  scanMs: number;
}

function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(n);
}

/** Price a bucket, or null when its model has no table entry. */
function priceBucket(b: Bucket): number | null {
  return costOfTurn(b.key, {
    input: b.usage.input,
    cacheRead: b.usage.cacheRead,
    cacheWrite5m: b.usage.cacheWrite5m,
    cacheWrite1h: b.usage.cacheWrite1h,
    output: b.usage.output,
  });
}

/**
 * Total USD across models, plus how many turns could not be priced.
 *
 * Only `byModel` can be priced: a repo or a day mixes models, and pricing a
 * mixed bucket would need the split this shape does not carry. Repo and day
 * rows show tokens, which is the honest thing they know.
 */
function priceAll(d: SpendData): { usd: number; unpricedTurns: number } {
  let usd = 0;
  let unpricedTurns = 0;
  for (const b of d.byModel) {
    const p = b.key === "unknown" ? null : priceBucket(b);
    if (p === null) unpricedTurns += b.turns;
    else usd += p;
  }
  return { usd, unpricedTurns };
}

const LABEL: React.CSSProperties = {
  fontSize: 9.5,
  color: T.textFaint,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  fontFamily: T.ui,
};

function Bar({ buckets, max }: { buckets: Bucket[]; max: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      {buckets.map((b) => (
        <div key={b.key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              flex: "0 0 108px",
              fontSize: 11,
              color: T.textDim,
              fontFamily: T.mono,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={b.key}
          >
            {b.key}
          </span>
          {/* One series, magnitude only — no categorical palette is involved,
              which matters because this theme cannot supply one that passes
              the contrast floor. */}
          <span
            style={{
              flex: 1,
              height: 5,
              background: T.surface2,
              borderRadius: 999,
              overflow: "hidden",
              minWidth: 40,
            }}
          >
            <span
              style={{
                display: "block",
                height: "100%",
                width: `${max > 0 ? Math.max(2, (b.tokens / max) * 100) : 0}%`,
                background: T.accent,
                borderRadius: 999,
              }}
            />
          </span>
          <span
            style={{
              flex: "0 0 58px",
              textAlign: "right",
              fontSize: 10.5,
              color: T.textFaint,
              fontFamily: T.mono,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {fmtTokens(b.tokens)}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function Spend() {
  const [data, setData] = useState<SpendData | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setData((await invoke("session_spend")) as SpendData);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  // Once on mount, and on demand after that. The scan reads every transcript on
  // disk (~500 ms over 40 MB here), so it is not something to poll.
  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <span style={{ fontSize: 11, color: T.error, fontFamily: T.mono }} title={error}>
        spend unavailable
      </span>
    );
  }
  if (!data) {
    return (
      <span style={{ fontSize: 11, color: T.textFaint, fontFamily: T.mono }}>
        {busy ? "counting…" : ""}
      </span>
    );
  }

  const { usd, unpricedTurns } = priceAll(data);
  const todayUsd =
    totalTokens(data.total) > 0 ? usd * (totalTokens(data.today) / totalTokens(data.total)) : 0;
  const maxModel = Math.max(1, ...data.byModel.map((b) => b.tokens));
  const maxRepo = Math.max(1, ...data.byRepo.map((b) => b.tokens));
  const maxDay = Math.max(1, ...data.byDay.map((b) => b.tokens));

  return (
    <div style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        title={`${CAVEAT.tooltip}\n\nAcross ${data.transcripts} transcripts on this machine.`}
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 7,
          background: open ? tint(T.accent, 0.12) : T.surface2,
          border: `1px solid ${open ? T.borderAccent : T.border}`,
          borderRadius: 8,
          padding: "5px 11px",
          cursor: "pointer",
          fontFamily: T.mono,
        }}
      >
        <span style={LABEL}>today</span>
        <b style={{ color: T.accent, fontSize: 13, fontWeight: 600 }}>{formatUsd(todayUsd)}</b>
        <span style={{ color: T.textFaint, fontSize: 10.5 }}>
          / {formatUsd(usd)} all time ▾
        </span>
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            // Anchored LEFT: this button sits at the left of the control group,
            // so a right-anchored popover runs off the window's left edge on a
            // narrow launcher — which is most of them.
            left: 0,
            top: "calc(100% + 6px)",
            zIndex: 30,
            width: 330,
            maxWidth: "calc(100vw - 32px)",
            background: T.surface1,
            border: `1px solid ${T.borderStrong}`,
            borderRadius: 10,
            boxShadow: T.windowShadow,
            padding: 14,
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <div style={{ display: "flex", gap: 16 }}>
            <div>
              <div style={LABEL}>today</div>
              <div style={{ color: T.text, font: `600 16px ${T.serif}` }}>
                {formatUsd(todayUsd)}
              </div>
              <div style={{ fontSize: 10, color: T.textFaint, fontFamily: T.mono }}>
                {data.todayTurns} turns · {fmtTokens(totalTokens(data.today))}
              </div>
            </div>
            <div>
              <div style={LABEL}>all time</div>
              <div style={{ color: T.text, font: `600 16px ${T.serif}` }}>{formatUsd(usd)}</div>
              <div style={{ fontSize: 10, color: T.textFaint, fontFamily: T.mono }}>
                {data.turns} turns · {fmtTokens(totalTokens(data.total))}
              </div>
            </div>
          </div>

          {unpricedTurns > 0 && (
            <div style={{ fontSize: 10.5, color: T.running, fontFamily: T.mono }}>
              {CAVEAT.unpricedRollupSuffix(unpricedTurns)}
            </div>
          )}

          <div>
            <div style={{ ...LABEL, marginBottom: 5 }}>by model</div>
            <Bar buckets={data.byModel.slice(0, 5)} max={maxModel} />
          </div>
          <div>
            <div style={{ ...LABEL, marginBottom: 5 }}>by directory</div>
            <Bar buckets={data.byRepo.slice(0, 5)} max={maxRepo} />
          </div>
          <div>
            <div style={{ ...LABEL, marginBottom: 5 }}>recent days</div>
            <Bar buckets={data.byDay.slice(0, 7)} max={maxDay} />
          </div>

          <div
            style={{
              borderTop: `1px solid ${T.divider}`,
              paddingTop: 8,
              fontSize: 10,
              color: T.textFaint,
              fontFamily: T.mono,
              lineHeight: 1.5,
            }}
          >
            {CAVEAT.footer}
            <br />
            {data.transcripts} transcripts · {data.scanMs}ms
            {data.duplicatesSkipped > 0 && (
              <>
                {" · "}
                <span
                  title={
                    "A resumed session replays earlier turns verbatim into a new transcript. " +
                    "Counting per file would have added these twice."
                  }
                  style={{ cursor: "help", borderBottom: `1px dotted ${T.textFaint}` }}
                >
                  {data.duplicatesSkipped} replays de-duplicated
                </span>
              </>
            )}
            <br />
            <Button variant="link" onClick={() => void load()}>
              {busy ? "rescanning…" : "↻ rescan"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
