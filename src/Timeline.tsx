import { useEffect, useRef, useState } from "react";

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
  const styles: React.CSSProperties = {
    display: "inline-block",
    padding: "1px 7px",
    borderRadius: 10,
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: 0.3,
    ...(status === "running"
      ? { background: "#7a5900", color: "#d29922", animation: "pulse 1.5s ease-in-out infinite" }
      : status === "success"
      ? { background: "#0f3320", color: "#2ea043" }
      : status === "interrupted"
      ? { background: "#3a3320", color: "#c8a838" }
      : { background: "#3a0a0a", color: "#f85149" }),
  };
  return <span style={styles}>{status}</span>;
}

function ToolBadge({ tool }: { tool: string }) {
  return (
    <span
      style={{
        display: "inline-block",
        background: "#2a2d3e",
        color: "#7cb9ff",
        borderRadius: 4,
        padding: "1px 6px",
        fontSize: 11,
        fontFamily: "Menlo, Monaco, 'Courier New', monospace",
        fontWeight: 600,
        marginRight: 6,
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

export default function Timeline({ events }: TimelineProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const prevLenRef = useRef(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Ids we've already auto-expanded (errors), so re-collapsing sticks.
  const autoHandled = useRef<Set<string>>(new Set());

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
    const el = bottomRef.current;
    if (!el) return;

    // Only auto-scroll the timeline's OWN scroll container (never ancestors
    // like the launcher's session list). Scroll on first fill, or when a new
    // card is appended while the user is already near the bottom — so reviewing
    // older cards or a reconnect snapshot doesn't yank the view.
    const sc = getScrollParent(el);
    if (!sc) return;
    const firstFill = prev === 0 && events.length > 0;
    const appended = events.length > prev;
    const nearBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 80;
    if (firstFill || (appended && nearBottom)) {
      sc.scrollTop = sc.scrollHeight;
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
          color: "#666",
          fontSize: 12,
          textAlign: "center",
          marginTop: 24,
        }}
      >
        No commands yet — the timeline fills in as Claude runs tools.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "8px 10px" }}>
      {events.map((ev) => {
        const isOpen = expanded.has(ev.id);
        return (
          <div
            key={ev.id}
            onClick={() => ev.output && toggle(ev.id)}
            style={{
              background: "#252526",
              border: "1px solid #333",
              borderRadius: 6,
              padding: "6px 10px",
              display: "flex",
              flexDirection: "column",
              gap: 4,
              cursor: ev.output ? "pointer" : "default",
            }}
          >
            {/* Top row: tool badge + status pill */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <ToolBadge tool={ev.tool} />
              <StatusPill status={ev.status} />
              {ev.durationMs !== null && (
                <span style={{ fontSize: 11, color: "#888", marginLeft: "auto" }}>
                  {formatDuration(ev.durationMs)}
                </span>
              )}
            </div>

            {/* Command text */}
            {ev.command && (
              <div
                title={ev.command}
                style={{
                  fontFamily: "Menlo, Monaco, 'Courier New', monospace",
                  fontSize: 11,
                  color: "#c8c8c8",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {ev.command}
              </div>
            )}

            {/* Collapsed: one-line output preview (the final line) */}
            {!isOpen && ev.output && (
              <div
                style={{
                  fontFamily: "Menlo, Monaco, 'Courier New', monospace",
                  fontSize: 10,
                  color: ev.status === "error" ? "#e0918a" : "#7f8b7f",
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
                  margin: 0,
                  padding: "6px 8px",
                  background: "#1a1a1b",
                  border: "1px solid #2c2c2c",
                  borderRadius: 4,
                  fontFamily: "Menlo, Monaco, 'Courier New', monospace",
                  fontSize: 10,
                  lineHeight: 1.5,
                  color: "#b8b8b8",
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
            <div style={{ display: "flex", alignItems: "center", fontSize: 10, color: "#555" }}>
              <span>{formatTimestamp(ev.ts)}</span>
              {ev.output && (
                <span style={{ marginLeft: "auto", color: "#666" }}>
                  {isOpen ? "▾ hide output" : "▸ show output"}
                </span>
              )}
            </div>
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
