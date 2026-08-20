import { memo, useEffect, useMemo, useRef, useState, useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import SessionWindow from "./SessionWindow";
import TerminalWindow from "./TerminalWindow";
import { DragHandle, clamp } from "./Resizer";
import { T, tint } from "./tokens";
import ContextMeter from "./ContextMeter";
import ThemeMenu from "./ThemeMenu";

const PAGE_SIZE = 10;
/** Launcher width at/above which sessions embed in a right-hand pane. */
const SPLIT_MIN_WIDTH = 1100;
/** Left column width in split mode. */
const LIST_WIDTH = 640;
const LIST_MIN = 380;
/** The list content caps at 720px — wider than this is pure dead space. */
const LIST_MAX = 860;
const LIST_WIDTH_KEY = "cv.listWidth";

/** Largest list width that still leaves a usable session pane. */
function maxListWidth(): number {
  return Math.max(LIST_MIN, Math.min(LIST_MAX, window.innerWidth - 420));
}
/** Open tabs persist across restarts — reattached to still-known sessions. */
const TABS_KEY = "cv.tabs";
const ACTIVE_TAB_KEY = "cv.activeTab";

/** Hook-derived agent state (src-tauri/src/session.rs — `AgentState`). Every
 *  transition comes from Claude Code's own hooks, so this is ground truth, not
 *  a heuristic. Plain terminals never emit hooks and stay "unknown" forever. */
type AgentState = "unknown" | "idle" | "working" | "blocked";

interface SessionInfo {
  viewer_id: string;
  session_id: string | null;
  cwd: string;
  ended: boolean;
  is_terminal: boolean;
  state: AgentState;
  /** Bumped on every real transition. */
  state_seq: number;
  /** Epoch ms the current state was entered. */
  state_since: number;
  /** git COMMON dir — identical for a repo and all of its worktrees. */
  repo_key: string | null;
  repo_name: string | null;
  /** Checkout this session sits in ("app-fix" for a worktree, == repo_name for
   *  the main copy). */
  checkout_name: string | null;
  is_linked_worktree: boolean;
  /** null for a detached / reftable HEAD. */
  branch: string | null;
}

interface PastSession {
  session_id: string;
  cwd: string;
  modifiedMs: number;
  preview: string | null;
  model: string | null;
  contextTokens: number | null;
  // NOTE: camelCase on purpose — PastSession carries `#[serde(rename)]` for
  // these (matching modifiedMs / contextTokens), while the live SessionInfo
  // above has no renames and is genuinely snake_case. Optional here so an
  // older backend simply falls back to cwd grouping.
  repoKey?: string | null;
  repoName?: string | null;
  checkoutName?: string | null;
  isLinkedWorktree?: boolean;
}

interface ConnInfo {
  port: number;
  token: string;
}

interface Tab {
  vid: string;
  cwd: string;
  isTerminal: boolean;
}

/** Session-pane split layouts (tmux-style, minus tmux): one pane, two columns,
 *  two rows, or a 2×2 grid. Persisted. */
type PaneLayout = "1" | "2c" | "2r" | "4";
const LAYOUT_KEY = "cv.paneLayout";
// Split-boundary fractions (0–1) for the column / row dividers. Live drags
// write these as CSS vars on the pane area; the committed values persist.
const SPLIT_X_KEY = "cv.paneSplitX";
const SPLIT_Y_KEY = "cv.paneSplitY";
const SPLIT_MIN_FRAC = 0.15;
const SPLIT_MAX_FRAC = 0.85;

function savedFrac(key: string): number {
  const v = Number(localStorage.getItem(key));
  return Number.isFinite(v) && v >= SPLIT_MIN_FRAC && v <= SPLIT_MAX_FRAC ? v : 0.5;
}

function paneCount(l: PaneLayout): number {
  return l === "1" ? 1 : l === "4" ? 4 : 2;
}

function savedLayout(): PaneLayout {
  const v = localStorage.getItem(LAYOUT_KEY);
  return v === "2c" || v === "2r" || v === "4" ? v : "1";
}

/** Absolute rect for pane slot `i` — panes are positioned, never reparented,
 *  so a session moving between slots keeps its live terminal. Boundaries come
 *  from the `--px` / `--py` CSS vars on the pane area (default 0.5), so
 *  dragging a divider moves every pane without a React render. */
function paneRect(l: PaneLayout, i: number): React.CSSProperties {
  const X = "var(--px, 0.5)";
  const Y = "var(--py, 0.5)";
  const wL = `calc(${X} * 100%)`;
  const wR = `calc((1 - ${X}) * 100%)`;
  const hT = `calc(${Y} * 100%)`;
  const hB = `calc((1 - ${Y}) * 100%)`;
  if (l === "1") return { left: 0, top: 0, width: "100%", height: "100%" };
  if (l === "2c")
    return i === 0
      ? { left: 0, top: 0, width: wL, height: "100%" }
      : { left: wL, top: 0, width: wR, height: "100%" };
  if (l === "2r")
    return i === 0
      ? { left: 0, top: 0, width: "100%", height: hT }
      : { left: 0, top: hT, width: "100%", height: hB };
  return {
    left: i % 2 === 0 ? 0 : wL,
    top: i < 2 ? 0 : hT,
    width: i % 2 === 0 ? wL : wR,
    height: i < 2 ? hT : hB,
  };
}

/** Draggable boundary between split panes. Mousemoves are rAF-coalesced and
 *  write the fraction straight onto the pane area's CSS var — zero React
 *  renders during the drag; the value persists on release. */
function PaneDivider({
  axis,
  areaRef,
}: {
  axis: "x" | "y";
  areaRef: React.RefObject<HTMLDivElement>;
}) {
  const active = useRef(false);
  const raf = useRef(0);
  const last = useRef(0);

  useEffect(() => {
    const varName = axis === "x" ? "--px" : "--py";
    const key = axis === "x" ? SPLIT_X_KEY : SPLIT_Y_KEY;
    const move = (e: MouseEvent) => {
      if (!active.current) return;
      last.current = axis === "x" ? e.clientX : e.clientY;
      if (raf.current) return;
      raf.current = requestAnimationFrame(() => {
        raf.current = 0;
        const el = areaRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const frac =
          axis === "x"
            ? (last.current - r.left) / Math.max(1, r.width)
            : (last.current - r.top) / Math.max(1, r.height);
        el.style.setProperty(
          varName,
          String(clamp(frac, SPLIT_MIN_FRAC, SPLIT_MAX_FRAC))
        );
      });
    };
    const up = () => {
      if (!active.current) return;
      active.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      const v = areaRef.current?.style.getPropertyValue(varName);
      if (v) localStorage.setItem(key, v);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [axis, areaRef]);

  const isX = axis === "x";
  return (
    <div
      onMouseDown={(e) => {
        e.preventDefault();
        active.current = true;
        last.current = isX ? e.clientX : e.clientY;
        document.body.style.cursor = isX ? "col-resize" : "row-resize";
        document.body.style.userSelect = "none";
      }}
      title="Drag to resize panes"
      style={{
        position: "absolute",
        zIndex: 20,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        ...(isX
          ? {
              top: 0,
              height: "100%",
              width: 8,
              left: "calc(var(--px, 0.5) * 100% - 4px)",
              cursor: "col-resize",
            }
          : {
              left: 0,
              width: "100%",
              height: 8,
              top: "calc(var(--py, 0.5) * 100% - 4px)",
              cursor: "row-resize",
            }),
      }}
    >
      <div
        style={
          isX
            ? { width: 2, height: "100%", background: T.divider }
            : { height: 2, width: "100%", background: T.divider }
        }
      />
    </div>
  );
}

const LAYOUT_CHOICES: Array<{ id: PaneLayout; glyph: string; label: string }> = [
  { id: "1", glyph: "▭", label: "Single pane" },
  { id: "2c", glyph: "◫", label: "Split: two columns" },
  { id: "2r", glyph: "⊟", label: "Split: two rows" },
  { id: "4", glyph: "⊞", label: "Split: 2×2 grid" },
];

function relativeTime(ms: number): string {
  if (!ms || ms <= 0) return "unknown";
  const diff = Date.now() - ms;
  if (diff < 0) return "just now"; // clock skew / future mtime
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

/** Compact age of a state change — "40s" / "2m" / "3h" / "5d". Empty string
 *  when the timestamp is missing, so callers can drop the suffix entirely. */
function relativeAge(ms: number): string {
  if (!ms || ms <= 0) return "";
  const diff = Date.now() - ms;
  if (diff < 0) return "0s"; // clock skew
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Dot color for a session. `ended` outranks the agent state — a finished
 *  session is grey whatever it was doing when it stopped. */
function stateColor(s: SessionInfo): string {
  if (s.ended) return T.idle;
  if (s.state === "blocked") return T.error;
  if (s.state === "working") return T.running;
  if (s.state === "idle") return T.success;
  return T.idle; // unknown — hooks off, or a plain terminal
}

/** What the dot means, for its tooltip: "blocked · 2m". */
function stateTitle(s: SessionInfo): string {
  if (s.ended) return "ended";
  if (s.is_terminal) return "terminal — no hook events";
  if (s.state === "blocked" || s.state === "working") {
    const age = relativeAge(s.state_since);
    return age ? `${s.state} · ${age}` : s.state;
  }
  if (s.state === "idle") return "idle — waiting on you";
  return "unknown — no hook events yet";
}

interface StateCounts {
  blocked: number;
  working: number;
  idle: number;
  unknown: number;
  /** Every live session, terminals included — what the "N live" fallback counts. */
  total: number;
}

/** Triage aggregate over live sessions. Ended sessions drop out; plain
 *  terminals are counted in `total` but never in a state bucket — they receive
 *  no hooks, so counting them would drown the numbers in "unknown". */
function countStates(list: SessionInfo[]): StateCounts {
  const c: StateCounts = { blocked: 0, working: 0, idle: 0, unknown: 0, total: 0 };
  for (const s of list) {
    if (s.ended) continue;
    c.total++;
    if (s.is_terminal) continue;
    if (s.state === "blocked") c.blocked++;
    else if (s.state === "working") c.working++;
    else if (s.state === "idle") c.idle++;
    else c.unknown++;
  }
  return c;
}

/** "2 blocked · 1 working" — falls back to "N live" when nothing wants you. */
function stateSummary(c: StateCounts): string {
  const parts: string[] = [];
  if (c.blocked) parts.push(`${c.blocked} blocked`);
  if (c.working) parts.push(`${c.working} working`);
  return parts.length ? parts.join(" · ") : `${c.total} live`;
}

/** Most urgent state present: blocked > working > idle. */
function summaryColor(c: StateCounts): string {
  if (c.blocked) return T.error;
  if (c.working) return T.running;
  return T.success;
}

/** "claude-opus-4-8" / "claude-haiku-4-5-20251001" -> "opus 4.8" / "haiku 4.5" */
function prettyModel(model: string): string {
  const parts = model.replace(/^claude-/, "").replace(/-\d{8}$/, "").split("-");
  const fam = parts.shift() ?? model;
  return parts.length ? `${fam} ${parts.join(".")}` : fam;
}

/** Last path segment — the repo/dir name used as a card title. */
function repoName(cwd: string): string {
  return cwd.split("/").filter(Boolean).pop() ?? cwd;
}

/** Parent path with a leading /Users/<name>/ or /home/<name>/ compressed to ~/. */
function prettyParent(cwd: string): string {
  const home = cwd.replace(/^\/(?:Users|home)\/[^/]+\//, "~/");
  const name = repoName(home);
  const parent = home.slice(0, home.length - name.length).replace(/\/$/, "");
  return parent || "~";
}

/** Opus reads violet; everything else in the warm web-tool hue. */
function modelTextColor(model: string): string {
  return /opus/i.test(model) ? T.modelViolet : T.searchGlyph;
}

function savedListWidth(): number {
  const v = Number(localStorage.getItem(LIST_WIDTH_KEY));
  return Number.isFinite(v) && v > 0 ? clamp(v, LIST_MIN, LIST_MAX) : LIST_WIDTH;
}

/** A mounted tab pane. Memoized so the launcher's 2s poll / list interactions
 *  never re-render every embedded session (all props are primitives). */
const TabPane = memo(function TabPane({
  vid,
  port,
  token,
  cwd,
  isTerminal,
  isVisible,
}: {
  vid: string;
  port: string;
  token: string;
  cwd: string;
  isTerminal: boolean;
  /** Whether this tab currently occupies a pane slot. Every tab shares one
   *  document, so `document.hasFocus()` can't tell a background tab apart —
   *  SessionWindow needs this to target completion notifications. */
  isVisible: boolean;
}) {
  return isTerminal ? (
    <TerminalWindow vid={vid} port={port} token={token} cwd={cwd} embedded />
  ) : (
    <SessionWindow vid={vid} port={port} token={token} cwd={cwd} embedded isVisible={isVisible} />
  );
});

/** Serif section label with a thin divider rule and optional chevron collapse,
 *  a status pill, and a right-aligned control slot. */
function SectionRow({
  label,
  open,
  onToggle,
  pill,
  right,
}: {
  label: string;
  open?: boolean;
  onToggle?: () => void;
  pill?: React.ReactNode;
  right?: React.ReactNode;
}) {
  const collapsible = onToggle !== undefined;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        marginBottom: open === false ? 0 : 12,
      }}
    >
      {collapsible && (
        <span
          onClick={onToggle}
          style={{ color: T.textFaint, fontSize: 9, cursor: "pointer", userSelect: "none" }}
        >
          {open ? "▼" : "▶"}
        </span>
      )}
      <h2
        onClick={onToggle}
        style={{
          fontFamily: T.serif,
          fontSize: 15,
          fontWeight: 600,
          color: T.text,
          margin: 0,
          whiteSpace: "nowrap",
          cursor: collapsible ? "pointer" : "default",
          userSelect: "none",
        }}
      >
        {label}
      </h2>
      {pill}
      <div style={{ flex: 1, height: 1, background: T.divider }} />
      {right}
    </div>
  );
}

/** Header above a repo that holds more than one live session: the repo name
 *  plus that repo's own triage aggregate, so a busy repo reads at a glance.
 *  A lone session never gets one — a header per card is pure chrome. */
function RepoHeader({
  name,
  counts,
  title,
}: {
  name: string;
  counts: StateCounts;
  title?: string;
}) {
  return (
    <div
      title={title}
      style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, padding: "2px 2px 0" }}
    >
      <span
        style={{
          fontFamily: T.serif,
          fontSize: 12.5,
          fontWeight: 600,
          color: T.textDim,
          flexShrink: 0,
        }}
      >
        {name}
      </span>
      <span
        style={{
          fontSize: 10.5,
          color: summaryColor(counts),
          whiteSpace: "nowrap",
          flexShrink: 0,
        }}
      >
        {stateSummary(counts)}
      </span>
      <div style={{ flex: 1, height: 1, background: T.divider }} />
    </div>
  );
}

export default function Launcher() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [past, setPast] = useState<PastSession[]>([]);
  const [pastLoading, setPastLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [sortBy, setSortBy] = useState<"recent" | "count">("recent");
  // Per-directory pagination: how many sessions are rendered in each group's
  // scroll panel; grows by PAGE_SIZE as the panel is scrolled to the bottom.
  const [pageCounts, setPageCounts] = useState<Record<string, number>>({});
  // Reset pagination when the visible groups change (filter/sort), so stale
  // per-directory counts don't leak across different views.
  useEffect(() => {
    setPageCounts({});
  }, [filter, sortBy]);
  const [hooksInstalled, setHooksInstalled] = useState<boolean | null>(null);
  const [hooksMessage, setHooksMessage] = useState<string | null>(null);
  const [newSessionError, setNewSessionError] = useState<string | null>(null);
  // Split-pane mode: wide launcher embeds the session viewer on the right.
  const [wide, setWide] = useState(window.innerWidth >= SPLIT_MIN_WIDTH);
  const [conn, setConn] = useState<ConnInfo | null>(null);
  // Chrome-style tabs in the right pane. Every tab's terminal stays mounted
  // (hidden, not unmounted) so all sessions keep rendering live output and
  // switching is instant with no reconnect.
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeVid, setActiveVid] = useState<string | null>(null);
  // Split layout: which tab is visible in each pane slot. All tabs stay
  // mounted regardless; slots only control position/visibility.
  const [layout, setLayoutState] = useState<PaneLayout>(savedLayout);
  const [paneVids, setPaneVids] = useState<(string | null)[]>(() =>
    Array(paneCount(savedLayout())).fill(null)
  );
  // "New Terminal" split-button dropdown (tmux | shell).
  const [newTermMenu, setNewTermMenu] = useState(false);
  // Split-pane sizing: the repos list is resizable and can be collapsed so the
  // session pane takes the full width. Live drags mutate the DOM directly; the
  // committed width persists.
  const [listWidth, setListWidth] = useState(savedListWidth);
  const listRef = useRef<HTMLDivElement>(null);
  // Split-pane divider fractions: read once; live drags mutate the CSS vars on
  // the pane area directly (values persist to localStorage on release).
  const paneAreaRef = useRef<HTMLDivElement>(null);
  const [initialSplits] = useState(() => ({
    x: savedFrac(SPLIT_X_KEY),
    y: savedFrac(SPLIT_Y_KEY),
  }));
  const listWidthRef = useRef(listWidth);
  const [listCollapsed, setListCollapsed] = useState(false);
  // Collapsible launcher sections (by key).
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  const toggleSection = (k: string) =>
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  // Mirrors readable synchronously inside window-level handlers.
  const activeVidRef = useRef<string | null>(null);
  useEffect(() => {
    activeVidRef.current = activeVid;
  }, [activeVid]);
  const tabsRef = useRef<Tab[]>([]);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // rAF-throttled: window resize fires continuously during a drag.
    let raf = 0;
    const onResize = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setWide(window.innerWidth >= SPLIT_MIN_WIDTH);
        // A shrinking window must never leave the list wider than the pane
        // can afford (same-value updates bail, so this is free otherwise).
        setListWidth((w) => clamp(w, LIST_MIN, maxListWidth()));
        // Correct the live DOM too — it may hold a stale dragged width that
        // React's state (unchanged) would never rewrite.
        if (embedModeRef.current && listRef.current) {
          listWidthRef.current = clamp(listWidthRef.current, LIST_MIN, maxListWidth());
          listRef.current.style.width = `${listWidthRef.current}px`;
        }
      });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  // Keep the live-drag ref in sync when the committed width changes from
  // elsewhere (restore, resize clamp).
  useEffect(() => {
    listWidthRef.current = listWidth;
  }, [listWidth]);

  const refreshHooks = useCallback(async () => {
    try {
      setHooksInstalled(await invoke<boolean>("hooks_status"));
    } catch {
      setHooksInstalled(false);
    }
  }, []);

  // The 2s poll would otherwise re-render the whole launcher (and every
  // mounted tab) with a fresh array identity even when nothing changed —
  // compare serialized payloads and skip identical updates.
  const lastSessionsJson = useRef("");
  const refreshSessions = useCallback(async () => {
    try {
      const next = await invoke<SessionInfo[]>("list_sessions");
      const json = JSON.stringify(next);
      if (json !== lastSessionsJson.current) {
        lastSessionsJson.current = json;
        setSessions(next);
      }
    } catch {
      // backend not ready yet
    }
  }, []);

  const lastPastJson = useRef("");
  const refreshPast = useCallback(async () => {
    setPastLoading(true);
    try {
      const next = await invoke<PastSession[]>("list_past_sessions");
      const json = JSON.stringify(next);
      if (json !== lastPastJson.current) {
        lastPastJson.current = json;
        setPast(next);
      }
    } catch {
      // ignore
    } finally {
      setPastLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshHooks();
    refreshSessions();
    refreshPast();
    invoke<ConnInfo>("get_conn_info").then(setConn).catch(() => {});
  }, [refreshHooks, refreshSessions, refreshPast]);

  useEffect(() => {
    const id = setInterval(refreshSessions, 2000);
    return () => clearInterval(id);
  }, [refreshSessions]);

  // The backend may not be up at first paint — keep retrying the connection
  // info until it lands (it gates split-pane embed mode).
  useEffect(() => {
    if (conn) return;
    const id = setInterval(() => {
      invoke<ConnInfo>("get_conn_info").then(setConn).catch(() => {});
    }, 1500);
    return () => clearInterval(id);
  }, [conn]);

  const embedMode = wide && conn !== null;
  const embedModeRef = useRef(embedMode);
  useEffect(() => {
    embedModeRef.current = embedMode;
  }, [embedMode]);

  // Keep the committed width applied to the real DOM. Drags mutate the node
  // directly, so React's style diff can miss a correction when the clamped
  // state lands on a value it already rendered (e.g. a drag whose release was
  // lost off-window) — write it explicitly instead.
  useEffect(() => {
    if (listRef.current) {
      listRef.current.style.width = embedMode ? `${listWidth}px` : "100%";
    }
  }, [embedMode, listWidth]);

  // A session popped out to its own window docks back as a tab (the window's
  // "Dock" button routes through the backend's cv:dock event).
  useEffect(() => {
    const un = listen<{ vid: string; cwd: string; isTerminal: boolean }>("cv:dock", (e) => {
      openInPane(e.payload.vid, e.payload.cwd, e.payload.isTerminal);
    });
    return () => {
      un.then((f) => f());
    };
    // openInPane only touches setState — safe to bind once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Chrome-style tab reordering: after a 5px drag threshold the grabbed tab
  // swaps live with neighbors as the cursor crosses their midpoints. A real
  // drag suppresses the click so releasing doesn't also re-focus.
  const tabBarRef = useRef<HTMLDivElement>(null);
  const dragTab = useRef<{ vid: string; startX: number; started: boolean } | null>(null);
  const suppressTabClick = useRef(false);
  const [draggingVid, setDraggingVid] = useState<string | null>(null);

  function onTabPointerDown(e: React.PointerEvent, vid: string) {
    if (e.button !== 0) return;
    dragTab.current = { vid, startX: e.clientX, started: false };
    const onMove = (ev: PointerEvent) => {
      const st = dragTab.current;
      if (!st) return;
      if (!st.started) {
        if (Math.abs(ev.clientX - st.startX) < 5) return;
        st.started = true;
        setDraggingVid(st.vid);
      }
      const bar = tabBarRef.current;
      if (!bar) return;
      const order = tabsRef.current;
      const from = order.findIndex((t) => t.vid === st.vid);
      if (from === -1) return;
      // Target slot = number of OTHER tabs whose midpoint sits left of the cursor.
      let to = 0;
      for (const el of bar.querySelectorAll<HTMLElement>("[data-tabvid]")) {
        if (el.dataset.tabvid === st.vid) continue;
        const r = el.getBoundingClientRect();
        if (ev.clientX > r.left + r.width / 2) to++;
      }
      if (to !== from) {
        const next = [...order];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        tabsRef.current = next;
        setTabs(next);
      }
    };
    const onUp = () => {
      const wasDrag = dragTab.current?.started ?? false;
      dragTab.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDraggingVid(null);
      if (wasDrag) {
        suppressTabClick.current = true;
        setTimeout(() => (suppressTabClick.current = false), 0);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  /** Focus a tab: if it's already visible in a pane, just activate it;
   *  otherwise it takes over the currently-active pane slot (or the first
   *  empty one). This is the single path for tab clicks, ⌘1–9, and opens. */
  function focusTab(vid: string) {
    setPaneVids((prev) => {
      if (prev.includes(vid)) return prev;
      const next = [...prev];
      let idx = next.indexOf(activeVidRef.current);
      if (idx === -1) idx = next.indexOf(null);
      if (idx === -1) idx = 0;
      next[idx] = vid;
      return next;
    });
    activeVidRef.current = vid;
    setActiveVid(vid);
  }

  /** Switch the split layout; freed slots collapse, new slots pull in open
   *  tabs that aren't visible yet. */
  function applyLayout(l: PaneLayout) {
    setLayoutState(l);
    localStorage.setItem(LAYOUT_KEY, l);
    setPaneVids((prev) => {
      const n = paneCount(l);
      const next = prev.slice(0, n);
      while (next.length < n) next.push(null);
      const shown = new Set(next.filter(Boolean));
      const avail = tabsRef.current.map((t) => t.vid).filter((v) => !shown.has(v));
      for (let i = 0; i < next.length; i++) {
        if (!next[i] && avail.length) next[i] = avail.shift()!;
      }
      return next;
    });
  }

  /** Add a session as a tab (or focus its existing tab). */
  function openInPane(vid: string, cwd: string, isTerminal = false) {
    setTabs((prev) =>
      prev.some((t) => t.vid === vid) ? prev : [...prev, { vid, cwd, isTerminal }]
    );
    focusTab(vid);
  }

  // Restore last session's tabs once the live-session list is known, dropping
  // tabs whose viewer no longer exists. Runs once.
  const restoredTabs = useRef(false);
  useEffect(() => {
    if (restoredTabs.current || !embedMode || sessions.length === 0) return;
    restoredTabs.current = true;
    try {
      const saved = JSON.parse(localStorage.getItem(TABS_KEY) ?? "[]") as Tab[];
      const known = new Set(sessions.map((s) => s.viewer_id));
      const valid = saved.filter((t) => t && known.has(t.vid));
      if (valid.length) {
        setTabs(valid);
        tabsRef.current = valid;
        const savedActive = localStorage.getItem(ACTIVE_TAB_KEY);
        const active = valid.some((t) => t.vid === savedActive)
          ? (savedActive as string)
          : valid[valid.length - 1].vid;
        activeVidRef.current = active;
        setActiveVid(active);
        // Seed the pane slots: active tab first, then the rest in order.
        const ordered = [active, ...valid.map((t) => t.vid).filter((v) => v !== active)];
        setPaneVids((prev) => prev.map((_, i) => ordered[i] ?? null));
      }
    } catch {
      // corrupt state — start clean
    }
  }, [embedMode, sessions]);

  // Persist tabs after restore has run (never clobber the saved set with the
  // initial empty state).
  useEffect(() => {
    if (!restoredTabs.current) return;
    try {
      localStorage.setItem(TABS_KEY, JSON.stringify(tabs));
      if (activeVid) localStorage.setItem(ACTIVE_TAB_KEY, activeVid);
      else localStorage.removeItem(ACTIVE_TAB_KEY);
    } catch {
      // ignore
    }
  }, [tabs, activeVid]);

  function closeTab(vid: string) {
    const remaining = tabsRef.current.filter((t) => t.vid !== vid);
    tabsRef.current = remaining;
    setTabs(remaining);
    let nextActive = activeVidRef.current;
    if (nextActive === vid) {
      nextActive = remaining.length ? remaining[remaining.length - 1].vid : null;
    }
    // Free the closed tab's pane slot; backfill it with the next active tab
    // if that tab isn't already showing somewhere.
    setPaneVids((prev) => {
      const shownElsewhere = new Set(prev.filter((v) => v && v !== vid));
      return prev.map((v) =>
        v === vid ? (nextActive && !shownElsewhere.has(nextActive) ? nextActive : null) : v
      );
    });
    activeVidRef.current = nextActive;
    setActiveVid(nextActive);
    // If the session has already ended, closing its tab is a good moment to
    // reclaim its backend resources (PTY fds, scrollback). Live sessions are
    // left running so closing a tab doesn't kill them. Check against a FRESH
    // list — the polled copy can lag a just-ended session by up to 2s.
    void (async () => {
      const list = await invoke<SessionInfo[]>("list_sessions").catch(() => sessions);
      const ended = list.find((s) => s.viewer_id === vid)?.ended ?? false;
      if (ended) {
        await invoke("close_session", { viewerId: vid }).catch(() => {});
        refreshSessions();
      }
    })();
  }

  /** Close every open tab at once (VS Code "Close All"). Live sessions keep
   *  running; ended ones get their backend resources reclaimed, same as a
   *  single close. */
  async function closeAllTabs() {
    const open = tabsRef.current;
    activeVidRef.current = null;
    setActiveVid(null);
    setTabs([]);
    setPaneVids((prev) => prev.map(() => null));
    const list = await invoke<SessionInfo[]>("list_sessions").catch(() => sessions);
    await Promise.allSettled(
      open
        .filter((t) => list.find((s) => s.viewer_id === t.vid)?.ended ?? false)
        .map((t) => invoke("close_session", { viewerId: t.vid }))
    );
    refreshSessions();
  }

  async function launch(cwd: string, resume: string | null) {
    setNewSessionError(null);
    try {
      const info = await invoke<SessionInfo>("new_session", {
        cwd,
        resume,
        continueLast: false,
        openWindow: !embedMode,
      });
      if (embedMode) {
        openInPane(info.viewer_id, info.cwd);
      }
      await refreshSessions();
    } catch (err) {
      setNewSessionError(String(err));
    }
  }

  async function handleNewSession() {
    const selected = await open({ directory: true, multiple: false });
    if (!selected) return;
    await launch(Array.isArray(selected) ? selected[0] : selected, null);
  }

  /** Launch a plain terminal (login shell or tmux) in a known directory —
   *  embeds it as a tab (wide launcher) or opens a native window. */
  async function launchTerminalIn(cwd: string, kind: "tmux" | "shell") {
    setNewSessionError(null);
    try {
      const info = await invoke<SessionInfo>("new_terminal", {
        cwd,
        kind,
        openWindow: !embedMode,
      });
      if (embedMode) openInPane(info.viewer_id, info.cwd, true);
      await refreshSessions();
    } catch (err) {
      setNewSessionError(String(err));
    }
  }

  /** Terminal via the header button: pick a working directory first. */
  async function handleNewTerminal(kind: "tmux" | "shell") {
    setNewTermMenu(false);
    const selected = await open({ directory: true, multiple: false });
    if (!selected) return;
    await launchTerminalIn(Array.isArray(selected) ? selected[0] : selected, kind);
  }

  async function handleResume(s: PastSession) {
    await launch(s.cwd, s.session_id);
  }

  async function handleFocus(s: SessionInfo) {
    if (embedMode) {
      openInPane(s.viewer_id, s.cwd, s.is_terminal);
      return;
    }
    try {
      await invoke("focus_session", { viewerId: s.viewer_id });
    } catch {
      // ignore
    }
  }

  /** Pop the active tab's session out into its own native window. */
  async function handlePopOut() {
    if (!activeVid) return;
    try {
      await invoke("focus_session", { viewerId: activeVid });
      closeTab(activeVid);
    } catch {
      // ignore
    }
  }

  // One command surface for the whole app: search, create, and tab management
  // all hang off the keyboard (VS Code-style), so the launcher can fully
  // replace a stack of terminal windows.
  //   ⌘K search · ⌘N new session · ⌘T new terminal · ⌘W close tab · ⌘1–9 tabs
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "k" && !e.shiftKey) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (k === "n" && !e.shiftKey) {
        e.preventDefault();
        handleNewSession();
        return;
      }
      if (k === "t" && !e.shiftKey) {
        e.preventDefault();
        handleNewTerminal("shell");
        return;
      }
      if (k === "w" && !e.shiftKey && activeVidRef.current) {
        e.preventDefault();
        closeTab(activeVidRef.current);
        return;
      }
      if (/^[1-9]$/.test(e.key)) {
        const t = tabsRef.current[Number(e.key) - 1];
        if (t) {
          e.preventDefault();
          focusTab(t.vid);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // Handlers read live state via refs; embedMode only affects new-item routing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embedMode]);

  const [hooksBusy, setHooksBusy] = useState(false);

  async function toggleHooks() {
    if (hooksBusy || hooksInstalled === null) return;
    setHooksBusy(true);
    setHooksMessage(null);
    const cmd = hooksInstalled ? "uninstall_hooks" : "install_hooks";
    try {
      setHooksMessage(await invoke<string>(cmd));
    } catch (err) {
      setHooksMessage(`Error: ${String(err)}`);
    }
    await refreshHooks();
    setHooksBusy(false);
  }

  // Group past sessions by repo (a repo and all its worktrees share one
  // `repo_key`), falling back to the raw cwd when the scanner didn't resolve
  // one. Groups are ordered by most recent activity.
  //
  // The key is NOT a launchable path — `repo_key` is a .git common dir — so
  // every consumer (`pageCounts`, `collapsedSections`, `handleGroupScroll`)
  // keys off it, while the header's path/label/launch buttons use the group's
  // most recent cwd instead.
  const grouped = useMemo(() => {
    // Sessions with no extractable prompt (empty or unlabeled transcripts)
    // aren't worth resuming — hide them.
    const withPrompt = past.filter((s) => s.preview);
    const needle = filter.trim().toLowerCase();
    const filtered = needle
      ? withPrompt.filter(
          (s) =>
            s.cwd.toLowerCase().includes(needle) ||
            (s.preview ?? "").toLowerCase().includes(needle) ||
            s.session_id.includes(needle)
        )
      : withPrompt;
    const map = new Map<string, PastSession[]>();
    for (const s of filtered) {
      const key = s.repoKey ?? s.cwd;
      const list = map.get(key) ?? [];
      list.push(s);
      map.set(key, list);
    }
    // `past` is newest-first, so each group's first element is its newest
    // and insertion order ranks groups by recency.
    const entries = [...map.entries()];
    if (sortBy === "count") {
      entries.sort((a, b) => b[1].length - a[1].length);
    }
    return entries;
  }, [past, filter, sortBy]);

  const activeLive = sessions.filter((s) => !s.ended).length;
  // Triage aggregate for the section pill — derived from `sessions` on every
  // render rather than stored, so it can never drift from the 2s poll.
  const liveCounts = useMemo(() => countStates(sessions), [sessions]);
  // Live sessions bucketed by repo: four agents on four worktrees of one repo
  // belong together, not scattered through a flat list of unrelated paths.
  // Insertion order preserves the backend's sort both across and within groups.
  const liveGroups = useMemo(() => {
    const map = new Map<string, SessionInfo[]>();
    for (const s of sessions) {
      const key = s.repo_key ?? s.cwd;
      const list = map.get(key) ?? [];
      list.push(s);
      map.set(key, list);
    }
    return [...map.entries()];
  }, [sessions]);
  // Busiest repo's session count — used to scale each group's usage bar.
  const maxGroupCount = Math.max(1, ...grouped.map(([, l]) => l.length));

  /** `key` is the group key from `grouped` (a repo_key or a cwd) — never a path. */
  function handleGroupScroll(key: string, total: number, el: HTMLDivElement) {
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) {
      setPageCounts((prev) => {
        const current = prev[key] ?? PAGE_SIZE;
        if (current >= total) return prev;
        return { ...prev, [key]: current + PAGE_SIZE };
      });
    }
  }

  const activeOpen = !collapsedSections.has("active");
  const pastOpen = !collapsedSections.has("past");

  // A squeezed split-mode list drops secondary row chrome (context meter,
  // model label) so rows never overflow into horizontal scrollbars.
  const narrow = embedMode && listWidth < 520;

  // Two-step transcript delete: first click arms ("Delete?"), second click
  // moves the transcript to the OS Trash. Arming auto-clears after a moment
  // so a stray click never leaves a live-fire button around.
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (armTimer.current) clearTimeout(armTimer.current);
  }, []);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  function handleDelete(s: PastSession, e: React.MouseEvent) {
    e.stopPropagation();
    if (armedDelete !== s.session_id) {
      setArmedDelete(s.session_id);
      if (armTimer.current) clearTimeout(armTimer.current);
      armTimer.current = setTimeout(() => setArmedDelete(null), 2500);
      return;
    }
    if (armTimer.current) clearTimeout(armTimer.current);
    setArmedDelete(null);
    setDeleteError(null);
    invoke("delete_past_session", { sessionId: s.session_id })
      .then(() => {
        // Drop the row immediately; the next rescan confirms.
        setPast((prev) => prev.filter((p) => p.session_id !== s.session_id));
        lastPastJson.current = "";
      })
      .catch((err) => setDeleteError(`Couldn't delete session: ${String(err)}`));
  }

  /** One live-session card. Cards inside a repo group label themselves by
   *  checkout instead of repeating the repo name that's already in the header. */
  function liveCard(s: SessionInfo, inGroup: boolean) {
    const selected = activeVid === s.viewer_id;
    const label = (inGroup ? s.checkout_name : null) ?? repoName(s.cwd);
    return (
      <div
        key={s.viewer_id}
        className="cv-card"
        onClick={() => handleFocus(s)}
        title={embedMode ? "Open as a tab" : "Focus the session window"}
        style={{
          background: T.surface1,
          border: `1px solid ${selected ? T.accentBorder : T.border}`,
          borderRadius: 11,
          padding: "13px 16px",
          display: "flex",
          alignItems: "center",
          gap: 13,
          cursor: "pointer",
        }}
      >
        <span
          title={stateTitle(s)}
          style={{
            width: 9,
            height: 9,
            borderRadius: "50%",
            background: stateColor(s),
            flexShrink: 0,
            // One moving dot is a focus cue; ten would be noise — only the
            // selected session pulses, exactly as before.
            animation:
              !s.ended && selected ? "pulseDot 1.6s ease-in-out infinite" : undefined,
          }}
        />
        <div style={{ flex: 1, overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
            <span
              style={{
                fontFamily: T.serif,
                fontSize: 15,
                fontWeight: 600,
                color: T.text,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {s.is_terminal && (
                <span style={{ fontFamily: T.mono, fontSize: 12, color: T.path }}>
                  ❯{" "}
                </span>
              )}
              {label}
            </span>
            {/* Detached / reftable HEAD renders no chip at all — a "detached"
                placeholder would be noise on every card that has one. */}
            {s.branch && (
              <span style={chipStyle} title={`On branch ${s.branch}`}>
                ⑂ {s.branch}
              </span>
            )}
            {s.is_linked_worktree && (
              <span style={worktreeChipStyle} title="Linked git worktree">
                worktree
              </span>
            )}
          </div>
          <div style={{ ...pathStyle, marginTop: 3 }} title={s.cwd}>
            {prettyParent(s.cwd)}/{repoName(s.cwd)}
            {s.session_id ? (
              <span style={{ color: T.textFaint }}> · #{s.session_id.slice(0, 8)}</span>
            ) : (
              <span style={{ color: T.textFaint }}> · id pending</span>
            )}
            {s.ended && <span style={{ color: T.error }}> · ended</span>}
          </div>
        </div>
        {!s.ended && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleFocus(s);
            }}
            style={resumeBtnStyle}
          >
            {embedMode ? "Open" : "Focus"}
          </button>
        )}
      </div>
    );
  }

  const listColumn = (
    <div
      ref={listRef}
      style={{
        width: embedMode ? listWidth : "100%",
        flexShrink: 0,
        height: "100%",
        overflowY: "auto",
        overflowX: "hidden",
        display: "flex",
        // Split mode anchors content left so a wide list never opens a void
        // between the content column and the session pane.
        justifyContent: embedMode ? "flex-start" : "center",
        background: T.surface,
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 720,
          padding: embedMode ? "30px 26px 44px" : "52px 32px 60px",
        }}
      >
        {/* Header + primary actions. flex-wrap: when the split-mode list is
            squeezed, the button row drops BELOW the title instead of
            overlapping it. */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "flex-start",
            gap: 12,
            rowGap: 10,
            marginBottom: 22,
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
            <h1
              style={{
                fontFamily: T.serif,
                fontSize: 24,
                fontWeight: 600,
                margin: 0,
                color: T.text,
                whiteSpace: "nowrap",
              }}
            >
              Sessions
            </h1>
            <p
              style={{
                fontFamily: T.serif,
                fontStyle: "italic",
                fontSize: 12.5,
                color: T.textDim,
                margin: 0,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              Live mirror for Claude Code CLI
            </p>
          </div>
          <div style={{ flex: 1 }} />
          <div style={{ display: "flex", gap: 8, flexShrink: 0, alignItems: "center" }}>
            <button
              onClick={handleNewSession}
              style={{ ...primaryBtnStyle, padding: narrow ? "9px 13px" : "9px 18px" }}
              title="New session (⌘N)"
            >
              <span style={{ fontSize: 14, lineHeight: 1 }}>+</span> New Session
            </button>
            <div style={{ position: "relative", flexShrink: 0 }}>
              <button
                onClick={() => setNewTermMenu((v) => !v)}
                style={{ ...terminalBtnStyle, padding: narrow ? "9px 11px" : "9px 16px" }}
                title="Open a shell or tmux terminal in this app (⌘T)"
              >
                <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textDim, lineHeight: 1 }}>
                  ❯_
                </span>{" "}
                Terminal
                <span style={{ color: T.textFaint, fontSize: 10 }}>▾</span>
              </button>
              {newTermMenu && (
                <>
                  <div
                    onClick={() => setNewTermMenu(false)}
                    style={{ position: "fixed", inset: 0, zIndex: 50 }}
                  />
                  <div
                    style={{
                      position: "absolute",
                      top: "100%",
                      right: 0,
                      marginTop: 6,
                      zIndex: 51,
                      background: T.surface1,
                      border: `1px solid ${T.borderStrong}`,
                      borderRadius: 10,
                      boxShadow: T.windowShadow,
                      padding: 6,
                      minWidth: 190,
                    }}
                  >
                    <button onClick={() => handleNewTerminal("tmux")} style={termMenuItemStyle}>
                      <span>tmux session</span>
                      <span style={{ color: T.textFaint, fontSize: 10.5 }}>persistent</span>
                    </button>
                    <button onClick={() => handleNewTerminal("shell")} style={termMenuItemStyle}>
                      <span>plain shell</span>
                      <span style={{ color: T.textFaint, fontSize: 10.5, fontFamily: T.mono }}>
                        $SHELL -l
                      </span>
                    </button>
                  </div>
                </>
              )}
            </div>
            <ThemeMenu compact={narrow} />
          </div>
        </div>
        {newSessionError && (
          <div style={{ marginTop: -12, marginBottom: 16, color: T.error, fontSize: 12 }}>
            {newSessionError}
          </div>
        )}

        {/* Search-first */}
        <div style={searchWrapStyle}>
          <span
            style={{ color: T.searchGlyph, fontFamily: T.mono, fontSize: 12, flexShrink: 0 }}
          >
            ⌕
          </span>
          <input
            ref={searchRef}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search a directory or prompt to resume…"
            style={{
              flex: 1,
              minWidth: 0,
              background: "transparent",
              border: "none",
              color: T.text,
              fontFamily: T.serif,
              fontStyle: "italic",
              fontSize: 13,
              outline: "none",
            }}
          />
          <span
            onClick={() => searchRef.current?.focus()}
            style={{
              fontFamily: T.mono,
              fontSize: 10,
              color: T.textFaint,
              border: `1px solid ${T.border}`,
              borderRadius: 5,
              padding: "2px 6px",
              cursor: "pointer",
              flexShrink: 0,
              whiteSpace: "nowrap",
            }}
          >
            ⌘K
          </span>
        </div>

        {/* Active now */}
        <div style={{ marginBottom: 30 }}>
          <SectionRow
            label="Active now"
            open={activeOpen}
            onToggle={() => toggleSection("active")}
            pill={
              activeLive > 0 ? (
                <span
                  title={
                    `${liveCounts.total} live · ${liveCounts.blocked} blocked · ` +
                    `${liveCounts.working} working · ${liveCounts.idle} idle` +
                    (liveCounts.unknown ? ` · ${liveCounts.unknown} unknown` : "")
                  }
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                    fontSize: 10.5,
                    color: summaryColor(liveCounts),
                    background: tint(summaryColor(liveCounts), 0.1),
                    border: `1px solid ${tint(summaryColor(liveCounts), 0.35)}`,
                    borderRadius: 999,
                    padding: "2px 9px",
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                  }}
                >
                  <span
                    style={{
                      display: "inline-block",
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: summaryColor(liveCounts),
                      animation: "pulseDot 1.6s ease-in-out infinite",
                    }}
                  />
                  {stateSummary(liveCounts)}
                </span>
              ) : undefined
            }
          />
          {activeOpen &&
            (sessions.length === 0 ? (
              <p
                style={{
                  fontFamily: T.serif,
                  fontStyle: "italic",
                  color: T.textFaint,
                  fontSize: 13,
                  margin: 0,
                }}
              >
                No mirrored sessions yet — start one above or resume a recent one below.
              </p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {/* Grouped by repo — a repo and all of its worktrees share one
                    `repo_key`. A lone session renders flat, with no header. */}
                {liveGroups.map(([key, list]) =>
                  list.length < 2 ? (
                    liveCard(list[0], false)
                  ) : (
                    <div
                      key={key}
                      style={{ display: "flex", flexDirection: "column", gap: 7 }}
                    >
                      <RepoHeader
                        name={list[0].repo_name ?? repoName(key)}
                        counts={countStates(list)}
                        title={key}
                      />
                      {list.map((s) => liveCard(s, true))}
                    </div>
                  )
                )}
              </div>
            ))}
        </div>

        {/* Recent (past sessions) */}
        <div style={{ marginBottom: 24 }}>
          <SectionRow
            label="Recent"
            open={pastOpen}
            onToggle={() => toggleSection("past")}
            right={
              pastOpen ? (
                <div style={{ display: "flex", gap: 2, alignItems: "center" }}>
                  <div style={segToggleStyle}>
                    {(
                      [
                        ["recent", "Recent"],
                        ["count", "Busiest"],
                      ] as const
                    ).map(([key, label]) => (
                      <button
                        key={key}
                        onClick={() => setSortBy(key)}
                        style={{
                          background: sortBy === key ? T.accentSoft : "transparent",
                          border: "none",
                          borderRadius: 6,
                          color: sortBy === key ? T.accent : T.textDim,
                          fontSize: 11.5,
                          padding: "3px 10px",
                          cursor: "pointer",
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={refreshPast}
                    style={iconBtnStyle}
                    title="Rescan ~/.claude/projects"
                  >
                    ↻
                  </button>
                </div>
              ) : undefined
            }
          />

          {pastOpen && (
            <>
              {deleteError && (
                <div style={{ color: T.error, fontSize: 12, marginBottom: 8 }}>{deleteError}</div>
              )}
              {pastLoading && past.length === 0 ? (
                <p style={{ color: T.textFaint, fontSize: 13, fontFamily: T.serif, fontStyle: "italic" }}>
                  Scanning…
                </p>
              ) : grouped.length === 0 ? (
                <p style={{ color: T.textFaint, fontSize: 13, fontFamily: T.serif, fontStyle: "italic" }}>
                  {filter ? "No sessions match your search." : "No past sessions found."}
                </p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  {grouped.map(([key, list], rank) => {
                    // `key` identifies the group (a repo_key, or a cwd when the
                    // scanner couldn't resolve one) and keys pagination and
                    // collapse state. `dir` is the group's most recent checkout
                    // — the only member that is a real, launchable path.
                    const dir = list[0].cwd;
                    const label = list[0].repoName ?? repoName(dir);
                    // Worktrees of one repo now share a group, so rows tag which
                    // checkout they came from when a group spans more than one.
                    const mixed = list.some((s) => s.cwd !== dir);
                    const shown = Math.min(pageCounts[key] ?? PAGE_SIZE, list.length);
                    const visible = list.slice(0, shown);
                    const dirOpen = !collapsedSections.has("dir:" + key);
                    return (
                      <div key={key}>
                        {/* Workspace group header */}
                        <div
                          onClick={() => toggleSection("dir:" + key)}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            marginBottom: dirOpen ? 8 : 0,
                            cursor: "pointer",
                            userSelect: "none",
                          }}
                          title={dir}
                        >
                          <span style={{ color: T.textFaint, fontSize: 9, flexShrink: 0 }}>
                            {dirOpen ? "▼" : "▶"}
                          </span>
                          {sortBy === "count" && (
                            <span style={{ color: T.running, fontWeight: 700, fontSize: 12, flexShrink: 0 }}>
                              #{rank + 1}
                            </span>
                          )}
                          <span
                            style={{
                              fontFamily: T.serif,
                              fontSize: 13.5,
                              color: T.text,
                              fontWeight: 600,
                              flexShrink: 0,
                            }}
                          >
                            {label}
                          </span>
                          <span
                            style={{
                              fontSize: 11,
                              color: T.textFaint,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              minWidth: 0,
                            }}
                          >
                            {prettyParent(dir)} · {list.length} session{list.length === 1 ? "" : "s"}
                          </span>
                          <span style={{ flex: 1 }} />
                          {/* Fresh session / terminal in this repo — no picker. */}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              launch(dir, null);
                            }}
                            title={`New Claude session in ${dir}`}
                            style={{
                              background: "transparent",
                              border: `1px solid ${T.border}`,
                              borderRadius: 6,
                              color: T.accent,
                              cursor: "pointer",
                              fontSize: 13,
                              lineHeight: 1,
                              padding: "2px 8px",
                              flexShrink: 0,
                            }}
                          >
                            +
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              launchTerminalIn(dir, "shell");
                            }}
                            title={`Open a terminal in ${dir}`}
                            style={{
                              background: "transparent",
                              border: `1px solid ${T.border}`,
                              borderRadius: 6,
                              color: T.textDim,
                              cursor: "pointer",
                              fontFamily: T.mono,
                              fontSize: 10,
                              lineHeight: "13px",
                              padding: "2px 7px",
                              flexShrink: 0,
                            }}
                          >
                            ❯_
                          </button>
                        </div>

                        {/* Usage bar — this repo's session count vs the busiest repo. */}
                        {(() => {
                          const frac = list.length / maxGroupCount;
                          // Heavier usage skews violet; lighter stays amber.
                          const fill = frac >= 0.66 ? T.modelViolet : T.accent;
                          return (
                            <div
                              title={`${list.length} of ${maxGroupCount} (busiest) sessions`}
                              style={{
                                height: 4,
                                background: T.surface2,
                                borderRadius: 999,
                                overflow: "hidden",
                                marginBottom: dirOpen ? 8 : 0,
                              }}
                            >
                              <div
                                style={{
                                  height: "100%",
                                  width: `${Math.max(6, frac * 100)}%`,
                                  background: fill,
                                  borderRadius: 999,
                                }}
                              />
                            </div>
                          );
                        })()}

                        {dirOpen && (
                          <>
                            <div
                              onScroll={(e) => handleGroupScroll(key, list.length, e.currentTarget)}
                              style={{
                                display: "flex",
                                flexDirection: "column",
                                maxHeight: 320,
                                overflowY: "auto",
                                overflowX: "hidden",
                                paddingRight: 4,
                              }}
                            >
                              {visible.map((s) => (
                                <div
                                  key={s.session_id}
                                  className="cv-line"
                                  onClick={() => handleResume(s)}
                                  title="Resume this session"
                                  style={pastRowStyle}
                                >
                                  <span
                                    style={{
                                      fontSize: 12.5,
                                      color: T.textDim,
                                      flex: 1,
                                      minWidth: 0,
                                      whiteSpace: "nowrap",
                                      overflow: "hidden",
                                      textOverflow: "ellipsis",
                                    }}
                                  >
                                    {s.preview}
                                  </span>
                                  {/* Which worktree this came from — only when the
                                      repo group actually spans more than one. */}
                                  {mixed && !narrow && (
                                    <span style={chipStyle} title={s.cwd}>
                                      {s.checkoutName ?? repoName(s.cwd)}
                                    </span>
                                  )}
                                  {/* "<synthetic>" marks injected stub messages, not a model */}
                                  {!narrow && s.model && !s.model.startsWith("<") && (
                                    <span
                                      style={{
                                        fontSize: 10.5,
                                        color: modelTextColor(s.model),
                                        flexShrink: 0,
                                        whiteSpace: "nowrap",
                                      }}
                                      title={s.model}
                                    >
                                      {prettyModel(s.model)}
                                    </span>
                                  )}
                                  {!narrow && s.contextTokens != null && s.contextTokens > 0 && (
                                    <ContextMeter
                                      tokens={s.contextTokens}
                                      modelId={s.model}
                                      width={40}
                                      compact
                                    />
                                  )}
                                  <span
                                    style={{
                                      fontSize: 11,
                                      color: T.textFaint,
                                      flexShrink: 0,
                                      whiteSpace: "nowrap",
                                    }}
                                  >
                                    {relativeTime(s.modifiedMs)}
                                  </span>
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleResume(s);
                                    }}
                                    style={resumeRowBtnStyle}
                                  >
                                    Resume
                                  </button>
                                  <button
                                    className={armedDelete === s.session_id ? undefined : "cv-copy"}
                                    onClick={(e) => handleDelete(s, e)}
                                    title={
                                      armedDelete === s.session_id
                                        ? "Click again to move this transcript to the Trash"
                                        : "Delete this session (moves the transcript to the Trash)"
                                    }
                                    style={{
                                      fontSize: armedDelete === s.session_id ? 11 : 12,
                                      color: T.error,
                                      border: `1px solid ${
                                        armedDelete === s.session_id ? T.error : T.border
                                      }`,
                                      borderRadius: 7,
                                      padding: armedDelete === s.session_id ? "4px 8px" : "4px 9px",
                                      background:
                                        armedDelete === s.session_id ? T.errorTint : "transparent",
                                      cursor: "pointer",
                                      flexShrink: 0,
                                      whiteSpace: "nowrap",
                                    }}
                                  >
                                    {armedDelete === s.session_id ? "Delete?" : "✕"}
                                  </button>
                                </div>
                              ))}
                            </div>
                            {list.length > shown ? (
                              <div style={{ fontSize: 11, color: T.textFaint, marginTop: 6 }}>
                                showing {shown} of {list.length} — scroll the list for more
                              </div>
                            ) : (
                              list.length > PAGE_SIZE && (
                                <div style={{ fontSize: 11, color: T.textFaint, marginTop: 6 }}>
                                  all {list.length} shown
                                </div>
                              )
                            )}
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>

        {/* Hooks onboarding — demoted to a reassuring footer status row */}
        <div style={hooksCardStyle}>
          <span
            style={{
              width: 34,
              height: 34,
              borderRadius: 9,
              background: tint(hooksInstalled ? T.success : T.idle, 0.12),
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: hooksInstalled ? T.success : T.textDim,
              fontSize: 16,
              flexShrink: 0,
            }}
          >
            {hooksInstalled === null ? "…" : hooksInstalled ? "✓" : "○"}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: T.serif, fontSize: 13.5, fontWeight: 600, color: T.text }}>
              {hooksInstalled === null
                ? "Checking timeline hooks…"
                : hooksInstalled
                ? "Timeline hooks are on"
                : "Timeline hooks are off"}
            </div>
            <div style={{ fontSize: 11.5, color: T.textDim, marginTop: 2 }}>
              {hooksMessage && !hooksBusy
                ? hooksMessage
                : hooksInstalled
                ? "Command cards appear live. Reversible — a backup of settings.json is kept."
                : "The timeline still fills in from the transcript, a little delayed. Turn on for live cards."}
            </div>
          </div>
          <button
            onClick={toggleHooks}
            disabled={hooksBusy || hooksInstalled === null}
            style={{
              ...secondaryBtnStyle,
              opacity: hooksBusy || hooksInstalled === null ? 0.6 : 1,
              cursor: hooksBusy || hooksInstalled === null ? "default" : "pointer",
            }}
            title={hooksInstalled ? "Uninstall hooks" : "Install hooks"}
          >
            {hooksInstalled ? "Manage" : "Turn on"}
          </button>
        </div>

        {/* Keyboard cheat line */}
        <div
          style={{
            marginTop: 18,
            fontSize: 10.5,
            fontFamily: T.mono,
            color: T.textFaint,
            display: "flex",
            gap: 14,
            flexWrap: "wrap",
          }}
        >
          <span>⌘K search</span>
          <span>⌘N new session</span>
          <span>⌘T terminal</span>
          {embedMode && <span>⌘W close tab</span>}
          {embedMode && <span>⌘1–9 switch tab</span>}
        </div>
      </div>
    </div>
  );

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        background: T.surface,
        color: T.text,
        fontFamily: T.ui,
        overflow: "hidden",
      }}
    >
      {/* Repos list — hidden when collapsed in split mode. */}
      {(!embedMode || !listCollapsed) && listColumn}

      {/* Drag handle between the list and the session pane. Live drags write
          the width straight to the DOM; the final width commits + persists. */}
      {embedMode && !listCollapsed && (
        <DragHandle
          title="Drag to resize the sessions list"
          onResize={(dx) => {
            listWidthRef.current = clamp(listWidthRef.current + dx, LIST_MIN, maxListWidth());
            if (listRef.current) listRef.current.style.width = `${listWidthRef.current}px`;
          }}
          onResizeEnd={() => {
            setListWidth(listWidthRef.current);
            localStorage.setItem(LIST_WIDTH_KEY, String(listWidthRef.current));
          }}
        />
      )}

      {embedMode && conn && (
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          {/* Tab bar */}
          <div
            ref={tabBarRef}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 2,
              padding: "4px 8px 0",
              background: T.titlebar,
              borderBottom: `1px solid ${T.border}`,
              flexShrink: 0,
              overflowX: "auto",
            }}
          >
            {/* Toggle to open/close the repos list. */}
            <button
              onClick={() => setListCollapsed((v) => !v)}
              title={listCollapsed ? "Show sessions list" : "Hide sessions list"}
              style={{
                background: "transparent",
                border: `1px solid ${T.border}`,
                borderRadius: 5,
                color: T.textDim,
                cursor: "pointer",
                fontSize: 13,
                lineHeight: 1,
                padding: "4px 8px",
                marginRight: 4,
                marginBottom: 4,
                flexShrink: 0,
              }}
            >
              {listCollapsed ? "»" : "«"}
            </button>
            {tabs.map((t) => {
              const active = t.vid === activeVid;
              // A tab restored from localStorage can outlive its session (or
              // precede the first poll) — no info means the old plain-green dot.
              const info = sessions.find((s) => s.viewer_id === t.vid);
              const name = repoName(t.cwd);
              return (
                <div
                  key={t.vid}
                  data-tabvid={t.vid}
                  onClick={() => {
                    if (suppressTabClick.current) return;
                    focusTab(t.vid);
                  }}
                  onPointerDown={(e) => onTabPointerDown(e, t.vid)}
                  title={t.cwd}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "5px 10px",
                    borderRadius: "7px 7px 0 0",
                    background: active ? T.surface : T.surface1,
                    border: `1px solid ${draggingVid === t.vid ? T.accentBorder : T.border}`,
                    borderBottom:
                      active && draggingVid !== t.vid
                        ? `1px solid ${T.surface}`
                        : `1px solid ${draggingVid === t.vid ? T.accentBorder : T.border}`,
                    marginBottom: -1,
                    cursor: draggingVid === t.vid ? "grabbing" : "pointer",
                    opacity: draggingVid === t.vid ? 0.8 : 1,
                    maxWidth: 200,
                    flexShrink: 0,
                    userSelect: "none",
                    touchAction: "none",
                  }}
                >
                  <span
                    title={info ? stateTitle(info) : undefined}
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: "50%",
                      background: info ? stateColor(info) : T.success,
                      flexShrink: 0,
                    }}
                  />
                  <span
                    style={{
                      fontSize: 12,
                      color: active ? T.text : T.textDim,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {t.isTerminal && (
                      <span style={{ fontFamily: T.mono, color: T.path }}>❯ </span>
                    )}
                    {name}
                  </span>
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(t.vid);
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                    title="Close tab (session keeps running) — ⌘W"
                    style={{ color: T.textFaint, fontSize: 12, padding: "0 2px", cursor: "pointer" }}
                  >
                    ✕
                  </span>
                </div>
              );
            })}
            <div style={{ flex: 1 }} />
            {/* Split layout picker — tmux-style panes without tmux. */}
            <span style={{ display: "flex", gap: 2, marginBottom: 4, marginRight: 6, flexShrink: 0 }}>
              {LAYOUT_CHOICES.map((c) => (
                <button
                  key={c.id}
                  onClick={() => applyLayout(c.id)}
                  title={c.label}
                  style={{
                    ...slimBtnStyle,
                    padding: "2px 7px",
                    fontSize: 12,
                    lineHeight: 1.3,
                    ...(layout === c.id
                      ? {
                          color: T.accent,
                          border: `1px solid ${T.accentBorder}`,
                          background: T.accentSoft,
                        }
                      : {}),
                  }}
                >
                  {c.glyph}
                </button>
              ))}
            </span>
            {tabs.length > 0 && (
              <button
                onClick={closeAllTabs}
                style={{ ...slimBtnStyle, marginBottom: 4, marginRight: 4 }}
                title="Close all open tabs (sessions keep running)"
              >
                ✕ Close all
              </button>
            )}
            {activeVid && (
              <button
                onClick={handlePopOut}
                style={{ ...slimBtnStyle, marginBottom: 4 }}
                title="Move the active tab to its own window"
              >
                ⧉ Open in window
              </button>
            )}
          </div>

          {/* Panes: all tabs stay mounted so every session renders live; the
              split layout positions the visible ones into slots (styles only —
              no reparenting, so terminals never reconnect on layout changes). */}
          <div
            ref={paneAreaRef}
            style={{
              flex: 1,
              minHeight: 0,
              position: "relative",
              ["--px" as string]: initialSplits.x,
              ["--py" as string]: initialSplits.y,
            } as React.CSSProperties}
          >
            {tabs.map((t) => {
              const slot = paneVids.indexOf(t.vid);
              const visible = slot !== -1;
              const isActivePane = visible && t.vid === activeVid && layout !== "1";
              return (
                <div
                  key={t.vid}
                  onMouseDownCapture={
                    visible && layout !== "1"
                      ? () => {
                          if (activeVidRef.current !== t.vid) {
                            activeVidRef.current = t.vid;
                            setActiveVid(t.vid);
                          }
                        }
                      : undefined
                  }
                  style={{
                    position: "absolute",
                    ...(visible ? paneRect(layout, slot) : {}),
                    display: visible ? "flex" : "none",
                    flexDirection: "column",
                    ...(visible && layout !== "1"
                      ? {
                          border: `1px solid ${isActivePane ? T.accentBorder : T.divider}`,
                        }
                      : {}),
                  }}
                >
                  <TabPane
                    vid={t.vid}
                    port={String(conn.port)}
                    token={conn.token}
                    cwd={t.cwd}
                    isTerminal={t.isTerminal}
                    isVisible={visible}
                  />
                </div>
              );
            })}
            {/* Empty split slots invite a pick from the list/tab bar. */}
            {layout !== "1" &&
              paneVids.map((v, i) =>
                v === null ? (
                  <div
                    key={`empty-${i}`}
                    style={{
                      position: "absolute",
                      ...paneRect(layout, i),
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      border: `1px dashed ${T.divider}`,
                      fontFamily: T.serif,
                      fontStyle: "italic",
                      color: T.textFaint,
                      fontSize: 12.5,
                      textAlign: "center",
                      padding: 16,
                    }}
                  >
                    empty pane — open a session or click a tab
                  </div>
                ) : null
              )}
            {/* Resizable split boundaries. */}
            {(layout === "2c" || layout === "4") && (
              <PaneDivider axis="x" areaRef={paneAreaRef} />
            )}
            {(layout === "2r" || layout === "4") && (
              <PaneDivider axis="y" areaRef={paneAreaRef} />
            )}
            {tabs.length === 0 && (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontFamily: T.serif,
                  fontStyle: "italic",
                  color: T.textFaint,
                  fontSize: 14,
                  textAlign: "center",
                  padding: 24,
                  lineHeight: 1.7,
                }}
              >
                Select a session — it opens as a tab here.
                <br />
                New Session, Terminal, Open, and Resume all add tabs.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const pathStyle: React.CSSProperties = {
  fontFamily: T.mono,
  fontSize: 10.5,
  color: T.textFaint,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

/** Small mono metadata chip — branch, worktree marker, checkout tag. */
const chipStyle: React.CSSProperties = {
  fontFamily: T.mono,
  fontSize: 9.5,
  lineHeight: "15px",
  color: T.textDim,
  background: T.surface2,
  border: `1px solid ${T.border}`,
  borderRadius: 999,
  padding: "0 7px",
  flexShrink: 0,
  maxWidth: 170,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

/** A linked worktree reads accented — it's the thing you'd otherwise mistake
 *  for the main checkout. */
const worktreeChipStyle: React.CSSProperties = {
  ...chipStyle,
  color: T.accent,
  border: `1px solid ${T.accentBorder}`,
};

const searchWrapStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 9,
  background: T.surface1,
  border: `1px solid ${T.border}`,
  borderRadius: 10,
  padding: "9px 13px",
  marginBottom: 30,
};

const primaryBtnStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 7,
  fontFamily: T.serif,
  fontSize: 13,
  fontWeight: 600,
  color: T.accentInk,
  background: T.accent,
  border: "none",
  borderRadius: 9,
  padding: "9px 18px",
  cursor: "pointer",
  whiteSpace: "nowrap",
  flexShrink: 0,
};

const terminalBtnStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 7,
  fontFamily: T.serif,
  fontSize: 13,
  fontWeight: 600,
  color: T.text,
  background: T.surface1,
  border: `1px solid ${T.borderStrong}`,
  borderRadius: 9,
  padding: "9px 16px",
  cursor: "pointer",
  whiteSpace: "nowrap",
  flexShrink: 0,
};

const termMenuItemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  width: "100%",
  background: "transparent",
  border: "none",
  borderRadius: 7,
  color: T.text,
  cursor: "pointer",
  fontSize: 12.5,
  fontWeight: 600,
  padding: "8px 10px",
  textAlign: "left",
};

/** Amber-tinted outline — the primary per-card action. */
const resumeBtnStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: T.accent,
  border: `1px solid ${T.accentBorder}`,
  borderRadius: 7,
  padding: "5px 14px",
  background: T.accentSoft,
  cursor: "pointer",
  flexShrink: 0,
  whiteSpace: "nowrap",
};

/** Quiet outline used inside recent rows. */
const resumeRowBtnStyle: React.CSSProperties = {
  fontSize: 12,
  color: T.textDim,
  border: `1px solid ${T.border}`,
  borderRadius: 7,
  padding: "4px 12px",
  background: "transparent",
  cursor: "pointer",
  flexShrink: 0,
  whiteSpace: "nowrap",
};

const secondaryBtnStyle: React.CSSProperties = {
  background: T.surface2,
  border: `1px solid ${T.borderStrong}`,
  borderRadius: 8,
  color: T.text,
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 600,
  padding: "6px 13px",
  flexShrink: 0,
};

const iconBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: `1px solid ${T.borderStrong}`,
  borderRadius: 8,
  color: T.textDim,
  cursor: "pointer",
  fontSize: 12,
  padding: "3px 9px",
  flexShrink: 0,
};

const segToggleStyle: React.CSSProperties = {
  display: "flex",
  gap: 2,
  background: T.surface1,
  border: `1px solid ${T.border}`,
  borderRadius: 8,
  padding: 2,
};

const slimBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: `1px solid ${T.borderStrong}`,
  borderRadius: 4,
  color: T.textDim,
  cursor: "pointer",
  fontSize: 11,
  padding: "2px 8px",
};

const pastRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 12,
  padding: "10px 12px",
  borderBottom: `1px solid ${T.divider}`,
  borderRadius: 7,
  cursor: "pointer",
};

const hooksCardStyle: React.CSSProperties = {
  background: T.surface1,
  border: `1px solid ${T.border}`,
  borderRadius: 12,
  padding: "14px 16px",
  display: "flex",
  alignItems: "center",
  gap: 14,
};
