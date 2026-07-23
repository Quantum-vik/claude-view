import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Terminal from "./Terminal";
import Timeline, { TimelineEvent } from "./Timeline";
import { ConnectionStatus } from "./ws";
import { DragHandle, clamp } from "./Resizer";
import { T } from "./tokens";
import ContextMeter from "./ContextMeter";
import {
  MODELS,
  EFFORT_LABEL,
  modelByAlias,
  aliasForModelId,
  displayModelId,
  type Effort,
} from "./models";

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

/** Split a cwd into a dim parent prefix and the bright leaf (repo) name.
 *  Compresses a leading /Users/<name>/ or /home/<name>/ to ~/. */
function breadcrumb(cwd: string): { parent: string; name: string } {
  if (!cwd) return { parent: "", name: "(no cwd)" };
  const home = cwd.replace(/^\/(?:Users|home)\/[^/]+\//, "~/");
  const segs = home.split("/").filter(Boolean);
  const name = segs.length ? segs[segs.length - 1] : home;
  const parent = home.slice(0, home.length - name.length);
  return { parent, name };
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
  // Wider default: the terminal-style tool-log reads best around 440–470px.
  const [sidebarWidth, setSidebarWidth] = useState(460);
  const [hooksOn, setHooksOn] = useState<boolean | null>(null);
  // Model switcher: inject `/model <alias>` into this session's PTY. Affects
  // only the current session; the highlight is optimistic (the CLI owns the
  // real state, but we don't get a machine-readable confirmation back).
  const sendRef = useRef<((data: string) => void) | null>(null);
  // The session's ACTUAL model, read back from the transcript (ground truth).
  // Null until the first assistant turn. Drives the chip so a declined switch
  // never leaves a false value on screen.
  const [liveModel, setLiveModel] = useState<string | null>(null);
  // Latest context-window usage (input/output tokens) from the transcript.
  const [usage, setUsage] = useState<{ input: number; output: number } | null>(null);
  // Last effort we *requested* per alias — used only to position the slider on
  // reopen. Effort has no transcript readback, so this is a convenience memory,
  // never presented as confirmed state.
  const [effortByModel, setEffortByModel] = useState<Record<string, Effort>>({});
  // Model/effort popover: a compact header chip opens a panel with the model
  // tabs on top and the effort slider underneath. Positioned with a fixed
  // rect (read from the anchor) so overflow:hidden ancestors can't clip it.
  const anchorRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ top: number; right: number } | null>(null);
  // Staged (pending) selection inside the open popover. Nothing is sent to the
  // session until "Done" — clicking a model or dragging the slider only stages.
  const [pendingModel, setPendingModel] = useState<string>("default");
  const [pendingEffort, setPendingEffort] = useState<Effort>("high");

  function openMenu() {
    const r = anchorRef.current?.getBoundingClientRect();
    if (!r) return;
    // Seed staging from the real current model (transcript) + last-requested
    // effort (or the model's default, since effort has no readback).
    const alias = aliasForModelId(liveModel);
    const m = modelByAlias(alias)!;
    setPendingModel(alias);
    setPendingEffort(effortByModel[alias] ?? m.defaultEffort);
    setMenu({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
  }

  useEffect(() => {
    invoke<boolean>("hooks_status").then(setHooksOn).catch(() => setHooksOn(null));
  }, []);

  /** Stage a model; clamp pending effort into the new model's supported range. */
  function selectPendingModel(alias: string) {
    setPendingModel(alias);
    const m = modelByAlias(alias)!;
    setPendingEffort((prev) => (m.supported.includes(prev) ? prev : m.defaultEffort));
  }

  /** Apply the staged model + effort to the session (the "Done" action).
   *  Only sends what changed. Does NOT optimistically mark the chip — the model
   *  updates from the transcript, and the CLI may prompt for confirmation. */
  function applyMenu() {
    const alias = pendingModel;
    const m = modelByAlias(alias)!;
    const eff = m.supported.includes(pendingEffort) ? pendingEffort : m.defaultEffort;
    const send = sendRef.current;
    if (send && !ended) {
      if (alias !== aliasForModelId(liveModel)) send(`/model ${alias}\r`);
      if (eff !== effortByModel[alias]) send(`/effort ${eff}\r`);
    }
    // Remember the requested effort only to position the slider next time.
    setEffortByModel((prev) => ({ ...prev, [alias]: eff }));
    setMenu(null);
  }

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
      case "model":
        setLiveModel((msg as { model?: string }).model ?? null);
        break;
      case "usage": {
        const u = msg as { input?: number; output?: number };
        setUsage({ input: u.input ?? 0, output: u.output ?? 0 });
        break;
      }
      case "exit":
        setEnded(true);
        break;
    }
  }

  // One merged connection/liveness state (replaces the scattered dots + badge).
  const live = ended
    ? { color: T.idle, label: "ended", pulse: false }
    : connStatus === "open"
    ? { color: T.success, label: "Live", pulse: true }
    : connStatus === "connecting"
    ? { color: T.running, label: "connecting…", pulse: false }
    : { color: T.error, label: "disconnected", pulse: false };

  const crumb = breadcrumb(cwd);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: props.embedded ? "100%" : "100vh",
        background: T.surface,
        color: T.text,
        fontFamily: T.ui,
        overflow: "hidden",
      }}
    >
      {/* Header bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "0 16px",
          background: "#1a1d22",
          borderBottom: `1px solid ${T.border}`,
          flexShrink: 0,
          height: 46,
        }}
      >
        {/* Breadcrumbed cwd: dim parent + bright repo name */}
        <span
          style={{
            display: "flex",
            alignItems: "center",
            fontFamily: T.mono,
            fontSize: 12.5,
            overflow: "hidden",
            whiteSpace: "nowrap",
            maxWidth: 340,
          }}
          title={cwd}
        >
          <span style={{ color: T.textFaint, overflow: "hidden", textOverflow: "ellipsis" }}>
            {crumb.parent}
          </span>
          <span style={{ color: T.path, fontWeight: 500, flexShrink: 0 }}>{crumb.name}</span>
        </span>

        {/* Session ID chip */}
        {sessionId && (
          <span
            style={{
              fontSize: 11,
              color: T.textFaint,
              fontFamily: T.mono,
              background: T.surface2,
              borderRadius: 6,
              padding: "2px 8px",
              flexShrink: 0,
            }}
          >
            #{sessionId.slice(0, 8)}
          </span>
        )}

        <div style={{ flex: 1 }} />

        {/* Merged live/connection state */}
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            color: live.color,
            fontWeight: 500,
            flexShrink: 0,
          }}
        >
          <span
            style={{
              display: "inline-block",
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: live.color,
              animation: live.pulse ? "pulseDot 1.6s ease-in-out infinite" : undefined,
            }}
          />
          {live.label}
        </span>

        {/* Context-window meter (live, from the transcript) */}
        {usage && (
          <>
            <span style={{ width: 1, height: 18, background: T.border, flexShrink: 0 }} />
            <ContextMeter tokens={usage.input} modelId={liveModel} />
          </>
        )}

        {/* Hooks confirmation chip */}
        {hooksOn !== null && (
          <>
            <span style={{ width: 1, height: 18, background: T.border, flexShrink: 0 }} />
            <span
              style={{
                fontSize: 11.5,
                color: hooksOn ? T.success : T.textFaint,
                flexShrink: 0,
              }}
              title={
                hooksOn
                  ? "Timeline hooks are installed — cards appear live."
                  : "Hooks are off — the timeline fills in from the transcript, slightly delayed."
              }
            >
              {hooksOn ? "hooks on" : "hooks off"}
            </span>
          </>
        )}

        {/* Model + effort — compact chip opens a popover (models on top,
            effort slider underneath). Sends /model and /effort to this session. */}
        {!ended &&
          (() => {
            // Chip reflects the transcript's real model (self-correcting). Effort
            // has no readback, so it's controlled in the popover, not asserted here.
            const def = modelByAlias(aliasForModelId(liveModel));
            const chipLabel = liveModel ? displayModelId(liveModel) : "Model";
            return (
              <div ref={anchorRef} style={{ flexShrink: 0 }}>
                <button
                  onClick={() => (menu ? setMenu(null) : openMenu())}
                  title="Switch model & effort for this session"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    background: menu ? T.surface2 : T.surface1,
                    border: `1px solid ${menu ? T.borderAccent : T.border}`,
                    borderRadius: 8,
                    color: T.text,
                    fontSize: 12,
                    fontWeight: 600,
                    padding: "5px 10px",
                    cursor: "pointer",
                  }}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: def?.ultracode ? T.modelViolet : T.path,
                    }}
                  />
                  {chipLabel}
                  <span style={{ color: T.textFaint, fontSize: 10 }}>▾</span>
                </button>
              </div>
            );
          })()}

        {/* Sidebar toggle */}
        <button
          onClick={() => setSidebarOpen((v) => !v)}
          title={sidebarOpen ? "Hide timeline" : "Show timeline"}
          style={{
            background: sidebarOpen ? T.accent : T.surface2,
            border: sidebarOpen ? "none" : `1px solid ${T.borderStrong}`,
            borderRadius: 8,
            color: sidebarOpen ? T.accentInk : T.text,
            cursor: "pointer",
            fontSize: 12,
            fontWeight: 600,
            padding: "5px 11px",
            flexShrink: 0,
          }}
        >
          Timeline
        </button>
      </div>

      {/* Main content — timeline on the LEFT, terminal on the RIGHT */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* Sidebar (timeline) — Timeline owns its own header, toolbar, and
            internal scroll, so the wrapper just sizes and frames it. */}
        {sidebarOpen && (
          <div
            style={{
              width: sidebarWidth,
              flexShrink: 0,
              background: T.bg,
              borderRight: `1px solid ${T.border}`,
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <Timeline events={events} />
          </div>
        )}

        {/* Drag handle between timeline and terminal. The timeline is now to the
            LEFT of the handle, so dragging right (dx>0) widens it. */}
        {sidebarOpen && (
          <DragHandle
            title="Drag to resize the timeline"
            onResize={(dx) => setSidebarWidth((w) => clamp(w + dx, 220, 640))}
          />
        )}

        {/* Terminal area */}
        <div style={{ flex: 1, overflow: "hidden", background: "#141519" }}>
          {vid && port && token ? (
            <Terminal
              vid={vid}
              port={port}
              token={token}
              cwd={cwd}
              onControl={handleControl}
              onStatusChange={setConnStatus}
              sendRef={sendRef}
            />
          ) : (
            <div style={{ padding: 24, color: T.error }}>
              Missing connection parameters (vid, port, or token).
            </div>
          )}
        </div>
      </div>

      {/* Model + effort popover */}
      {menu && !ended && (
        <>
          {/* Click-outside backdrop */}
          <div
            onClick={() => setMenu(null)}
            style={{ position: "fixed", inset: 0, zIndex: 200 }}
          />
          {(() => {
            const model = modelByAlias(pendingModel) ?? modelByAlias("default")!;
            const supported = model.supported;
            const activeIdx = Math.max(0, supported.indexOf(pendingEffort));
            const dirty =
              pendingModel !== aliasForModelId(liveModel) ||
              pendingEffort !== (effortByModel[pendingModel] ?? model.defaultEffort);
            return (
              <div
                style={{
                  position: "fixed",
                  top: menu.top,
                  right: menu.right,
                  zIndex: 201,
                  width: 300,
                  background: T.surface1,
                  border: `1px solid ${T.borderStrong}`,
                  borderRadius: 12,
                  boxShadow: T.windowShadow,
                  padding: 14,
                  display: "flex",
                  flexDirection: "column",
                  gap: 14,
                }}
              >
                {/* Model */}
                <div>
                  <div style={panelLabelStyle}>Model</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {MODELS.map((m) => {
                      const on = pendingModel === m.alias;
                      return (
                        <button
                          key={m.alias}
                          onClick={() => selectPendingModel(m.alias)}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 5,
                            background: on ? T.borderAccent : T.surface2,
                            border: `1px solid ${on ? T.borderAccent : T.border}`,
                            borderRadius: 8,
                            color: on ? "#cfe2ff" : T.textDim,
                            fontSize: 12,
                            fontWeight: 600,
                            padding: "5px 10px",
                            cursor: "pointer",
                          }}
                        >
                          {m.ultracode && (
                            <span
                              style={{
                                width: 5,
                                height: 5,
                                borderRadius: "50%",
                                background: T.modelViolet,
                              }}
                            />
                          )}
                          {m.label}
                          {m.version && (
                            <span
                              style={{
                                fontWeight: 500,
                                color: on ? "#a9cdff" : T.textFaint,
                              }}
                            >
                              {m.version}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Effort slider: low → max, snapped to this model's range */}
                <div>
                  <div style={{ ...panelLabelStyle, display: "flex", alignItems: "baseline", gap: 8 }}>
                    <span>Effort</span>
                    <span style={{ color: T.accent, fontWeight: 700 }}>
                      {EFFORT_LABEL[supported[activeIdx]]}
                    </span>
                    {supported[activeIdx] === model.defaultEffort && (
                      <span style={{ color: T.textFaint, fontWeight: 400 }}>· default</span>
                    )}
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={supported.length - 1}
                    step={1}
                    value={activeIdx}
                    onChange={(e) => setPendingEffort(supported[Number(e.target.value)])}
                    style={{ width: "100%", accentColor: T.accent, cursor: "pointer" }}
                  />
                  {/* Tick labels under the track */}
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2 }}>
                    {supported.map((level, i) => (
                      <span
                        key={level}
                        onClick={() => setPendingEffort(level)}
                        style={{
                          fontSize: 10,
                          fontWeight: i === activeIdx ? 700 : 500,
                          color: i === activeIdx ? T.accent : T.textFaint,
                          cursor: "pointer",
                          userSelect: "none",
                        }}
                      >
                        {EFFORT_LABEL[level]}
                      </span>
                    ))}
                  </div>
                  {model.ultracode && (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        marginTop: 10,
                        fontSize: 10.5,
                        color: T.textDim,
                      }}
                      title="Ultracode = X-High plus standing permission for multi-agent workflows. Say “ultracode” in a prompt."
                    >
                      <span
                        style={{ width: 6, height: 6, borderRadius: "50%", background: T.modelViolet }}
                      />
                      Ultracode available — say “ultracode” in a prompt
                    </div>
                  )}
                </div>

                <div style={{ fontSize: 10.5, color: T.textFaint, lineHeight: 1.5 }}>
                  Applies to this session only — <b>Done</b> sends{" "}
                  <code style={codeStyle}>/model</code> and <code style={codeStyle}>/effort</code> to
                  the running CLI.
                </div>

                {/* Footer: Cancel / Done — nothing switches until Done */}
                <div
                  style={{
                    display: "flex",
                    justifyContent: "flex-end",
                    gap: 8,
                    borderTop: `1px solid ${T.border}`,
                    paddingTop: 12,
                  }}
                >
                  <button
                    onClick={() => setMenu(null)}
                    style={{
                      background: "transparent",
                      border: `1px solid ${T.borderStrong}`,
                      borderRadius: 8,
                      color: T.textDim,
                      fontSize: 12,
                      fontWeight: 600,
                      padding: "6px 14px",
                      cursor: "pointer",
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={applyMenu}
                    disabled={!dirty}
                    title={dirty ? "Apply model & effort to this session" : "Nothing changed"}
                    style={{
                      background: dirty ? T.accent : T.surface2,
                      border: "none",
                      borderRadius: 8,
                      color: dirty ? T.accentInk : T.textFaint,
                      fontSize: 12,
                      fontWeight: 600,
                      padding: "6px 16px",
                      cursor: dirty ? "pointer" : "default",
                    }}
                  >
                    Done
                  </button>
                </div>
              </div>
            );
          })()}
        </>
      )}
    </div>
  );
}

const panelLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: T.textDim,
  letterSpacing: 0.3,
  marginBottom: 8,
};

const codeStyle: React.CSSProperties = {
  fontFamily: T.mono,
  fontSize: 10,
  color: T.path,
  background: T.surface2,
  borderRadius: 4,
  padding: "1px 4px",
};
