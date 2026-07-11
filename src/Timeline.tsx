import { useEffect, useMemo, useRef, useState } from "react";
import { T, tint, statusColor } from "./tokens";

export interface TimelineEvent {
  id: string;
  kind: "command";
  tool: string;
  command: string | null;
  status: "running" | "success" | "error" | "interrupted";
  durationMs: number | null;
  ts: number;
  output: string | null;
}

interface TimelineProps {
  events: TimelineEvent[];
}

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

function StatusPill({ status }: { status: TimelineEvent["status"] }) {
  const c = statusColor(status);
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "1px 8px",
        borderRadius: 999,
        fontSize: 10.5,
        fontWeight: 600,
        color: c,
        background: tint(c, 0.13),
      }}
    >
      {status === "running" && (
        <span
          style={{
            width: 5,
            height: 5,
            borderRadius: "50%",
            background: c,
            animation: "pulseDot 1.2s ease-in-out infinite",
          }}
        />
      )}
      {status}
    </span>
  );
}

function ToolBadge({ tool }: { tool: string }) {
  return (
    <span
      style={{
        fontFamily: T.mono,
        fontSize: 11,
        fontWeight: 600,
        color: T.path,
        flexShrink: 0,
      }}
    >
      {tool}
    </span>
  );
}

function getScrollParent(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node) {
    const oy = getComputedStyle(node).overflowY;
    if ((oy === "auto" || oy === "scroll") && node.scrollHeight > node.clientHeight) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
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

const PAGE = 20;

export default function Timeline({ events }: TimelineProps) {
  const topRef = useRef<HTMLDivElement>(null);
  const prevLenRef = useRef(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Ids we've already auto-expanded (errors), so re-collapsing sticks.
  const autoHandled = useRef<Set<string>>(new Set());
  // Pagination: render only the newest `visible` cards so a long-running
  // session's timeline stays a short scroll. "Show older" reveals more.
  const [visible, setVisible] = useState(PAGE);

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
    const el = topRef.current;
    if (!el) return;

    // Newest card renders at the TOP, so "follow latest" means scrolling to the
    // top. Only scroll the timeline's OWN container (never ancestors like the
    // launcher's session list), and only on first fill or a new card while the
    // user is near the top — so reviewing older cards below isn't yanked.
    const sc = getScrollParent(el);
    if (!sc) return;
    const firstFill = prev === 0 && events.length > 0;
    const appended = events.length > prev;
    const nearTop = sc.scrollTop < 80;
    if (firstFill || (appended && nearTop)) {
      sc.scrollTop = 0;
    }
  }, [events]);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (events.length === 0) {
    return (
      <div
        style={{
          padding: 16,
          color: T.textFaint,
          fontSize: 12,
          textAlign: "center",
          marginTop: 24,
          lineHeight: 1.6,
        }}
      >
        No commands yet — the timeline fills in as Claude runs tools.
      </div>
    );
  }

  // Newest first (by start time), so the latest command is at the top and
  // older ones sink to the bottom.
  const ordered = [...events].sort((a, b) => b.ts - a.ts);
  const shown = ordered.slice(0, visible);
  const remaining = ordered.length - shown.length;

  return (
    <div>
      {/* Status summary bar: ok · running · errors at a glance. */}
      <div style={{ padding: "12px 12px 10px", borderBottom: `1px solid ${T.border}` }}>
        <div style={{ display: "flex", gap: 6 }}>
          <SummaryChip color={T.success} label={`${counts.ok} ok`} muted={counts.ok === 0} />
          <SummaryChip
            color={T.running}
            label={`${counts.running} running`}
            muted={counts.running === 0}
          />
          <SummaryChip
            color={T.error}
            label={`${counts.error} error${counts.error === 1 ? "" : "s"}`}
            muted={counts.error === 0}
          />
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "10px 12px" }}>
        <div ref={topRef} />
        {shown.map((ev) => {
          const isOpen = expanded.has(ev.id);
          const cmdLong = (ev.command?.length ?? 0) > 44;
          // Something extra to reveal on expand: full command and/or output.
          const hasMore = !!ev.output || cmdLong;
          const spine = statusColor(ev.status);
          const isError = ev.status === "error";
          return (
            <div
              key={ev.id}
              onClick={() => hasMore && toggle(ev.id)}
              style={{
                background: T.surface1,
                border: `1px solid ${isError ? "#43242a" : T.border}`,
                borderLeft: `2px solid ${spine}`,
                borderRadius: 10,
                padding: "9px 12px",
                display: "flex",
                flexDirection: "column",
                gap: 4,
                cursor: hasMore ? "pointer" : "default",
              }}
            >
              {/* Top row: tool badge + status pill + duration */}
              <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
                <ToolBadge tool={ev.tool} />
                <StatusPill status={ev.status} />
                {ev.durationMs !== null && (
                  <span style={{ fontSize: 10.5, color: T.textFaint, marginLeft: "auto" }}>
                    {formatDuration(ev.durationMs)}
                  </span>
                )}
              </div>

              {/* Command text — truncated when collapsed, full (wrapped,
                  selectable) when expanded so long commands are fully readable. */}
              {ev.command && (
                <div
                  title={ev.command}
                  onClick={isOpen ? (e) => e.stopPropagation() : undefined}
                  style={{
                    fontFamily: T.mono,
                    fontSize: 11,
                    color: "#d4d4d4",
                    ...(isOpen
                      ? {
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                          userSelect: "text",
                          cursor: "text",
                        }
                      : {
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }),
                  }}
                >
                  {ev.command}
                </div>
              )}

              {/* Collapsed: one-line output preview (the final line) */}
              {!isOpen && ev.output && (
                <div
                  style={{
                    fontFamily: T.mono,
                    fontSize: 10.5,
                    color: isError ? "#c9b0b0" : "#6c7a6c",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {previewLine(ev.output)}
                </div>
              )}

              {/* Expanded result output */}
              {isOpen && ev.output && (
                <pre
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    margin: "3px 0 0",
                    padding: "8px 9px",
                    background: T.bg,
                    border: `1px solid ${T.border}`,
                    borderRadius: 7,
                    fontFamily: T.mono,
                    fontSize: 10,
                    lineHeight: 1.55,
                    color: isError ? "#c9b0b0" : "#b8b8b8",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    maxHeight: 220,
                    overflowY: "auto",
                    userSelect: "text",
                    cursor: "text",
                  }}
                >
                  {ev.output}
                </pre>
              )}

              {/* Bottom row: timestamp + expand hint */}
              <div style={{ display: "flex", alignItems: "center", fontSize: 10, color: T.textFaint }}>
                <span>{formatTimestamp(ev.ts)}</span>
                {hasMore && (
                  <span style={{ marginLeft: "auto", color: T.textFaint }}>
                    {isOpen
                      ? "▾ collapse"
                      : ev.output
                      ? "▸ show output"
                      : "▸ full command"}
                  </span>
                )}
              </div>
            </div>
          );
        })}

        {remaining > 0 && (
          <button
            onClick={() => setVisible((v) => v + PAGE)}
            style={{
              background: T.surface1,
              border: `1px solid ${T.border}`,
              borderRadius: 8,
              color: T.textDim,
              fontSize: 11,
              fontWeight: 600,
              padding: "7px 0",
              cursor: "pointer",
            }}
          >
            Show {Math.min(PAGE, remaining)} older · {remaining} hidden
          </button>
        )}
      </div>
    </div>
  );
}

/** One segment of the status summary bar. */
function SummaryChip({ color, label, muted }: { color: string; label: string; muted: boolean }) {
  return (
    <span
      style={{
        flex: 1,
        textAlign: "center",
        fontSize: 11,
        fontWeight: 600,
        color: muted ? T.textFaint : color,
        background: muted ? "transparent" : tint(color, 0.1),
        border: muted ? `1px solid ${T.border}` : "1px solid transparent",
        borderRadius: 7,
        padding: "4px 0",
      }}
    >
      {label}
    </span>
  );
}
