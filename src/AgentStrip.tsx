/**
 * AgentStrip.tsx
 * --------------
 * The agent tree, the way Claude Code's own TUI shows it:
 *
 *     ● main
 *     ○ general-purpose  Killing stray esc_run.py drivers
 *
 * A strip across the session window, above the split. It exists because the
 * Agents tab is a place you have to *go*, and "what is running right now" is
 * something you need to see without going anywhere — which is exactly what the
 * TUI gets right and a tab cannot.
 *
 * It renders nothing when a session has spawned no runs, which is most
 * sessions. Costing a permanent 30px to say "no agents" would be a bad trade
 * for the common case.
 *
 * Clicking a run OPENS it in its own window — that is what a person clicking a
 * subagent is asking for. Filtering the panels to a run lives on the trace's own
 * run header, where you are already reading that run's work. An earlier version
 * had this backwards: click filtered, double-click opened, and nobody found the
 * double-click.
 *
 * Clicking `main` clears any active filter back to the whole session.
 */

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { T, tint } from "./tokens";
import { useRoster } from "./Agents";
import { formatDuration, idleMs, runLabel, shorten, type AgentRun } from "./agents";

/**
 * How many run chips the strip shows before collapsing the rest into a count.
 *
 * The strip must never scroll sideways or clip its own counter. Measured: the
 * session window opens at 1160px and the panel/terminal split narrows it
 * further, so three chips plus `main`, the overflow count and the run total is
 * what actually fits. Eleven chips overflowed a 1,250px window and pushed the
 * counter off the edge — the same failure that killed the "band" variant in
 * issue #22, and for the same reason. The TUI solves it the same way, with a
 * `+ N` line. The Agents tab remains the complete list; this is the glance.
 */
const MAX_CHIPS = 3;

export default function AgentStrip({
  vid,
  scope,
  onScope,
  onShowAll,
}: {
  vid: string;
  /** The run the panels are filtered to, if any. */
  scope: string | null;
  onScope: (agentId: string | null) => void;
  /** Open the Agents panel — where the full list lives. */
  onShowAll?: () => void;
}) {
  const { roster } = useRoster(vid);
  const [failed, setFailed] = useState<string | null>(null);

  const open = (agentId: string) => {
    // Never swallowed: a click that silently does nothing is indistinguishable
    // from a click that did not register, and the reader blames the button.
    invoke("open_agent_window", { viewerId: vid, agentId }).catch((e) =>
      setFailed(String(e)),
    );
  };

  if (roster.runs.length === 0) return null;

  // Working runs first — they are the reason to glance at this at all — then
  // most recent. Stable within each group so the strip never reshuffles under
  // the cursor while you are reaching for a chip.
  const runs = [...roster.runs].sort((a, b) => {
    const live = (r: AgentRun) => (r.status === "running" ? 0 : 1);
    return live(a) - live(b) || b.startedAt - a.startedAt;
  });
  const working = runs.filter((r) => r.status === "running").length;
  // Always keep a selected run visible, even if it sorted past the cut — a
  // chip that vanishes because you clicked it is a bug, not a collapse.
  const shown = runs.slice(0, MAX_CHIPS);
  if (scope && !shown.some((r) => r.id === scope)) {
    const sel = runs.find((r) => r.id === scope);
    if (sel) shown.splice(MAX_CHIPS - 1, 1, sel);
  }
  const hidden = runs.length - shown.length;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 12px",
        background: T.sidebar,
        borderBottom: `1px solid ${T.border}`,
        overflow: "hidden",
        flexShrink: 0,
      }}
    >
      {/* Chips clip here, not at the strip's edge. The strip narrows with the
          panel/terminal split, and at ~820px the third chip and the counter
          both fell off. Losing a chip is fine — the Agents tab has the full
          list — but losing "N working · N runs" loses the only signal that
          there is anything more to see. */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0, overflow: "hidden" }}>
      <button
        onClick={() => onScope(null)}
        title="The parent session — everything not run by an agent"
        style={{
          ...CHIP,
          flexShrink: 0,
          background: scope === null ? tint(T.accent, 0.14) : "transparent",
          borderColor: scope === null ? tint(T.accent, 0.4) : "transparent",
          color: scope === null ? T.accent : T.textDim,
        }}
      >
        <Dot color={scope === null ? T.accent : T.textDim} filled />
        main
      </button>

      {shown.map((r) => {
        const on = scope === r.id;
        const live = r.status === "running";
        const color = live
          ? T.running
          : r.status === "failed"
            ? T.error
            : r.status === "done"
              ? T.textDim
              : T.textFaint;
        const idle = idleMs(r);
        return (
          <button
            key={r.id}
            onClick={() => open(r.id)}
            title={
              `${runLabel(r)}\n${r.agentType ?? "agent"} · ${r.status}` +
              (live && idle != null ? ` · ${formatDuration(idle)} quiet` : "") +
              `\n\nClick to open this run in its own window.`
            }
            style={{
              ...CHIP,
              flexShrink: 0,
              background: on ? tint(T.accent, 0.14) : "transparent",
              borderColor: on ? tint(T.accent, 0.4) : "transparent",
              color: on ? T.accent : T.textDim,
            }}
          >
            <Dot color={color} filled={false} pulse={live} />
            <span style={{ color: on ? T.accent : "var(--cv-tool-task)" }}>
              {r.agentType ?? "agent"}
            </span>
            {/* No CSS clipping here on purpose: `shorten` already bounds the
                length from the MIDDLE, and an `overflow: hidden` on top of it
                re-truncates from the right, which is precisely what makes two
                runs indistinguishable. */}
            <span style={{ fontFamily: T.serif, color: on ? T.accent : T.textFaint }}>
              {shorten(runLabel(r), 22)}
            </span>
          </button>
        );
      })}

      </div>

      {hidden > 0 && (
        <button
          onClick={onShowAll}
          title={`${hidden} more run${hidden === 1 ? "" : "s"} — open the Agents panel`}
          style={{
            ...CHIP,
            flexShrink: 0,
            color: T.textDim,
            borderColor: T.border,
          }}
        >
          +{hidden}
        </button>
      )}

      {failed && (
        <button
          onClick={() => setFailed(null)}
          title={`${failed} (click to dismiss)`}
          style={{ ...CHIP, flexShrink: 0, color: T.error, borderColor: T.errorBorder }}
        >
          couldn’t open ✕
        </button>
      )}

      <span
        style={{
          flexShrink: 0,
          paddingLeft: 10,
          font: `10px ${T.mono}`,
          color: working > 0 ? T.running : T.textFaint,
          whiteSpace: "nowrap",
        }}
      >
        {working > 0 ? `${working} working · ` : ""}
        {roster.runs.length} run{roster.runs.length === 1 ? "" : "s"}
      </span>
    </div>
  );
}

function Dot({ color, filled, pulse }: { color: string; filled: boolean; pulse?: boolean }) {
  return (
    <span
      style={{
        width: 7,
        height: 7,
        flex: "0 0 7px",
        borderRadius: 99,
        background: filled ? color : "transparent",
        border: filled ? "none" : `1.5px solid ${color}`,
        animation: pulse ? "pulseDot 1.4s ease-in-out infinite" : undefined,
      }}
    />
  );
}

const CHIP: React.CSSProperties = {
  // Explicit transparent background: without it a <button> inherits the user
  // agent's default grey fill, which rendered the overflow pill as a blank box.
  background: "transparent",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  border: "1px solid transparent",
  borderRadius: 999,
  padding: "2px 9px",
  font: `11px ${T.mono}`,
  cursor: "pointer",
  whiteSpace: "nowrap",
};
