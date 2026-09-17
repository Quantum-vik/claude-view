import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { T, statusColor, tint, toolFamily } from "./tokens";

export interface TimelineEvent {
  id: string;
  kind: "command";
  tool: string;
  command: string | null;
  status: "running" | "success" | "error" | "interrupted";
  durationMs: number | null;
  ts: number;
  output: string | null;
  /** Mirrors `TimelineEvent.agent_id` in src-tauri/src/session.rs — omitted for
   *  the parent session, set to the subagent id for a child's tool call.
   *  Subagents can be the majority of a session's work, so an unlabelled card
   *  would silently read as the parent's. */
  agentId?: string;
}

interface TimelineProps {
  events: TimelineEvent[];
}

type Filter = "all" | "ok" | "running" | "error";

function formatDuration(ms: number | null): string {
  if (ms === null) return "";
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/** Gutter glyph per status — the leading mark of each terminal line. */
function gutterGlyph(status: TimelineEvent["status"]): string {
  if (status === "success") return "✓";
  if (status === "error") return "✗";
  if (status === "running") return "●";
  return "•"; // interrupted — stopped, not failed
}

/** Last non-empty line of output — a compact at-a-glance result. */
function previewLine(output: string): string {
  const lines = output.split("\n").filter((l) => l.trim().length > 0);
  const last = lines[lines.length - 1] ?? "";
  return last.length > 80 ? last.slice(0, 80) + "…" : last;
}

/** ok / running / errors counts for the summary bar. */
function summarize(events: TimelineEvent[]) {
  let ok = 0;
  let running = 0;
  let error = 0;
  for (const e of events) {
    if (e.status === "running") running++;
    else if (e.status === "error") error++;
    else ok++; // success + interrupted read as "done, not failed"
  }
  return { ok, running, error, total: events.length };
}

/** A rendered log entry: either one command line, or a folded run of
 *  consecutive same-tool successes collapsed behind a single header. */
export type Row =
  | { kind: "single"; key: string; ev: TimelineEvent }
  | {
      kind: "group";
      key: string;
      tool: string;
      color: string;
      count: number;
      ts: number;
      items: TimelineEvent[];
    };

const CMD_LONG = 40; // a command past this length is worth expanding to read in full

// Collapsed preview line color for non-error output — a muted sage between the
// success hue and faint text, per the handoff prototype.
const PREVIEW_OK = `color-mix(in srgb, ${T.success} 40%, ${T.textFaint})`;

/** Filter by status tab + case-insensitive search over command+output+tool,
 *  then order newest-first. Applied BEFORE folding. Pure — exported for tests. */
export function filterEvents(events: TimelineEvent[], filter: Filter, query: string): TimelineEvent[] {
  const q = query.trim().toLowerCase();
  return [...events]
    .filter((e) => {
      if (filter === "ok" && !(e.status === "success" || e.status === "interrupted")) return false;
      if (filter === "running" && e.status !== "running") return false;
      if (filter === "error" && e.status !== "error") return false;
      if (q) {
        const hay = `${e.command ?? ""} ${e.output ?? ""} ${e.tool}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => b.ts - a.ts);
}

/** Fold consecutive same-tool success runs of >=3 into a group row. Errors and
 *  running lines ALWAYS break a run and render on their own — a failure is never
 *  hidden inside a fold. Pure — exported for tests. Expects `filtered` already
 *  ordered newest-first. */
export function buildRows(filtered: TimelineEvent[], grouping: boolean): Row[] {
  if (!grouping) return filtered.map((e) => ({ kind: "single", key: e.id, ev: e }));
  const out: Row[] = [];
  let i = 0;
  while (i < filtered.length) {
    const e = filtered[i];
    if (e.status === "error" || e.status === "running") {
      out.push({ kind: "single", key: e.id, ev: e });
      i++;
      continue;
    }
    let j = i + 1;
    while (
      j < filtered.length &&
      filtered[j].tool === e.tool &&
      filtered[j].status !== "error" &&
      filtered[j].status !== "running"
    ) {
      j++;
    }
    const run = filtered.slice(i, j);
    if (run.length >= 3) {
      out.push({
        kind: "group",
        key: `g_${e.id}`,
        tool: e.tool,
        color: toolFamily(e.tool).color,
        count: run.length,
        ts: run[0].ts, // newest in the run (already sorted desc)
        items: run,
      });
    } else {
      run.forEach((r) => out.push({ kind: "single", key: r.id, ev: r }));
    }
    i = j;
  }
  return out;
}

export default function Timeline({ events }: TimelineProps) {
  // The log body scrolls inside this component — a direct ref avoids walking
  // the DOM for a scroll parent on every websocket message.
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevLenRef = useRef(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Ids we've already auto-expanded (errors), so re-collapsing sticks.
  const autoHandled = useRef<Set<string>>(new Set());

  // Terminal-log controls.
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [grouping, setGrouping] = useState(true);
  const [groupOpen, setGroupOpen] = useState<Set<string>>(new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const counts = useMemo(() => summarize(events), [events]);

  // Auto-expand a card the first time it resolves to an error, so failures show
  // their output immediately without a click.
  useEffect(() => {
    const toOpen: string[] = [];
    for (const ev of events) {
      if (ev.status === "error" && ev.output && !autoHandled.current.has(ev.id)) {
        autoHandled.current.add(ev.id);
        toOpen.push(ev.id);
      }
    }
    if (toOpen.length) {
      setExpanded((prev) => {
        const next = new Set(prev);
        toOpen.forEach((id) => next.add(id));
        return next;
      });
    }
  }, [events]);

  useEffect(() => {
    const prev = prevLenRef.current;
    prevLenRef.current = events.length;
    const sc = scrollRef.current;
    if (!sc) return;

    // Newest line renders at the TOP, so "follow latest" means scrolling the
    // log body to the top — but only on first fill or a new line while the
    // user is already near the top, so reviewing older lines isn't yanked.
    const firstFill = prev === 0 && events.length > 0;
    const appended = events.length > prev;
    const nearTop = sc.scrollTop < 80;
    if (firstFill || (appended && nearTop)) {
      sc.scrollTop = 0;
    }
  }, [events]);

  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);

  // Stable handlers (functional setState only) so memoized rows don't re-render
  // when unrelated rows change.
  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleGroup = useCallback((id: string) => {
    setGroupOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const copyCommand = useCallback((command: string | null, id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      navigator.clipboard?.writeText(command ?? "");
    } catch {
      // clipboard may be unavailable (permissions); the copied flash is harmless
    }
    setCopiedId(id);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopiedId(null), 1400);
  }, []);

  // Filter + search (newest-first), then fold consecutive same-tool runs.
  const filtered = useMemo(() => filterEvents(events, filter, query), [events, filter, query]);
  const rows = useMemo(() => buildRows(filtered, grouping), [filtered, grouping]);

  // "X of Y" counts folded runs by their child count, so it reflects real lines.
  const shownCount = useMemo(
    () => rows.reduce((a, r) => a + (r.kind === "group" ? r.count : 1), 0),
    [rows]
  );

  const hasQuery = query.trim().length > 0;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        background: T.sidebar,
        fontFamily: T.mono,
      }}
    >
      {/* Header strip: Command log + shown/total + status tallies */}
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          padding: "12px 14px 10px",
          flexShrink: 0,
          borderBottom: `1px solid ${T.divider}`,
        }}
      >
        <span style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span
            style={{
              fontFamily: T.serif,
              fontSize: 13.5,
              fontWeight: 600,
              color: T.text,
              whiteSpace: "nowrap",
            }}
          >
            Command log
          </span>
          <span style={{ fontSize: 10.5, color: T.textFaint, whiteSpace: "nowrap" }}>
            {shownCount} of {counts.total}
          </span>
        </span>
        <span style={{ display: "flex", alignItems: "baseline", gap: 6, fontSize: 11 }}>
          <span style={{ color: T.success }}>✓{counts.ok}</span>
          <span style={{ color: T.running }}>●{counts.running}</span>
          <span style={{ color: T.error }}>✗{counts.error}</span>
        </span>
      </div>

      {/* Toolbar: search + filter tabs + fold toggle */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          padding: "10px 12px",
          flexShrink: 0,
          borderBottom: `1px solid ${T.divider}`,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: T.bg,
            border: `1px solid ${hasQuery ? T.accentBorder : T.border}`,
            borderRadius: 8,
            padding: "6px 10px",
          }}
        >
          <span style={{ color: T.searchGlyph, fontSize: 12, flexShrink: 0 }}>⌕</span>
          <input
            className="cv-timeline-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search the log — command, output, tool…"
            style={{
              flex: 1,
              minWidth: 0,
              background: "transparent",
              border: "none",
              outline: "none",
              color: T.text,
              fontFamily: T.mono,
              fontSize: 11.5,
            }}
          />
          {hasQuery && (
            <button
              onClick={() => setQuery("")}
              title="Clear search"
              style={{
                background: "none",
                border: "none",
                color: T.textFaint,
                cursor: "pointer",
                fontSize: 12,
                flexShrink: 0,
                padding: "0 2px",
              }}
            >
              ✕
            </button>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <FilterTab label="all" active={filter === "all"} onClick={() => setFilter("all")} />
          <FilterTab label="✓ ok" active={filter === "ok"} onClick={() => setFilter("ok")} />
          <FilterTab label="● run" active={filter === "running"} onClick={() => setFilter("running")} />
          <FilterTab label="✗ err" active={filter === "error"} onClick={() => setFilter("error")} />
          <div style={{ flex: 1 }} />
          <FilterTab
            label={`${grouping ? "⊟" : "⊞"} fold`}
            active={grouping}
            onClick={() => setGrouping((v) => !v)}
            title="Fold consecutive same-tool runs"
          />
        </div>
      </div>

      {/* Log body */}
      <div ref={scrollRef} style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "5px 0 40px" }}>
        {rows.length === 0 ? (
          <div
            style={{
              padding: "24px 16px",
              textAlign: "center",
              color: T.textFaint,
              fontSize: 12,
              lineHeight: 1.6,
              fontFamily: T.serif,
              fontStyle: "italic",
            }}
          >
            {counts.total === 0
              ? "No commands yet — the log fills in as Claude runs tools."
              : `nothing matches — clear the filter to see all ${counts.total}.`}
          </div>
        ) : (
          rows.map((row) =>
            row.kind === "single" ? (
              <SingleLine
                key={row.key}
                ev={row.ev}
                open={expanded.has(row.ev.id)}
                copied={copiedId === row.ev.id}
                onToggle={toggle}
                onCopy={copyCommand}
              />
            ) : (
              <GroupLine
                key={row.key}
                row={row}
                open={groupOpen.has(row.key)}
                onToggle={toggleGroup}
              />
            )
          )
        )}
      </div>
    </div>
  );
}

/** A filter/fold pill in the toolbar. */
function FilterTab({
  label,
  active,
  onClick,
  title,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        fontFamily: T.mono,
        fontSize: 10.5,
        fontWeight: 600,
        borderRadius: 6,
        padding: "3px 9px",
        cursor: "pointer",
        whiteSpace: "nowrap",
        flexShrink: 0,
        border: `1px solid ${active ? T.accentBorder : T.border}`,
        background: active ? T.accentSoft : T.bg,
        color: active ? T.accent : T.textDim,
      }}
    >
      {label}
    </button>
  );
}

/** A single command rendered as one terminal line. Memoized — the log
 *  re-renders on every websocket message, so unchanged rows must skip. */
const SingleLine = memo(function SingleLine({
  ev,
  open,
  copied,
  onToggle,
  onCopy,
}: {
  ev: TimelineEvent;
  open: boolean;
  copied: boolean;
  onToggle: (id: string) => void;
  onCopy: (command: string | null, id: string, e: React.MouseEvent) => void;
}) {
  const fam = toolFamily(ev.tool);
  const gutter = statusColor(ev.status);
  const isError = ev.status === "error";
  const isRunning = ev.status === "running";
  const cmdLong = (ev.command?.length ?? 0) > CMD_LONG;
  const hasMore = !!ev.output || cmdLong;

  return (
    <div
      className="cv-line"
      onClick={() => hasMore && onToggle(ev.id)}
      style={{
        display: "flex",
        gap: 8,
        padding: "6px 12px",
        cursor: hasMore ? "pointer" : "default",
        ...(isError
          ? {
              background: T.errorTint,
              borderLeft: `2px solid ${T.error}`,
              paddingLeft: 10,
            }
          : { borderLeft: "2px solid transparent" }),
      }}
    >
      {/* Status gutter */}
      <span
        style={{
          width: 16,
          flexShrink: 0,
          textAlign: "center",
          color: gutter,
          fontSize: 11,
          lineHeight: 1.6,
        }}
      >
        {isRunning ? (
          <span style={{ display: "inline-block", animation: "pulseDot 1.1s ease-in-out infinite" }}>
            ●
          </span>
        ) : (
          gutterGlyph(ev.status)
        )}
      </span>

      {/* Content column */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
        {/* Line 1: ts · tool · glyph · command · duration · copy */}
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span style={{ color: T.timestamp, fontSize: 10, flexShrink: 0 }}>
            {formatTimestamp(ev.ts)}
          </span>
          <span style={{ color: fam.color, fontWeight: 600, fontSize: 11, flexShrink: 0 }}>
            {ev.tool}
          </span>
          <span style={{ color: fam.color, opacity: 0.65, flexShrink: 0 }}>{fam.glyph}</span>
          {ev.agentId && (
            <span
              title={`Run by subagent ${ev.agentId}`}
              style={{
                color: "var(--cv-tool-task)",
                background: tint("var(--cv-tool-task)", 0.14),
                fontSize: 9.5,
                padding: "0 4px",
                borderRadius: 3,
                flexShrink: 0,
                letterSpacing: "0.04em",
              }}
            >
              » agent
            </span>
          )}
          {ev.command && (
            <span
              title={ev.command}
              style={{
                fontSize: 11.5,
                color: T.cmd,
                minWidth: 0,
                // Always one ellipsized line here — the meta row leaves only a
                // sliver of width in a narrow sidebar, and break-wrapping in it
                // stacks the command one character per line. The full command
                // renders as its own block below when the row is expanded.
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                flexShrink: 1,
              }}
            >
              {ev.command}
            </span>
          )}
          {ev.durationMs !== null && (
            <span style={{ color: T.timestamp, fontSize: 10, flexShrink: 0, marginLeft: "auto" }}>
              {formatDuration(ev.durationMs)}
            </span>
          )}
          <button
            className="cv-copy"
            onClick={(e) => onCopy(ev.command, ev.id, e)}
            title="Copy command"
            style={{
              background: "none",
              border: `1px solid ${copied ? T.success : T.border}`,
              borderRadius: 5,
              color: copied ? T.success : T.textDim,
              cursor: "pointer",
              fontSize: 9.5,
              padding: "1px 6px",
              flexShrink: 0,
              marginLeft: ev.durationMs !== null ? 0 : "auto",
              ...(copied ? { opacity: 1 } : null),
            }}
          >
            {copied ? "copied" : "copy"}
          </button>
        </div>

        {/* Expanded: the full command, wrapped across the row's whole width
            (the inline copy above stays ellipsized). Only long commands need
            this — short ones are already fully visible inline. */}
        {open && ev.command && cmdLong && (
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              fontSize: 10.5,
              lineHeight: 1.6,
              color: T.cmd,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              userSelect: "text",
              cursor: "text",
              display: "flex",
              gap: 6,
            }}
          >
            <span style={{ color: T.accentBorder, flexShrink: 0, userSelect: "none" }}>▏</span>
            <span style={{ minWidth: 0 }}>{ev.command}</span>
          </div>
        )}

        {/* Collapsed: last output line as a compact preview */}
        {!open && ev.output && (
          <div
            style={{
              fontSize: 10.5,
              color: isError ? T.errorPreview : PREVIEW_OK,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              display: "flex",
              gap: 6,
            }}
          >
            <span style={{ color: T.borderStrong }}>▏</span>
            {previewLine(ev.output)}
          </div>
        )}

        {/* Expanded: full output */}
        {open && ev.output && (
          <pre
            onClick={(e) => e.stopPropagation()}
            style={{
              margin: "1px 0 2px",
              padding: "7px 9px",
              background: isError ? T.errorTint : T.bg,
              border: `1px solid ${isError ? T.errorBorder : T.divider}`,
              borderRadius: 6,
              fontFamily: T.mono,
              fontSize: 10,
              lineHeight: 1.6,
              color: isError ? T.errorText : T.textDim,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: 180,
              overflowY: "auto",
              userSelect: "text",
              cursor: "text",
            }}
          >
            {ev.output}
          </pre>
        )}
      </div>
    </div>
  );
});

/** A folded run of consecutive same-tool successes. Memoized like SingleLine. */
const GroupLine = memo(function GroupLine({
  row,
  open,
  onToggle,
}: {
  row: Extract<Row, { kind: "group" }>;
  open: boolean;
  onToggle: (id: string) => void;
}) {
  return (
    <div style={{ borderLeft: `2px solid ${row.color}`, margin: "1px 0" }}>
      <div
        className="cv-line"
        onClick={() => onToggle(row.key)}
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          padding: "5px 12px 5px 10px",
          cursor: "pointer",
        }}
      >
        <span style={{ color: T.timestamp, fontSize: 10, width: 16, textAlign: "center", flexShrink: 0 }}>
          {open ? "▾" : "▸"}
        </span>
        <span style={{ color: row.color, fontWeight: 600, fontSize: 11 }}>{row.tool}</span>
        <span style={{ color: T.textDim, fontSize: 10.5 }}>{row.count} runs folded</span>
        <span style={{ color: T.timestamp, fontSize: 10, marginLeft: "auto" }}>
          {formatTimestamp(row.ts)}
        </span>
      </div>
      {open && (
        <div style={{ display: "flex", flexDirection: "column", paddingBottom: 2 }}>
          {row.items.map((it) => (
            <div
              key={it.id}
              className="cv-line"
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 8,
                padding: "2px 12px 2px 30px",
              }}
            >
              <span style={{ color: T.success, fontSize: 10, flexShrink: 0 }}>✓</span>
              <span
                style={{
                  color: T.cmdFold,
                  fontSize: 10.5,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  flex: 1,
                }}
              >
                {it.command}
              </span>
              <span style={{ color: T.timestamp, fontSize: 10, flexShrink: 0 }}>
                {formatDuration(it.durationMs)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
