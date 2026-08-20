import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Terminal from "./Terminal";
import Timeline, { TimelineEvent } from "./Timeline";
import { ConnectionStatus } from "./ws";
import { DragHandle, clamp } from "./Resizer";
import { T } from "./tokens";
import ContextMeter from "./ContextMeter";
import ThemeMenu from "./ThemeMenu";
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

/** What the agent is doing, as reported by the backend's hook-driven state
 *  machine. Broadcast only on a REAL transition, with a monotonic `seq`. */
type AgentState = "unknown" | "idle" | "working" | "blocked";

interface AgentStateMsg {
  type: "agent_state";
  state: AgentState;
  reason?: string;
  seq?: number;
  since?: number;
}

type ControlMsg =
  | BoundMsg
  | TimelineSnapshotMsg
  | TimelineEventMsg
  | ExitMsg
  | AgentStateMsg
  | { type: string };

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

// Sidebar width: the terminal-style command log reads best around 470px.
const SIDEBAR_DEFAULT = 470;
const SIDEBAR_MIN = 320;
const SIDEBAR_MAX = 640;
const SIDEBAR_KEY = "cv.sidebarWidth";

function savedSidebarWidth(): number {
  const v = Number(localStorage.getItem(SIDEBAR_KEY));
  return Number.isFinite(v) && v > 0 ? clamp(v, SIDEBAR_MIN, SIDEBAR_MAX) : SIDEBAR_DEFAULT;
}

/** Notification kinds, throttled independently — "Claude needs you" must never
 *  be swallowed by a "Claude is done" that happened to land first. */
type NotifyKind = "turn_done" | "attention" | "exit";

/** Per-kind minimum gap between pings, so a burst of hook events can't stack dings. */
const NOTIFY_THROTTLE_MS = 5000;
/** How long a cancellable ping is held before it's delivered. Long enough to
 *  catch "Stop, then you typed again"; short enough to still feel immediate. */
const NOTIFY_DEFER_MS = 1000;

/** A ping waiting out {@link NOTIFY_DEFER_MS}, still cancellable. */
interface PendingNotify {
  timer: ReturnType<typeof setTimeout>;
  /** Agent-state seq when this was scheduled — only a LATER transition counts. */
  seq: number;
  /** The state this ping describes; a transition INTO it is the one that caused
   *  it (Stop → Idle), not a reason to drop it. Anything else is. */
  describes: AgentState;
  title: string;
  body: string;
  sound: string;
}

interface SessionWindowProps {
  /** When set, connection details come from props (embedded in the launcher's
   *  split pane) instead of the window URL. */
  vid?: string;
  port?: string;
  token?: string;
  cwd?: string;
  embedded?: boolean;
  /** Is this session the pane the user can actually see? In tab mode every
   *  session is mounted at once and the inactive ones are hidden with
   *  `display: none`, so they all share one focused document — without this
   *  a background tab's notifications would be silently suppressed. Defaults
   *  to true, which is correct for a standalone session window. */
  isVisible?: boolean;
}

export default function SessionWindow(props: SessionWindowProps = {}) {
  const params = new URLSearchParams(window.location.search);
  const vid = props.vid ?? params.get("vid") ?? "";
  const port = props.port ?? params.get("port") ?? "";
  const token = props.token ?? params.get("token") ?? "";
  // URLSearchParams already percent-decodes values.
  const cwd = props.cwd ?? params.get("cwd") ?? "";
  // A standalone window is always "the visible pane" — only the launcher's tab
  // mode has hidden-but-mounted sessions, and it passes this explicitly.
  const isVisible = props.isVisible ?? true;

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [ended, setEnded] = useState(false);
  // Hook-reported agent state (see AgentState). "unknown" until the first
  // agent_state message — plain terminals and hook-less sessions stay there.
  const [agentState, setAgentState] = useState<AgentState>("unknown");
  const [connStatus, setConnStatus] = useState<ConnectionStatus>("connecting");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Committed width (used at mount); live width mutates the DOM directly
  // during drags so a resize never re-renders the tree per mousemove.
  const [sidebarWidth, setSidebarWidth] = useState(savedSidebarWidth);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const widthRef = useRef(sidebarWidth);
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

  // The popover is fixed-positioned from a rect captured at open time — a
  // window resize would leave it floating at a stale spot, so just close it.
  useEffect(() => {
    if (!menu) return;
    const onResize = () => setMenu(null);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [menu]);

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

  // Notifications.
  //
  // Three rules, each one a bug that bit:
  //
  // 1. "Am I on screen?" is not "is the app focused?". In tab mode every
  //    session is mounted in the same document, so document.hasFocus() is true
  //    for a session buried three tabs deep — precisely the case where a ping
  //    is the whole point. Suppress only when this pane is BOTH the visible one
  //    and in a focused window.
  // 2. Throttle per kind. A "done" must not swallow a "needs you" two seconds
  //    later; blocked-on-a-prompt is the more urgent of the two. `attention`
  //    also ignores the focus gate — you can be staring at a session and still
  //    not notice it's waiting on you.
  // 3. Hold and re-validate. Stop fires, you type your next prompt 400ms later,
  //    and "Claude is done" lands for a session that's already working again.
  //    So turn_done/attention wait out NOTIFY_DEFER_MS and are dropped if the
  //    backend reports the session moved on. `exit` is terminal — nothing can
  //    invalidate it, so it goes straight out.
  const isVisibleRef = useRef(isVisible);
  useEffect(() => {
    isVisibleRef.current = isVisible;
  }, [isVisible]);

  const lastNotifyRef = useRef<Record<NotifyKind, number>>({
    turn_done: 0,
    attention: 0,
    exit: 0,
  });
  const pendingNotifyRef = useRef<Partial<Record<NotifyKind, PendingNotify>>>({});
  // Latest agent-state seq, so a deferred ping knows which transitions came
  // after it. Kept in a ref (not state) — handleControl must read it live.
  const agentSeqRef = useRef(0);

  /** Actually raise the ping, applying the focus gate and the per-kind throttle.
   *  Evaluated at DELIVERY time, so switching tabs during the hold counts. */
  const deliverNotify = useCallback(
    (kind: NotifyKind, title: string, body: string, sound: string) => {
      if (kind !== "attention" && document.hasFocus() && isVisibleRef.current) return;
      const now = Date.now();
      if (now - lastNotifyRef.current[kind] < NOTIFY_THROTTLE_MS) return;
      lastNotifyRef.current[kind] = now;
      invoke("notify", { title, body, sound }).catch(() => {});
    },
    []
  );

  const clearPending = useCallback((kind: NotifyKind) => {
    const p = pendingNotifyRef.current[kind];
    if (!p) return;
    clearTimeout(p.timer);
    delete pendingNotifyRef.current[kind];
  }, []);

  /** Schedule a ping an agent-state transition can still cancel. At most one
   *  per kind is in flight; a fresh event replaces the one it supersedes. */
  const notifyDeferred = useCallback(
    (
      kind: "turn_done" | "attention",
      describes: AgentState,
      title: string,
      body: string,
      sound: string
    ) => {
      clearPending(kind);
      const timer = setTimeout(() => {
        delete pendingNotifyRef.current[kind];
        deliverNotify(kind, title, body, sound);
      }, NOTIFY_DEFER_MS);
      pendingNotifyRef.current[kind] = {
        timer,
        seq: agentSeqRef.current,
        describes,
        title,
        body,
        sound,
      };
    },
    [clearPending, deliverNotify]
  );

  // Never leave a timer running past unmount (closing a tab mid-hold).
  useEffect(() => {
    const pending = pendingNotifyRef.current;
    return () => {
      for (const p of Object.values(pending)) clearTimeout(p.timer);
    };
  }, []);

  // Stable — Terminal keeps latest via a ref, but a stable identity avoids
  // needless prop churn on every render.
  const handleControl = useCallback((raw: unknown) => {
    const msg = raw as ControlMsg;
    const repo = breadcrumb(cwd).name;
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
      case "model": {
        // "<synthetic>" marks injected stub messages in the transcript, not a
        // real model — ignore those so the chip and context meter keep the
        // last REAL model instead of showing "<synthetic>" at a bogus window.
        const m = (msg as { model?: string }).model ?? null;
        if (m === null || !m.startsWith("<")) setLiveModel(m);
        break;
      }
      case "usage": {
        const u = msg as { input?: number; output?: number };
        setUsage({ input: u.input ?? 0, output: u.output ?? 0 });
        break;
      }
      // Ground-truth state transition from the agent's own hooks. Also the
      // cancel signal for a ping still waiting out its hold.
      case "agent_state": {
        const m = msg as AgentStateMsg;
        const next = m.state ?? "unknown";
        const seq = m.seq ?? 0;
        setAgentState(next);
        // A transition that landed AFTER a ping was scheduled and that moves
        // somewhere OTHER than the state that ping describes means the
        // situation changed under it — drop it. The Stop → Idle transition
        // that caused a turn_done arrives around the same time and must not
        // count; a later Idle → Working is exactly what should.
        for (const kind of ["turn_done", "attention"] as const) {
          const p = pendingNotifyRef.current[kind];
          if (p && seq > p.seq && next !== p.describes) clearPending(kind);
        }
        agentSeqRef.current = Math.max(agentSeqRef.current, seq);
        break;
      }
      // Claude finished its turn — it's waiting on you now. Held for a beat:
      // if you're already typing the next prompt, this never fires.
      case "turn_done":
        notifyDeferred(
          "turn_done",
          "idle",
          "Claude is done",
          `${repo} — waiting for your input`,
          "Glass"
        );
        break;
      // Claude is blocked on a permission prompt / has been idle.
      case "attention":
        notifyDeferred(
          "attention",
          "blocked",
          "Claude needs attention",
          `${repo} — ${(msg as { message?: string }).message ?? "waiting on you"}`,
          "Ping"
        );
        break;
      case "exit":
        setEnded(true);
        // Whatever was pending is moot now; the session ending supersedes it.
        clearPending("turn_done");
        clearPending("attention");
        deliverNotify("exit", "Session ended", repo, "Submarine");
        break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, clearPending, deliverNotify, notifyDeferred]);

  // One merged connection/liveness state (replaces the scattered dots + badge).
  // Ended and connection trouble outrank the agent state — a "working" badge on
  // a dead socket would be a lie. With hooks off the state stays "unknown" and
  // this reads "Live", exactly as it did before.
  const live = ended
    ? { color: T.idle, label: "ended", pulse: false }
    : connStatus === "connecting"
    ? { color: T.running, label: "connecting…", pulse: false }
    : connStatus !== "open"
    ? { color: T.error, label: "disconnected", pulse: false }
    : agentState === "working"
    ? { color: T.running, label: "working", pulse: true }
    : agentState === "blocked"
    ? { color: T.error, label: "blocked", pulse: true }
    : agentState === "idle"
    ? { color: T.success, label: "idle", pulse: false }
    : { color: T.success, label: "Live", pulse: true };

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
          background: T.titlebar,
          borderBottom: `1px solid ${T.divider}`,
          flexShrink: 0,
          height: 46,
        }}
      >
        {/* Breadcrumbed cwd: dim parent + repo name in accent */}
        <span
          style={{
            display: "flex",
            alignItems: "center",
            fontFamily: T.serif,
            fontSize: 13.5,
            overflow: "hidden",
            whiteSpace: "nowrap",
            maxWidth: 340,
          }}
          title={cwd}
        >
          <span style={{ color: T.textFaint, overflow: "hidden", textOverflow: "ellipsis" }}>
            {crumb.parent}
          </span>
          <span style={{ color: T.accent, fontWeight: 600, flexShrink: 0 }}>{crumb.name}</span>
        </span>

        {/* Session ID chip */}
        {sessionId && (
          <span
            style={{
              fontSize: 10.5,
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
              <>
                <span style={{ width: 1, height: 18, background: T.border, flexShrink: 0 }} />
                <div ref={anchorRef} style={{ flexShrink: 0 }}>
                  <button
                    onClick={() => (menu ? setMenu(null) : openMenu())}
                    title="Switch model & effort for this session"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      background: menu ? T.surface2 : T.surface1,
                      border: `1px solid ${menu ? T.accentBorder : T.border}`,
                      borderRadius: 8,
                      color: T.text,
                      fontFamily: T.serif,
                      fontStyle: "italic",
                      fontSize: 12.5,
                      padding: "5px 11px",
                      cursor: "pointer",
                      whiteSpace: "nowrap",
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
                    <span style={{ color: T.textFaint, fontSize: 10, fontStyle: "normal" }}>▾</span>
                  </button>
                </div>
              </>
            );
          })()}

        {/* Sidebar toggle */}
        <button
          onClick={() => setSidebarOpen((v) => !v)}
          title={sidebarOpen ? "Hide the command log" : "Show the command log"}
          style={{
            background: sidebarOpen ? T.accent : T.surface2,
            border: sidebarOpen ? "none" : `1px solid ${T.borderStrong}`,
            borderRadius: 8,
            color: sidebarOpen ? T.accentInk : T.text,
            cursor: "pointer",
            fontSize: 12,
            fontWeight: 600,
            padding: "5px 12px",
            flexShrink: 0,
            whiteSpace: "nowrap",
          }}
        >
          Timeline
        </button>

        {/* Popped-out window only: move this session back into the main app
            as a tab (closes this window; the PTY keeps running). */}
        {!props.embedded && vid && (
          <button
            onClick={() => invoke("dock_session", { viewerId: vid }).catch(() => {})}
            title="Move this session back into the main app as a tab"
            style={{
              background: T.surface2,
              border: `1px solid ${T.borderStrong}`,
              borderRadius: 8,
              color: T.text,
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 600,
              padding: "5px 12px",
              flexShrink: 0,
              whiteSpace: "nowrap",
            }}
          >
            ⧉ Dock
          </button>
        )}

        <ThemeMenu compact />
      </div>

      {/* Main content — command log on the LEFT, terminal on the RIGHT */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* Sidebar (command log) — Timeline owns its own header, toolbar, and
            internal scroll, so the wrapper just sizes and frames it. */}
        {sidebarOpen && (
          <div
            ref={sidebarRef}
            style={{
              width: sidebarWidth,
              flexShrink: 0,
              background: T.sidebar,
              borderRight: `1px solid ${T.border}`,
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <Timeline events={events} />
          </div>
        )}

        {/* Drag handle between log and terminal. Widths apply straight to the
            DOM during the drag (no per-mousemove React render); the final
            width commits + persists on mouseup. */}
        {sidebarOpen && (
          <DragHandle
            title="Drag to resize the command log"
            onResize={(dx) => {
              widthRef.current = clamp(widthRef.current + dx, SIDEBAR_MIN, SIDEBAR_MAX);
              if (sidebarRef.current) sidebarRef.current.style.width = `${widthRef.current}px`;
            }}
            onResizeEnd={() => {
              setSidebarWidth(widthRef.current);
              localStorage.setItem(SIDEBAR_KEY, String(widthRef.current));
            }}
          />
        )}

        {/* Terminal area */}
        <div style={{ flex: 1, overflow: "hidden", background: T.bg }}>
          {vid && port && token ? (
            <Terminal
              vid={vid}
              port={port}
              token={token}
              cwd={cwd}
              onControl={handleControl}
              onStatusChange={setConnStatus}
              sendRef={sendRef}
              // Screen-scan for Claude Code's blocking dialogs (trust /
              // permission / plan), which fire no hook and would otherwise read
              // as "idle". This is the `!isTerminal` branch: the terminal-vs-
              // session split already happened upstream — main.tsx routes on
              // `kind=terminal` and Launcher on `tab.isTerminal`, and both send
              // plain shells to TerminalWindow, which leaves the prop at its
              // `false` default. So reaching this component IS !isTerminal.
              detectDialogs
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
                  width: 290,
                  background: T.surface1,
                  border: `1px solid ${T.borderStrong}`,
                  borderRadius: 12,
                  boxShadow: T.windowShadow,
                  padding: 12,
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
                            background: on ? T.accentSoft2 : T.surface2,
                            border: `1px solid ${on ? T.accentBorder : T.border}`,
                            borderRadius: 8,
                            color: on ? T.accent : T.textDim,
                            fontSize: 12,
                            fontWeight: 600,
                            padding: "5px 10px",
                            cursor: "pointer",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {m.ultracode && (
                            <span
                              style={{
                                width: 5,
                                height: 5,
                                borderRadius: "50%",
                                background: T.modelViolet,
                                flexShrink: 0,
                              }}
                            />
                          )}
                          {m.label}
                          {m.version && (
                            <span
                              style={{
                                fontWeight: 500,
                                color: on
                                  ? `color-mix(in srgb, ${T.accent} 55%, ${T.text})`
                                  : T.textFaint,
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
                      <span
                        style={{
                          color: T.textFaint,
                          fontWeight: 400,
                          fontFamily: T.ui,
                          fontSize: 11,
                        }}
                      >
                        · default
                      </span>
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
                          whiteSpace: "nowrap",
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
                  Applies to this session only — <b style={{ color: T.textDim }}>Done</b> sends{" "}
                  <code style={codeStyle}>/model</code> and <code style={codeStyle}>/effort</code> to
                  the running CLI.
                </div>

                {/* Footer: Cancel / Done — nothing switches until Done */}
                <div
                  style={{
                    display: "flex",
                    justifyContent: "flex-end",
                    gap: 8,
                    borderTop: `1px solid ${T.divider}`,
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
                      fontSize: 11.5,
                      fontWeight: 600,
                      padding: "6px 14px",
                      cursor: "pointer",
                      whiteSpace: "nowrap",
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
                      fontSize: 11.5,
                      fontWeight: 600,
                      padding: "6px 16px",
                      cursor: dirty ? "pointer" : "default",
                      whiteSpace: "nowrap",
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
  fontFamily: T.serif,
  fontSize: 12.5,
  fontWeight: 600,
  color: T.text,
  marginBottom: 8,
};

const codeStyle: React.CSSProperties = {
  fontFamily: T.mono,
  fontSize: 9.5,
  color: T.accent,
  background: T.surface2,
  borderRadius: 4,
  padding: "1px 4px",
};
