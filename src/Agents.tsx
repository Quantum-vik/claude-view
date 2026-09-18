/**
 * Agents.tsx
 * ----------
 * The Agents panel: every agent run the session spawned, named and costed.
 *
 * Decided in issue #22 by building three of these and looking at them. A band
 * of chips above the trace overflowed at eleven runs — the observed maximum,
 * not a stress case — and a proportional spine spent 132px of permanent width
 * on eleven labels that all read "Security review pl". A sorted table was the
 * only shape that showed every run, comparably, with room for the numbers.
 *
 * Two rules the prototype settled and this file must keep:
 *
 *   1. **Dollars, never tokens.** 84–94% of a run's tokens are cache reads at
 *      a tenth the rate, so volume misranks badly. The sharpest case: the one
 *      haiku run made the MOST tool calls of any run (34) for $0.113, against
 *      opus runs doing fewer for up to $3.715. Tokens invert that 33× gap.
 *   2. **Never truncate a description from the right** — see `shorten()`.
 *
 * Runs are distinguished by their text, not by colour: `dataviz`'s validator
 * failed this app's hues as a categorical palette (#17), so eleven colour-coded
 * rows were never available. Status is a dot AND a word for the same reason.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { T, tint } from "./tokens";
import { CAVEAT } from "./pricing";
import { formatUsd } from "./cost";
import {
  formatDuration,
  formatRunUsd,
  idleMs,
  priceRoster,
  runLabel,
  shorten,
  type AgentRun,
  type PricedRun,
  type Roster,
  type RunStatus,
} from "./agents";

const EMPTY: Roster = {
  runs: [],
  parentTurns: 0,
  parentUsage: { input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 },
  duplicatesFolded: 0,
};

/** How many consecutive polls a run may be missing before the row is dropped.
 *  A spawning run exists as a zero-byte file for 0.077–0.135ms, during which
 *  discovery cannot read its first line and skips it (#21). That is one poll at
 *  most, and a row that vanishes and returns reads as a bug. */
const MISSING_TOLERANCE = 2;

/** Poll the roster. Same cadence as the trace: the transcript lands a beat
 *  after the event (0.135s / 0.244s measured), so a run appears promptly
 *  without the app hammering the disk. */
export function useRoster(vid: string) {
  const [roster, setRoster] = useState<Roster>(EMPTY);
  const [loading, setLoading] = useState(true);
  /** Runs seen recently but absent from the latest poll, and for how long. */
  const missing = useRef(new Map<string, { run: AgentRun; polls: number }>());
  /** Last roster, in a ref: reading it from state would make `pull` change
   *  identity every poll and restart the interval underneath itself. */
  const last = useRef<Roster>(EMPTY);

  const pull = useCallback(async () => {
    if (!vid) return;
    try {
      const next = (await invoke("read_agents", { viewerId: vid })) as Roster;
      const present = new Set(next.runs.map((r) => r.id));

      // Carry forward anything that just blinked out, rather than tearing the
      // row down and rebuilding it a beat later.
      for (const [id, held] of missing.current) {
        if (present.has(id)) {
          missing.current.delete(id);
        } else if (held.polls + 1 >= MISSING_TOLERANCE) {
          missing.current.delete(id);
        } else {
          missing.current.set(id, { ...held, polls: held.polls + 1 });
          next.runs.push(held.run);
        }
      }
      for (const r of last.current.runs) {
        if (!present.has(r.id) && !missing.current.has(r.id)) {
          missing.current.set(r.id, { run: r, polls: 1 });
          next.runs.push(r);
        }
      }
      next.runs.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
      last.current = next;
      setRoster(next);
    } catch {
      last.current = EMPTY;
      setRoster({ ...EMPTY, unavailable: "unreadable" });
    } finally {
      setLoading(false);
    }
  }, [vid]);

  useEffect(() => {
    void pull();
    const t = setInterval(() => void pull(), 1500);
    return () => clearInterval(t);
  }, [pull]);

  return { roster, loading };
}

type SortKey = "label" | "agentType" | "model" | "status" | "tools" | "durationMs" | "usd";

const COLUMNS: { key: SortKey; label: string; right?: boolean }[] = [
  { key: "label", label: "What it was asked to do" },
  { key: "agentType", label: "Type" },
  { key: "model", label: "Model" },
  { key: "status", label: "Status" },
  { key: "tools", label: "Tools", right: true },
  { key: "durationMs", label: "Took", right: true },
  { key: "usd", label: "Cost", right: true },
];

export function Agents({
  vid,
  sessionModel,
  selected,
}: {
  vid: string;
  /** The session's dominant model — the parent half of the partition. */
  sessionModel: string | null;
  /** The run the panel is currently scoped to, if any. */
  selected: string | null;
}) {
  const { roster, loading } = useRoster(vid);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "usd", dir: -1 });
  const [failed, setFailed] = useState<string | null>(null);

  /** Open a run in its own window. Errors are shown, never swallowed: a click
   *  that silently does nothing reads as a broken button. */
  const open = useCallback(
    (agentId: string) => {
      invoke("open_agent_window", { viewerId: vid, agentId }).catch((e) =>
        setFailed(String(e)),
      );
    },
    [vid],
  );

  const priced = useMemo(() => priceRoster(roster, sessionModel), [roster, sessionModel]);

  const rows = useMemo(() => {
    const value = (r: PricedRun): string | number => {
      switch (sort.key) {
        case "label":
          return runLabel(r).toLowerCase();
        case "agentType":
          return r.agentType ?? "";
        case "model":
          return r.model ?? "";
        case "status":
          return r.status;
        // An unpriced run sorts last rather than as $0, which would rank it
        // alongside a run that genuinely cost nothing.
        case "usd":
          return r.usd ?? -1;
        default:
          return r[sort.key];
      }
    };
    return [...priced.runs].sort((a, b) => {
      const x = value(a);
      const y = value(b);
      return (x > y ? 1 : x < y ? -1 : 0) * sort.dir;
    });
  }, [priced.runs, sort]);

  if (loading && roster.runs.length === 0) {
    return <Notice>Reading the transcript…</Notice>;
  }

  // A typed absence, never an empty roster pretending nothing ran.
  if (roster.unavailable) {
    return (
      <Notice>
        {roster.unavailable === "no_transcript"
          ? "No transcript for this session yet — agent runs appear once Claude Code writes one."
          : "The transcript could not be read, so agent runs cannot be listed."}
      </Notice>
    );
  }

  if (roster.runs.length === 0) {
    return (
      <Notice>
        This session hasn’t spawned any agent runs.
        <div style={{ marginTop: 6, color: T.textFaint, fontSize: 11.5 }}>
          Most sessions don’t. When Claude delegates work to a subagent, each run appears here with
          what it was asked to do, what it cost, and whether it has finished.
        </div>
      </Notice>
    );
  }

  const maxUsd = Math.max(...priced.runs.map((r) => r.usd ?? 0), 0);

  return (
    <div style={{ padding: "12px 14px 40px" }}>
      <p
        style={{
          margin: "0 0 14px",
          maxWidth: "74ch",
          fontFamily: T.serif,
          fontSize: 12.5,
          lineHeight: 1.65,
          color: T.textDim,
        }}
      >
        These <b style={{ color: T.text }}>{priced.runs.length} runs</b> made{" "}
        <b style={{ color: T.text }}>{priced.tools} tool calls</b>
        {priced.parentUsd !== null && (
          <>
            {" "}
            and cost <b style={{ color: T.accent }}>{formatUsd(priced.runsUsd)}</b> —{" "}
            {Math.round(priced.runsShare * 100)}% of this session
          </>
        )}
        . <span style={{ color: T.textFaint }}>{CAVEAT.footer}</span>
        {priced.unpricedRuns > 0 && (
          <>
            {" "}
            <span style={{ color: T.textFaint }}>
              {priced.unpricedRuns} run{priced.unpricedRuns === 1 ? "" : "s"} on an unpriced model
              show tokens only.
            </span>
          </>
        )}
      </p>

      {failed && (
        <div
          onClick={() => setFailed(null)}
          style={{
            margin: "0 0 12px",
            padding: "7px 11px",
            background: T.errorTint,
            border: `1px solid ${T.errorBorder}`,
            borderRadius: 6,
            color: T.errorText,
            font: `11.5px ${T.mono}`,
            cursor: "pointer",
          }}
        >
          Couldn’t open that run: {failed} (click to dismiss)
        </div>
      )}

      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {COLUMNS.map((c) => (
              <th
                key={c.key}
                onClick={() =>
                  setSort((s) =>
                    s.key === c.key
                      ? { key: c.key, dir: s.dir === 1 ? -1 : 1 }
                      : { key: c.key, dir: -1 },
                  )
                }
                style={{
                  textAlign: c.right ? "right" : "left",
                  padding: "0 10px 6px 0",
                  borderBottom: `1px solid ${T.border}`,
                  font: `10px ${T.mono}`,
                  letterSpacing: ".08em",
                  textTransform: "uppercase",
                  color: sort.key === c.key ? T.textDim : T.textFaint,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  userSelect: "none",
                }}
              >
                {c.label}
                {sort.key === c.key && (sort.dir < 0 ? " ↓" : " ↑")}
              </th>
            ))}
            <th style={{ borderBottom: `1px solid ${T.border}`, padding: "0 0 6px" }} />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <Row
              key={r.id}
              run={r}
              maxUsd={maxUsd}
              selected={selected === r.id}
              onOpen={() => open(r.id)}
            />
          ))}
        </tbody>
      </table>

      {priced.duplicatesFolded > 0 && (
        <p style={{ marginTop: 14, fontSize: 11, color: T.textFaint, fontFamily: T.mono }}>
          {priced.duplicatesFolded} replayed turn{priced.duplicatesFolded === 1 ? "" : "s"} folded —
          this session was resumed, and the same turn exists in more than one transcript. Counted
          once.
        </p>
      )}
    </div>
  );
}

function Row({
  run,
  maxUsd,
  selected,
  onOpen,
}: {
  run: PricedRun;
  maxUsd: number;
  selected: boolean;
  /** Clicking a run means "open it" — anywhere on the row, not only the
   *  button. The button stays because it NAMES the action; a bare row click is
   *  not a discoverable affordance on its own. */
  onOpen: () => void;
}) {
  const [hover, setHover] = useState(false);
  const label = runLabel(run);

  return (
    <tr
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={`${label}\n\nClick to open this run in its own window.`}
      style={{
        cursor: "pointer",
        background: selected
          ? tint(T.accent, 0.12)
          : hover
            ? tint(T.accent, 0.05)
            : "transparent",
      }}
    >
      <td style={{ ...CELL, maxWidth: 380 }}>
        <div style={{ fontFamily: T.serif, fontSize: 13.5, lineHeight: 1.4, color: T.text }}>
          {/* Middle-truncated: the identifying token is at the END. */}
          {shorten(label, 64)}
        </div>
        <div style={{ marginTop: 3, display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ font: `10.5px ${T.mono}`, color: T.textFaint }}>
            agent-{run.id.slice(0, 10)}
          </span>
          {run.depth > 1 && (
            <span style={{ font: `10.5px ${T.mono}`, color: T.textFaint }}>depth {run.depth}</span>
          )}
        </div>
        <div
          style={{
            marginTop: 6,
            height: 3,
            borderRadius: 99,
            background: T.surface2,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              borderRadius: 99,
              background: T.accent,
              width: maxUsd > 0 ? `${((run.usd ?? 0) / maxUsd) * 100}%` : "0%",
            }}
          />
        </div>
      </td>
      <td style={CELL}>
        <span style={{ font: `11.5px ${T.mono}`, color: "var(--cv-tool-task)" }}>
          {run.agentType ?? "—"}
        </span>
      </td>
      <td style={CELL}>
        <span style={{ font: `10.5px ${T.mono}`, color: T.textFaint }}>
          {run.model ? run.model.replace(/^claude-/, "").replace(/-\d{8}$/, "") : "—"}
        </span>
      </td>
      <td style={CELL}>
        <StatusPill status={run.status} idle={idleMs(run)} />
      </td>
      <td style={{ ...CELL, textAlign: "right", ...NUM }}>{run.tools}</td>
      <td style={{ ...CELL, textAlign: "right", ...NUM }}>{formatDuration(run.durationMs)}</td>
      <td style={{ ...CELL, textAlign: "right", whiteSpace: "nowrap" }}>
        {run.usd === null ? (
          <span
            style={{ font: `11px ${T.mono}`, color: T.textFaint }}
            title={`No price for ${run.model ?? "an unknown model"} — tokens are counted, dollars are withheld rather than guessed.`}
          >
            Unpriced
          </span>
        ) : (
          <span
            style={{
              font: `600 12px ${T.mono}`,
              color: T.accent,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {formatRunUsd(run.usd)}
          </span>
        )}
      </td>
      <td style={{ ...CELL, textAlign: "right", whiteSpace: "nowrap" }}>
        {/* An explicit control, not a row-click: "open this run" is the thing
            people came here to do, and an invisible affordance is one nobody
            finds. Row-click still scopes the panels; this opens the run. */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
          title={`Open ${runLabel(run)} in its own window`}
          style={{
            background: hover ? tint(T.accent, 0.16) : T.surface2,
            border: `1px solid ${hover ? T.accentBorder : T.border}`,
            borderRadius: 6,
            color: hover ? T.accent : T.textDim,
            cursor: "pointer",
            font: `10.5px ${T.mono}`,
            padding: "3px 9px",
          }}
        >
          open ↗
        </button>
      </td>
    </tr>
  );
}

const STATUS_TEXT: Record<RunStatus, string> = {
  done: "done",
  stopped: "stopped",
  failed: "failed",
  running: "working",
  unknown: "unknown",
};

/** Never colour alone: a dot AND the word. The app's hues failed `dataviz`'s
 *  categorical check (#17), and a status a colourblind reader cannot read is
 *  not a status. */
function StatusPill({ status, idle }: { status: RunStatus; idle?: number | null }) {
  const color =
    status === "done"
      ? T.success
      : status === "running"
        ? T.running
        : status === "failed"
          ? T.error
          : status === "stopped"
            ? T.textDim
            : T.textFaint;
  const title =
    status === "running"
      ? "No stop notification for this run. It is probably still working — a healthy run can go 30s between records — but a session killed mid-run looks identical."
      : status === "unknown"
        ? "This run has no task call recorded, so whether it finished is unknowable."
        : status === "stopped"
          ? "The run ended before finishing — interrupted, or stopped by the harness."
          : status === "failed"
            ? "The run ended in an error."
            : "The session recorded this run stopping of its own accord. That means it ran to its end, not that it succeeded at the job.";

  return (
    <span
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        font: `10.5px ${T.mono}`,
        color,
        whiteSpace: "nowrap",
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: 99,
          background: color,
          flex: "0 0 6px",
          animation: status === "running" ? "pulseDot 1.4s ease-in-out infinite" : undefined,
        }}
      />
      {STATUS_TEXT[status]}
      {/* Silence is a measurement, not a verdict (#21). */}
      {status === "running" && idle != null && idle > 5000 && (
        <span style={{ color: T.textFaint }}>· {formatDuration(idle)} quiet</span>
      )}
    </span>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "18px 16px",
        color: T.textDim,
        fontFamily: T.serif,
        fontSize: 13,
        lineHeight: 1.6,
        maxWidth: "62ch",
      }}
    >
      {children}
    </div>
  );
}

const CELL: React.CSSProperties = {
  padding: "9px 10px 9px 0",
  borderBottom: `1px solid ${tint(T.border, 0.6)}`,
  verticalAlign: "top",
};

const NUM: React.CSSProperties = {
  font: `11.5px ${T.mono}`,
  color: T.textFaint,
  fontVariantNumeric: "tabular-nums",
};
