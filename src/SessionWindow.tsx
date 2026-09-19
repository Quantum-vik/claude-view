import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Terminal from "./Terminal";
import type { TimelineEvent } from "./events";
import Trace from "./Trace";
import { Agents } from "./Agents";
import Changes from "./Changes";
import AgentStrip from "./AgentStrip";
import { ConnectionStatus } from "./ws";

/** Which view the side panel shows. The command log stays the default: it is
 *  what existing users know, and both the trace and the roster are newer. */
/** The panel's views. `timeline` was the command log; it merged into the
 *  Stream (#31) because Trace already contained it as a filter preset — the
 *  `tools` tab yields exactly the same content (935 against 935, measured).
 *  The alias is kept only so a stored preference or a ?panel= link from an
 *  older build still resolves instead of falling back silently. */
type Panel = "stream" | "agents" | "changes";
const asPanel = (v: string | null): Panel | null =>
  v === "agents"
    ? "agents"
    : v === "changes"
      ? "changes"
      : v === "stream" || v === "trace" || v === "timeline"
        ? "stream"
        : null;
import { DragHandle, clamp } from "./Resizer";
import { T, tint } from "./tokens";
import ContextMeter from "./ContextMeter";
import { formatUsd, priceRollup, type CostRollup, type PricedRollup } from "./cost";
import { CAVEAT } from "./pricing";
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

/** De-duplicated token totals for the session, parent AND subagents. Carries no
 *  dollar figure on purpose — the price table lives in pricing.ts, and a second
 *  copy in Rust would be a second source of truth for money. */
interface CostMsg {
  type: "cost";
  rollup: CostRollup;
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
  | CostMsg
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
// The command log was sized for a gutter. The trace panel is meant to be
// able to take the window, so the ceiling is a share of it rather than a
// fixed width that predates the panel carrying prose.
const SIDEBAR_MAX = Math.max(640, Math.round(window.innerWidth * 0.82));
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

// Model/effort injection.
//
// The switcher works by typing slash commands into the session's PTY, exactly
// as a person would. Two things about that are load-bearing, both measured
// against a live Claude Code v2.1.220 session on 2026-08-20 by driving the PTY
// over the session WebSocket and reading the rendered screen back.
//
// 1. Two commands cannot go out back to back. `/model <alias>\r` immediately
//    followed by `/effort <level>\r` loses the SECOND command outright — the
//    CLI never echoes it, never applies it, and does not even leave it in the
//    composer. Submitting a command evidently takes the input handler out of
//    play for a beat, and whatever lands in that window is dropped.
//
//        gap between the two commands      second command landed
//           0ms                              0 / 9
//           5ms                              0 / 6
//          10ms                              3 / 6   (flaky)
//          20ms                              6 / 6
//          30ms                              6 / 6
//          50ms                              9 / 9
//         100 / 200 / 400 / 800ms            always
//
//    20ms is the smallest reliable value, and it still held 6/6 with the
//    machine at load average 18 on 10 cores — so the requirement is small and
//    stable rather than load-dependent. 200ms is a 10x margin on that and
//    costs at most one barely perceptible pause per apply.
//
// 2. The command text and its Enter do NOT need to be split. A single write of
//    `"/model sonnet\r"` submitted 54/54 times in the same harness; so did
//    plain prose + `\r`, and so did a write that landed while the CLI was
//    still booting. A one-shot write is not mistaken for a paste, so one write
//    per command is both correct and simpler than typing then pressing Enter.
const INJECT_GAP_MS = 200;

/** Why this session can't be typed into right now, or null when it can.
 *
 *  Injecting mid-turn appends free text to whatever Claude is doing, and
 *  injecting at a dialog answers the dialog — `/model opus` typed into a
 *  permission prompt. So only states that positively say "the composer is
 *  free" pass. "unknown" is one of them: it means the hooks aren't installed
 *  and the backend has no state to report, and the switcher has to keep
 *  working for those sessions. */
function injectBlockReason(state: AgentState, ended: boolean): string | null {
  if (ended) return "This session has ended.";
  if (state === "working")
    return "Claude is working — switching models would type into the current turn.";
  if (state === "blocked")
    return "Claude is waiting on a prompt — switching models would answer it instead.";
  return null;
}

/** An injection sequence in flight. `cancelled` is checked at every step, so a
 *  timer that has already fired can still be discarded. */
interface InjectJob {
  cancelled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
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
  /** A session claude-view did not launch (#40): read from its transcript, with
   *  no process behind it. Read-only by construction — there is no PTY to type
   *  into or resize — exactly as an agent run's window already is. */
  const watched = params.get("watched") === "1";
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
  // Which panel the sidebar shows. The command log stays the default: it is
  // what existing users know, and the trace is the newer, heavier view.
  const [panel, setPanel] = useState<Panel>(() => {
    // An explicit ?panel= wins, so a window can be opened straight onto the
    // trace — the same way vid/port/token/cwd already configure this window.
    const wanted = asPanel(params.get("panel"));
    if (wanted) return wanted;
    try {
      return asPanel(localStorage.getItem("cv.panel")) ?? "stream";
    } catch {
      return "stream";
    }
  });

  // Which agent run the panel is scoped to (#25). Held HERE, above both the
  // trace and the command log, so flipping between them keeps the scope: a
  // filter that silently resets on a tab change is worse than no filter,
  // because the user goes on believing it is applied.
  //
  // Deliberately NOT persisted to localStorage, unlike the panel choice. Panel
  // is a preference; scope is about one session's content, and restoring a
  // stale run id onto a different session would empty the panel and read as
  // data loss.
  const [agentScope, setAgentScope] = useState<string | null>(() => params.get("agent"));

  // Keep ?agent= in the URL so "look at what this run did" is a shareable,
  // reload-stable link, the same way ?panel= already is.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (agentScope) url.searchParams.set("agent", agentScope);
    else url.searchParams.delete("agent");
    window.history.replaceState(null, "", url);
  }, [agentScope]);

  const showPanel = useCallback((p: Panel) => {
    setPanel(p);
    setSidebarOpen(true);
    try {
      localStorage.setItem("cv.panel", p);
    } catch {
      /* private window / blocked storage — the choice just won't persist */
    }
  }, []);

  /**
   * Clicking the button for the panel you are already looking at closes the
   * sidebar; clicking any other switches to it.
   *
   * EVERY panel button goes through this. The command log had this toggle
   * written inline and Trace and Agents did not, so two of the three buttons
   * looked stuck — they opened and never closed. Keeping the behaviour in one
   * place is the fix; three copies of it is how they drifted apart.
   */
  const togglePanel = useCallback(
    (p: Panel) => {
      if (sidebarOpen && panel === p) {
        setSidebarOpen(false);
        return;
      }
      showPanel(p);
    },
    [sidebarOpen, panel, showPanel],
  );
  // Committed width (used at mount); live width mutates the DOM directly
  // during drags so a resize never re-renders the tree per mousemove.
  const [sidebarWidth, setSidebarWidth] = useState(savedSidebarWidth);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const widthRef = useRef(sidebarWidth);
  const [hooksOn, setHooksOn] = useState<boolean | null>(null);
  // Raw write into this session's PTY — how the model switcher types `/model`
  // and `/effort` (see injectCommands, which owns the pacing and the gating).
  // Affects only the current session, and the CLI owns the real state; we get
  // no machine-readable confirmation back.
  const sendRef = useRef<((data: string) => void) | null>(null);
  // The session's ACTUAL model, read back from the transcript (ground truth).
  // Null until the first assistant turn. Drives the chip so a declined switch
  // never leaves a false value on screen.
  const [liveModel, setLiveModel] = useState<string | null>(null);
  // Latest context-window usage (input/output tokens) from the transcript.
  const [usage, setUsage] = useState<{ input: number; output: number } | null>(null);
  // Session-wide de-duplicated spend. Distinct from `usage` above: the meter
  // wants the LATEST turn's occupancy, cost wants the de-duplicated SUM.
  const [cost, setCost] = useState<PricedRollup | null>(null);
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

  // Was this session spawned with --dangerously-skip-permissions? The flag is
  // fixed at spawn, so one lookup at mount is enough. `list_sessions` is the
  // same source the launcher reads — a popped-out window has no props to
  // inherit it from, so it asks directly. Optional field: an older backend that
  // doesn't report it simply renders no chip.
  const [skipPerms, setSkipPerms] = useState(false);
  useEffect(() => {
    if (!vid) return;
    invoke<{ viewer_id: string; skip_permissions?: boolean }[]>("list_sessions")
      .then((list) =>
        setSkipPerms(list.find((s) => s.viewer_id === vid)?.skip_permissions ?? false)
      )
      .catch(() => {
        // backend not ready — no chip rather than a wrong one
      });
  }, [vid]);

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

  // An injected sequence outlives the click that started it, so it has to be
  // cancellable: a gap timer must never fire into a PTY that has gone away, and
  // a second Apply must supersede the first instead of interleaving with it.
  const injectRef = useRef<InjectJob | null>(null);
  // Read from inside a timer callback, which would otherwise see whatever
  // `ended` was when the sequence started.
  const endedRef = useRef(ended);
  useEffect(() => {
    endedRef.current = ended;
  }, [ended]);

  const cancelInject = useCallback(() => {
    const job = injectRef.current;
    if (!job) return;
    job.cancelled = true;
    if (job.timer !== null) clearTimeout(job.timer);
    injectRef.current = null;
  }, []);

  // Closing the tab mid-sequence must not leave a timer holding a send fn.
  useEffect(() => cancelInject, [cancelInject]);

  /** Type each command into the session, one Enter each, {@link INJECT_GAP_MS}
   *  apart.
   *
   *  Fire-and-forget on purpose. There is nothing to wait for: the `model`
   *  control message is derived from the transcript and only appears on the
   *  NEXT assistant turn, so waiting for a readback would hang forever at an
   *  idle prompt. And nothing is queued: if a command can no longer be
   *  delivered it is dropped, because applying a model switch minutes later —
   *  after the user has moved on — is worse than not applying it. */
  const injectCommands = useCallback(
    (cmds: string[]) => {
      cancelInject(); // a second Apply supersedes the first
      if (cmds.length === 0) return;
      const job: InjectJob = { cancelled: false, timer: null };
      injectRef.current = job;
      const step = (i: number) => {
        // Cancelled, unmounted, or superseded while we waited out the gap.
        if (job.cancelled || injectRef.current !== job) return;
        const send = sendRef.current;
        // The socket went away or the session died mid-sequence — stop here.
        if (!send || endedRef.current) {
          injectRef.current = null;
          return;
        }
        send(`${cmds[i]}\r`);
        if (i + 1 >= cmds.length) {
          injectRef.current = null;
          return;
        }
        job.timer = setTimeout(() => step(i + 1), INJECT_GAP_MS);
      };
      step(0);
    },
    [cancelInject]
  );

  /** Apply the staged model + effort to the session (the "Done" action).
   *  Only sends what changed. Does NOT optimistically mark the chip — the model
   *  updates from the transcript, and the CLI may prompt for confirmation. */
  function applyMenu() {
    // The Done button is disabled whenever this would block, but the agent can
    // move between the render that drew it and the click that lands on it — so
    // re-check, and refuse rather than type into a busy composer. The popover
    // stays open; its now-disabled button carries the reason.
    if (injectBlockReason(agentState, ended)) return;
    const alias = pendingModel;
    const m = modelByAlias(alias)!;
    const eff = m.supported.includes(pendingEffort) ? pendingEffort : m.defaultEffort;
    const cmds: string[] = [];
    if (alias !== aliasForModelId(liveModel)) cmds.push(`/model ${alias}`);
    if (eff !== effortByModel[alias]) cmds.push(`/effort ${eff}`);
    injectCommands(cmds);
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
      case "cost": {
        const m = msg as CostMsg;
        if (m.rollup) setCost(priceRollup(m.rollup));
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
        // Same for a half-sent /model + /effort pair — the PTY is gone, and the
        // gap timer would otherwise fire into a dead send fn.
        cancelInject();
        deliverNotify("exit", "Session ended", repo, "Submarine");
        break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, clearPending, deliverNotify, notifyDeferred, cancelInject]);

  // One merged connection/liveness state (replaces the scattered dots + badge).
  // Ended and connection trouble outrank the agent state — a "working" badge on
  // a dead socket would be a lie. With hooks off the state stays "unknown" and
  // this reads "Live", exactly as it did before.
  /** Nothing pushes for a watched session — no process to report an exit, no
   *  hooks to report a turn — so the window asks. Same cadence as the roster. */
  const [watchState, setWatchState] = useState<{ state: string; tool?: string } | null>(null);
  useEffect(() => {
    if (!watched || !vid) return;
    let alive = true;
    const pull = () =>
      invoke("session_liveness", { viewerId: vid })
        .then((v) => alive && setWatchState(v as { state: string; tool?: string }))
        .catch(() => {});
    void pull();
    const t = setInterval(pull, 1500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [watched, vid]);

  // A watched session receives no hooks (#41), so `agentState` stays Unknown
  // for life and the default branch below would label it "Live" — a claim
  // nothing supports. Its liveness is read from the transcript instead, and it
  // is never called "ended": a file that stopped growing may have ended,
  // crashed, or be thinking (see CONTEXT.md).
  const live = watched
    ? {
        color:
          watchState?.state === "live"
            ? T.success
            : watchState?.state === "guessed"
              ? T.running
              : T.idle,
        label:
          watchState?.state === "live"
            ? watchState.tool
              ? `live · ${watchState.tool}`
              : "live"
            : watchState?.state === "guessed"
              ? "live?"
              : watchState?.state === "idle"
                ? "idle"
                : "no longer live",
        pulse: watchState?.state === "live",
      }
    : ended
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
            className={live.pulse ? "cv-pulse" : undefined}
            style={{
              display: "inline-block",
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: live.color,
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

        {/* Session spend. Never a bare number: the figure is notional, and the
            subscription caveat rides along in the tooltip. */}
        {cost && cost.turns > 0 && (
          <>
            <span style={{ width: 1, height: 18, background: T.border, flexShrink: 0 }} />
            <span
              title={
                CAVEAT.tooltip +
                (cost.unpricedTurns > 0
                  ? `\n\n${CAVEAT.unpricedTooltip(cost.unpricedModels.join(", "))}`
                  : "") +
                `\n\n${cost.turns} turns` +
                (cost.subagentTurns > 0
                  ? ` · ${cost.subagentTurns} in subagents (${Math.round(cost.subagentShare * 100)}% of tokens)`
                  : "") +
                `\n${CAVEAT.footer}`
              }
              style={{
                display: "inline-flex",
                alignItems: "baseline",
                gap: 5,
                fontSize: 11,
                fontFamily: T.mono,
                color: T.textDim,
                cursor: "help",
                flexShrink: 0,
              }}
            >
              <span style={{ color: T.textFaint, fontSize: 9.5 }}>{CAVEAT.prefix}</span>
              <b style={{ color: T.accent, fontWeight: 600 }}>{formatUsd(cost.usd)}</b>
              {cost.unpricedTurns > 0 && (
                <span style={{ color: T.running, fontSize: 9.5 }}>
                  +{cost.unpricedTurns} {CAVEAT.unpricedLabel.toLowerCase()}
                </span>
              )}
            </span>
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

        {/* Permission mode. Only shown when prompts are being skipped — the
            safe case needs no badge, the dangerous one does. */}
        {skipPerms && (
          <>
            <span style={{ width: 1, height: 18, background: T.border, flexShrink: 0 }} />
            <span
              title={
                "Running with --dangerously-skip-permissions — Claude edits files " +
                "and runs shell commands in this session without asking."
              }
              style={{
                fontFamily: T.mono,
                fontSize: 10.5,
                color: T.error,
                background: T.errorTint,
                border: `1px solid ${tint(T.error, 0.35)}`,
                borderRadius: 6,
                padding: "2px 8px",
                flexShrink: 0,
                whiteSpace: "nowrap",
              }}
            >
              skip perms
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

        {/* Two views, not three: the command log merged into the Stream (#31).
            One style, built from the panel key — three hand-written copies is
            how the Trace and Agents buttons drifted out of sync with Timeline's
            toggle in the first place. */}
        {([
          ["stream", "Stream", "Everything Claude did: prompts, replies, thinking, tools, subagents, and cost"],
          ["agents", "Agents", "Every subagent this session spawned: what it was asked to do, what it cost, and whether it has finished"],
          ["changes", "Changes", "Every file this session changed on disk, measured from where the repo stood when it started"],
        ] as const).map(([key, label, hint]) => {
          const on = sidebarOpen && panel === key;
          return (
            <button
              key={key}
              onClick={() => togglePanel(key)}
              title={on ? `Hide the ${label.toLowerCase()}` : hint}
              style={{
                background: on ? T.accent : T.surface2,
                border: on ? "none" : `1px solid ${T.borderStrong}`,
                borderRadius: 8,
                color: on ? T.accentInk : T.text,
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 600,
                padding: "5px 12px",
                flexShrink: 0,
                whiteSpace: "nowrap",
                fontFamily: T.serif,
              }}
            >
              {label}
            </button>
          );
        })}

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

      {/* The agent tree, the way Claude Code's own TUI shows it. Renders
          nothing when no runs exist, which is most sessions. */}
      <AgentStrip
        vid={vid}
        scope={agentScope}
        onScope={setAgentScope}
        onShowAll={() => showPanel("agents")}
      />

      {/* Main content — command log on the LEFT, terminal on the RIGHT */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* Sidebar (command log) — Timeline owns its own header, toolbar, and
            internal scroll, so the wrapper just sizes and frames it. */}
        {sidebarOpen && (
          <div
            ref={sidebarRef}
            style={{
              // A watched session has no terminal beside the panel, so the
              // panel takes the window rather than leaving 700px of dead
              // background next to a 470px column.
              width: watched ? "100%" : sidebarWidth,
              flexShrink: 0,
              background: T.sidebar,
              borderRight: watched ? "none" : `1px solid ${T.border}`,
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
            }}
          >
            {panel === "agents" ? (
              <Agents vid={vid} sessionModel={liveModel} selected={agentScope} />
            ) : panel === "changes" ? (
              <Changes vid={vid} />
            ) : (
              <Trace
                vid={vid}
                modelId={liveModel}
                agentScope={agentScope}
                onScope={setAgentScope}
                // The hook stream is what lets the Stream show a tool as
                // RUNNING — the transcript records the call, never that it is
                // still out. Without this the merge would lose the one thing
                // the command log did better.
                events={events}
                // Newest-first while the session is live, oldest-first once it
                // has ended (#28). Derived, never a control.
                live={!ended}
              />
            )}
          </div>
        )}

        {/* Drag handle between log and terminal. Widths apply straight to the
            DOM during the drag (no per-mousemove React render); the final
            width commits + persists on mouseup. */}
        {sidebarOpen && !watched && (
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

        {/* Terminal area. A watched session has no PTY, so there is nothing to
            attach to and nothing to type into: the panel takes the whole
            window rather than leaving a dead pane beside it. */}
        {!watched && (
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
        )}
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
            // Prevent, don't fail: if typing into the session right now would
            // land in the middle of a turn or answer an open dialog, Done is
            // disabled and says why, rather than firing and corrupting the turn.
            const blocked = injectBlockReason(agentState, ended);
            const canApply = dirty && !blocked;
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

                {/* A disabled button with only a tooltip to explain itself is
                    a dead end, so the reason replaces the hint line too. */}
                <div
                  style={{
                    fontSize: 10.5,
                    color: blocked ? T.error : T.textFaint,
                    lineHeight: 1.5,
                  }}
                >
                  {blocked ?? (
                    <>
                      Applies to this session only — <b style={{ color: T.textDim }}>Done</b> sends{" "}
                      <code style={codeStyle}>/model</code> and{" "}
                      <code style={codeStyle}>/effort</code> to the running CLI.
                    </>
                  )}
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
                    disabled={!canApply}
                    title={
                      !dirty
                        ? "Nothing changed"
                        : (blocked ?? "Apply model & effort to this session")
                    }
                    style={{
                      background: canApply ? T.accent : T.surface2,
                      border: "none",
                      borderRadius: 8,
                      color: canApply ? T.accentInk : T.textFaint,
                      fontSize: 11.5,
                      fontWeight: 600,
                      padding: "6px 16px",
                      cursor: canApply ? "pointer" : "default",
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
