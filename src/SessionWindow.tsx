import { useState } from "react";
import Terminal from "./Terminal";
import Timeline, { TimelineEvent } from "./Timeline";
import { ConnectionStatus } from "./ws";
import { DragHandle, clamp } from "./Resizer";

interface BoundMsg {
  type: "bound";
  session_id: string;
  cwd: string;
}

interface TimelineSnapshotMsg {
  type: "timeline_snapshot";
  events: TimelineEvent[];
}

interface TimelineEventMsg {
  type: "timeline";
  event: TimelineEvent;
}

interface ExitMsg {
  type: "exit";
  code: number;
}

type ControlMsg = BoundMsg | TimelineSnapshotMsg | TimelineEventMsg | ExitMsg | { type: string };

function upsertEvent(events: TimelineEvent[], incoming: TimelineEvent): TimelineEvent[] {
  const idx = events.findIndex((e) => e.id === incoming.id);
  if (idx === -1) return [...events, incoming];
  const next = [...events];
  next[idx] = incoming;
  return next;
}

interface SessionWindowProps {
  /** When set, connection details come from props (embedded in the launcher's
   *  split pane) instead of the window URL. */
  vid?: string;
  port?: string;
  token?: string;
  cwd?: string;
  embedded?: boolean;
}

export default function SessionWindow(props: SessionWindowProps = {}) {
  const params = new URLSearchParams(window.location.search);
  const vid = props.vid ?? params.get("vid") ?? "";
  const port = props.port ?? params.get("port") ?? "";
  const token = props.token ?? params.get("token") ?? "";
  // URLSearchParams already percent-decodes values.
  const cwd = props.cwd ?? params.get("cwd") ?? "";

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [ended, setEnded] = useState(false);
  const [connStatus, setConnStatus] = useState<ConnectionStatus>("connecting");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(280);

  function handleControl(raw: unknown) {
    const msg = raw as ControlMsg;
    switch (msg.type) {
      case "bound":
        setSessionId((msg as BoundMsg).session_id);
        break;
      case "timeline_snapshot":
        setEvents((msg as TimelineSnapshotMsg).events);
        break;
      case "timeline":
        setEvents((prev) => upsertEvent(prev, (msg as TimelineEventMsg).event));
        break;
      case "exit":
        setEnded(true);
        break;
    }
  }

  const statusColor =
    connStatus === "open" ? "#2ea043" : connStatus === "connecting" ? "#d29922" : "#f85149";
  const statusLabel =
    connStatus === "open" ? "live" : connStatus === "connecting" ? "connecting…" : "disconnected";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: props.embedded ? "100%" : "100vh",
        background: "#1e1e1e",
        color: "#d4d4d4",
        fontFamily: "system-ui, sans-serif",
        overflow: "hidden",
      }}
    >
      {/* Header bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "6px 14px",
          background: "#252526",
          borderBottom: "1px solid #333",
          flexShrink: 0,
          minHeight: 38,
        }}
      >
        {/* CWD */}
        <span
          style={{
            fontFamily: "Menlo, Monaco, 'Courier New', monospace",
            fontSize: 12,
            color: "#9cdcfe",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: 300,
          }}
          title={cwd}
        >
          {cwd || "(no cwd)"}
        </span>

        {/* Session ID */}
        {sessionId && (
          <span style={{ fontSize: 11, color: "#888", fontFamily: "monospace" }}>
            #{sessionId.slice(0, 8)}
          </span>
        )}

        <div style={{ flex: 1 }} />

        {/* Ended badge */}
        {ended && (
          <span
            style={{
              background: "#3a0a0a",
              color: "#f85149",
              borderRadius: 10,
              padding: "2px 10px",
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 0.5,
            }}
          >
            ENDED
          </span>
        )}

        {/* Connection status dot */}
        <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "#888" }}>
          <span
            style={{
              display: "inline-block",
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: statusColor,
            }}
          />
          {statusLabel}
        </span>

        {/* Sidebar toggle */}
        <button
          onClick={() => setSidebarOpen((v) => !v)}
          title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          style={{
            background: "transparent",
            border: "1px solid #444",
            borderRadius: 4,
            color: "#d4d4d4",
            cursor: "pointer",
            fontSize: 13,
            padding: "2px 8px",
          }}
        >
          {sidebarOpen ? "⊟" : "⊞"} Timeline
        </button>
      </div>

      {/* Main content */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* Terminal area */}
        <div style={{ flex: 1, overflow: "hidden" }}>
          {vid && port && token ? (
            <Terminal
              vid={vid}
              port={port}
              token={token}
              cwd={cwd}
              onControl={handleControl}
              onStatusChange={setConnStatus}
            />
          ) : (
            <div style={{ padding: 24, color: "#f85149" }}>
              Missing connection parameters (vid, port, or token).
            </div>
          )}
        </div>

        {/* Drag handle between terminal and timeline */}
        {sidebarOpen && (
          <DragHandle
            title="Drag to resize the timeline"
            onResize={(dx) => setSidebarWidth((w) => clamp(w - dx, 180, 640))}
          />
        )}

        {/* Sidebar */}
        {sidebarOpen && (
          <div
            style={{
              width: sidebarWidth,
              flexShrink: 0,
              background: "#1e1e1e",
              borderLeft: "1px solid #333",
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              style={{
                padding: "6px 10px",
                fontSize: 11,
                fontWeight: 700,
                color: "#888",
                letterSpacing: 0.8,
                textTransform: "uppercase",
                borderBottom: "1px solid #2a2a2a",
              }}
            >
              Timeline
            </div>
            <Timeline events={events} />
          </div>
        )}
      </div>
    </div>
  );
}
