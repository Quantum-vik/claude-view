/**
 * AgentWindow.tsx
 * ---------------
 * One agent run, in its own window.
 *
 * A run is not a session: there is no PTY behind it, so there is nothing to
 * type into and nothing to resize — this window is read-only by construction,
 * not by policy. What a run *does* have is its own transcript, its own context
 * window, its own model and its own cost, which is why it earns a window rather
 * than staying a filtered slice of its parent's trace.
 *
 * It is addressed by the PARENT's viewer id plus the agent id: a run has no
 * registry entry, and its transcript is resolved from the parent's exactly as
 * the roster does it.
 */

import { useMemo } from "react";
import { T, tint } from "./tokens";
import Trace from "./Trace";
import { useRoster } from "./Agents";
import { CAVEAT } from "./pricing";
import {
  formatDuration,
  formatRunUsd,
  idleMs,
  priceRoster,
  runLabel,
  type RunStatus,
} from "./agents";

const params = new URLSearchParams(window.location.search);

export default function AgentWindow() {
  const vid = params.get("vid") ?? "";
  const agentId = params.get("agent") ?? "";
  const { roster, loading } = useRoster(vid);

  const run = useMemo(
    () => roster.runs.find((r) => r.id === agentId),
    [roster.runs, agentId],
  );
  // Priced against the same roster the parent window shows, so the two windows
  // can never quote different dollars for the same run.
  const priced = useMemo(
    () => priceRoster(roster, null).runs.find((r) => r.id === agentId),
    [roster, agentId],
  );

  if (!run) {
    return (
      <div style={SHELL}>
        <div style={{ padding: 22, color: T.textDim, font: `13px ${T.serif}`, maxWidth: "60ch" }}>
          {loading ? (
            "Reading the transcript…"
          ) : (
            <>
              <b style={{ color: T.running }}>This agent run is no longer in the session.</b>
              <div style={{ marginTop: 8, fontSize: 12.5, lineHeight: 1.6 }}>
                Its transcript may have been removed, or the parent session is reading a different
                one now. Nothing is lost in the parent window.
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  const idle = idleMs(run);

  return (
    <div style={SHELL}>
      <header
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 12,
          flexWrap: "wrap",
          padding: "11px 16px",
          background: T.titlebar,
          borderBottom: `1px solid ${T.border}`,
        }}
      >
        {/* The description is the run's identity and is human language, so
            serif — the rule tokens.ts sets for the whole panel. */}
        <span style={{ fontFamily: T.serif, fontSize: 16, color: T.text, lineHeight: 1.3 }}>
          {runLabel(run)}
        </span>
        <StatusPill status={run.status} idle={idle} />

        <span style={{ marginLeft: "auto", display: "flex", gap: 14, alignItems: "baseline" }}>
          {priced?.usd != null && (
            <Stat
              value={formatRunUsd(priced.usd)}
              label="notional"
              title={CAVEAT.tooltip}
              accent
            />
          )}
          <Stat value={String(run.tools)} label="tools" />
          <Stat
            value={run.endedAt > run.startedAt ? formatDuration(run.endedAt - run.startedAt) : "—"}
            label="ran for"
          />
        </span>
      </header>

      <div
        style={{
          display: "flex",
          gap: 12,
          alignItems: "baseline",
          flexWrap: "wrap",
          padding: "6px 16px",
          background: T.sidebar,
          borderBottom: `1px solid ${T.border}`,
          font: `10.5px ${T.mono}`,
          color: T.textFaint,
        }}
      >
        {run.agentType && (
          <span style={{ color: "var(--cv-tool-task)" }}>{run.agentType}</span>
        )}
        {run.model && <span>{run.model.replace(/^claude-/, "").replace(/-\d{8}$/, "")}</span>}
        <span>{run.turns} turns</span>
        {run.depth > 1 && <span>depth {run.depth}</span>}
        <span title="This run's own id, as its transcript is named on disk">
          agent-{run.id}
        </span>
        <span style={{ marginLeft: "auto" }}>read-only — a run has no terminal</span>
      </div>

      {/* Scoped to this run, so the window shows its session and nothing else.
          Reuses the parent's reader rather than a second one: a run's entries
          already carry their agent id. */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <Trace
          vid={vid}
          modelId={run.model ?? null}
          agentScope={agentId}
          onScope={() => {}}
          scopeLocked
        />
      </div>
    </div>
  );
}

function Stat({
  value,
  label,
  title,
  accent,
}: {
  value: string;
  label: string;
  title?: string;
  accent?: boolean;
}) {
  return (
    <span style={{ textAlign: "right", lineHeight: 1.2 }} title={title}>
      <b
        style={{
          display: "block",
          font: `600 14px ${T.mono}`,
          color: accent ? T.accent : T.text,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </b>
      <i
        style={{
          fontStyle: "normal",
          fontSize: 9.5,
          color: T.textFaint,
          textTransform: "uppercase",
          letterSpacing: ".08em",
        }}
      >
        {label}
      </i>
    </span>
  );
}

/** Never colour alone — a dot AND the word, same rule as the roster. */
function StatusPill({ status, idle }: { status: RunStatus; idle: number | null }) {
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
  const word = status === "running" ? "working" : status;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        font: `11px ${T.mono}`,
        color,
        background: tint(color, 0.12),
        border: `1px solid ${tint(color, 0.35)}`,
        borderRadius: 999,
        padding: "1px 9px",
        whiteSpace: "nowrap",
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: 99,
          background: "currentColor",
          animation: status === "running" ? "pulseDot 1.4s ease-in-out infinite" : undefined,
        }}
      />
      {word}
      {status === "running" && idle != null && idle > 5000 && (
        <span style={{ color: T.textFaint }}>· {formatDuration(idle)} quiet</span>
      )}
    </span>
  );
}

const SHELL: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100vh",
  background: T.surface,
  color: T.text,
  overflow: "hidden",
};
