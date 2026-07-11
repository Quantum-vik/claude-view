import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import SessionWindow from "./SessionWindow";
import { DragHandle, clamp } from "./Resizer";
import { T, tint } from "./tokens";
import ContextMeter from "./ContextMeter";

const PAGE_SIZE = 10;
/** Launcher width at/above which sessions embed in a right-hand pane. */
const SPLIT_MIN_WIDTH = 1100;
/** Left column width in split mode. */
const LIST_WIDTH = 640;

interface SessionInfo {
  viewer_id: string;
  session_id: string | null;
  cwd: string;
  ended: boolean;
}

interface PastSession {
  session_id: string;
  cwd: string;
  modifiedMs: number;
  preview: string | null;
  model: string | null;
  contextTokens: number | null;
}

interface ConnInfo {
  port: number;
  token: string;
}

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

/** "claude-opus-4-8" / "claude-haiku-4-5-20251001" -> "opus-4-8" / "haiku-4-5" */
function prettyModel(model: string): string {
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
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

/** Opus reads violet; everything else uses the calm path-blue chip. */
function modelChipColor(model: string): string {
  return /opus/i.test(model) ? T.modelViolet : T.path;
}

/** Sentence-case section label with a thin divider rule and optional chevron
 *  collapse, a status pill, and a right-aligned control slot. */
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
        gap: 8,
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
          fontSize: 12,
          fontWeight: 600,
          color: T.textDim,
          letterSpacing: 0.3,
          margin: 0,
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
  const [tabs, setTabs] = useState<{ vid: string; cwd: string }[]>([]);
  const [activeVid, setActiveVid] = useState<string | null>(null);
  // Split-pane sizing: the repos list is resizable and can be collapsed so the
  // session pane takes the full width.
  const [listWidth, setListWidth] = useState(LIST_WIDTH);
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
  // Mirror of activeVid readable synchronously (avoids stale-closure in
  // closeTab, which decides the next active tab).
  const activeVidRef = useRef<string | null>(null);
  useEffect(() => {
    activeVidRef.current = activeVid;
  }, [activeVid]);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= SPLIT_MIN_WIDTH);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // ⌘K / Ctrl+K focuses the search input.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const refreshHooks = useCallback(async () => {
    try {
      setHooksInstalled(await invoke<boolean>("hooks_status"));
    } catch {
      setHooksInstalled(false);
    }
  }, []);

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await invoke<SessionInfo[]>("list_sessions"));
    } catch {
      // backend not ready yet
    }
  }, []);

  const refreshPast = useCallback(async () => {
    setPastLoading(true);
    try {
      setPast(await invoke<PastSession[]>("list_past_sessions"));
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

  const embedMode = wide && conn !== null;

  /** Add a session as a tab (or focus its existing tab). */
  function openInPane(vid: string, cwd: string) {
    setTabs((prev) => (prev.some((t) => t.vid === vid) ? prev : [...prev, { vid, cwd }]));
    setActiveVid(vid);
  }

  function closeTab(vid: string) {
    setTabs((prev) => {
      const next = prev.filter((t) => t.vid !== vid);
      // Read the current active tab synchronously via the ref, not the closure.
      if (activeVidRef.current === vid) {
        const nextActive = next.length ? next[next.length - 1].vid : null;
        activeVidRef.current = nextActive;
        setActiveVid(nextActive);
      }
      return next;
    });
    // If the session has already ended, closing its tab is a good moment to
    // reclaim its backend resources (PTY fds, scrollback). Live sessions are
    // left running so closing a tab doesn't kill them.
    const ended = sessions.find((s) => s.viewer_id === vid)?.ended ?? false;
    if (ended) {
      invoke("close_session", { viewerId: vid }).then(refreshSessions).catch(() => {});
    }
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

  async function handleResume(s: PastSession) {
    await launch(s.cwd, s.session_id);
  }

  async function handleFocus(s: SessionInfo) {
    if (embedMode) {
      openInPane(s.viewer_id, s.cwd);
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

  // Group past sessions by directory; groups ordered by most recent activity.
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
      const list = map.get(s.cwd) ?? [];
      list.push(s);
      map.set(s.cwd, list);
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
  // Busiest repo's session count — used to scale each group's usage bar.
  const maxGroupCount = Math.max(1, ...grouped.map(([, l]) => l.length));

  function handleGroupScroll(dir: string, total: number, el: HTMLDivElement) {
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) {
      setPageCounts((prev) => {
        const current = prev[dir] ?? PAGE_SIZE;
        if (current >= total) return prev;
        return { ...prev, [dir]: current + PAGE_SIZE };
      });
    }
  }

  const activeOpen = !collapsedSections.has("active");
  const pastOpen = !collapsedSections.has("past");

  const listColumn = (
    <div
      style={{
        width: embedMode ? listWidth : "100%",
        flexShrink: 0,
        height: "100%",
        overflowY: "auto",
        display: "flex",
        justifyContent: "center",
        background: T.surface,
      }}
    >
      <div style={{ width: "100%", maxWidth: 660, padding: "28px 28px 40px" }}>
        {/* Header + primary action */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 16,
            marginBottom: 22,
          }}
        >
          <div>
            <h1 style={{ fontSize: 21, fontWeight: 700, margin: 0, letterSpacing: -0.4, color: T.text }}>
              Sessions
            </h1>
            <p style={{ fontSize: 13, color: T.textDim, margin: "5px 0 0" }}>
              Live mirror for Claude Code CLI
            </p>
          </div>
          <button onClick={handleNewSession} style={primaryBtnStyle}>
            <span style={{ fontSize: 16, lineHeight: 1 }}>+</span> New Session
          </button>
        </div>
        {newSessionError && (
          <div style={{ marginTop: -12, marginBottom: 16, color: T.error, fontSize: 12 }}>
            {newSessionError}
          </div>
        )}

        {/* Search-first */}
        <div style={searchWrapStyle}>
          <span style={{ color: T.textFaint, fontSize: 15 }}>⌕</span>
          <input
            ref={searchRef}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search a directory or prompt to resume…"
            style={{
              flex: 1,
              background: "transparent",
              border: "none",
              color: T.text,
              fontSize: 13.5,
              outline: "none",
              fontFamily: "inherit",
            }}
          />
          <span
            onClick={() => searchRef.current?.focus()}
            style={{
              fontFamily: T.mono,
              fontSize: 11,
              color: T.textFaint,
              background: T.surface2,
              border: `1px solid ${T.border}`,
              borderRadius: 5,
              padding: "2px 6px",
              cursor: "pointer",
            }}
          >
            ⌘K
          </span>
        </div>

        {/* Active now */}
        <div style={{ marginBottom: 26 }}>
          <SectionRow
            label="Active now"
            open={activeOpen}
            onToggle={() => toggleSection("active")}
            pill={
              activeLive > 0 ? (
                <span
                  style={{
                    fontFamily: T.mono,
                    fontSize: 11,
                    color: T.success,
                    background: tint(T.success, 0.12),
                    borderRadius: 999,
                    padding: "2px 8px",
                  }}
                >
                  {activeLive} live
                </span>
              ) : undefined
            }
          />
          {activeOpen &&
            (sessions.length === 0 ? (
              <p style={{ color: T.textFaint, fontSize: 13, margin: 0 }}>
                No mirrored sessions yet — start one above or resume a recent one below.
              </p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {sessions.map((s) => {
                  const selected = activeVid === s.viewer_id;
                  return (
                    <div
                      key={s.viewer_id}
                      style={{
                        ...cardStyle,
                        border: `1px solid ${selected ? T.borderAccent : T.border}`,
                        padding: "13px 15px",
                      }}
                    >
                      <span
                        style={{
                          width: 9,
                          height: 9,
                          borderRadius: "50%",
                          background: s.ended ? T.idle : T.success,
                          flexShrink: 0,
                          animation: !s.ended && selected ? "ring 2s ease-out infinite" : undefined,
                        }}
                      />
                      <div style={{ flex: 1, overflow: "hidden" }}>
                        <div style={{ fontSize: 14, fontWeight: 600, color: T.text }}>
                          {repoName(s.cwd)}
                        </div>
                        <div style={{ ...pathStyle, marginTop: 2 }} title={s.cwd}>
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
                          onClick={() => handleFocus(s)}
                          style={selected ? accentBtnStyle : secondaryBtnStyle}
                        >
                          {embedMode ? "Open" : "Focus"}
                        </button>
                      )}
                    </div>
                  );
                })}
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
                          background: sortBy === key ? T.borderAccent : "transparent",
                          border: "none",
                          borderRadius: 6,
                          color: sortBy === key ? "#cfe2ff" : T.textDim,
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
              {pastLoading && past.length === 0 ? (
                <p style={{ color: T.textFaint, fontSize: 13 }}>Scanning…</p>
              ) : grouped.length === 0 ? (
                <p style={{ color: T.textFaint, fontSize: 13 }}>
                  {filter ? "No sessions match your search." : "No past sessions found."}
                </p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  {grouped.map(([dir, list], rank) => {
                    const shown = Math.min(pageCounts[dir] ?? PAGE_SIZE, list.length);
                    const visible = list.slice(0, shown);
                    const dirOpen = !collapsedSections.has("dir:" + dir);
                    return (
                      <div key={dir}>
                        {/* Workspace group header */}
                        <div
                          onClick={() => toggleSection("dir:" + dir)}
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
                              fontFamily: T.mono,
                              fontSize: 12,
                              color: T.path,
                              fontWeight: 500,
                              flexShrink: 0,
                            }}
                          >
                            {repoName(dir)}
                          </span>
                          <span
                            style={{
                              fontSize: 11,
                              color: T.textFaint,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {prettyParent(dir)} · {list.length} session{list.length === 1 ? "" : "s"}
                          </span>
                        </div>

                        {/* Usage bar — this repo's session count vs the busiest repo. */}
                        {(() => {
                          const frac = list.length / maxGroupCount;
                          // Heavier usage skews violet; lighter stays blue.
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
                              onScroll={(e) => handleGroupScroll(dir, list.length, e.currentTarget)}
                              style={{
                                display: "flex",
                                flexDirection: "column",
                                gap: 7,
                                maxHeight: 320,
                                overflowY: "auto",
                                paddingRight: 4,
                              }}
                            >
                              {visible.map((s) => (
                                <div key={s.session_id} style={pastCardStyle}>
                                  <div style={{ flex: 1, overflow: "hidden" }}>
                                    <div
                                      style={{
                                        fontSize: 13,
                                        color: T.text,
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                        whiteSpace: "nowrap",
                                      }}
                                      title={s.preview ?? s.session_id}
                                    >
                                      {s.preview}
                                    </div>
                                    <div
                                      style={{
                                        display: "flex",
                                        alignItems: "center",
                                        gap: 8,
                                        marginTop: 5,
                                      }}
                                    >
                                      <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textFaint }}>
                                        {relativeTime(s.modifiedMs)}
                                      </span>
                                      {/* "<synthetic>" marks injected stub messages, not a model */}
                                      {s.model && !s.model.startsWith("<") && (
                                        <span
                                          style={{
                                            fontSize: 10.5,
                                            color: modelChipColor(s.model),
                                            background: tint(modelChipColor(s.model), 0.13),
                                            borderRadius: 6,
                                            padding: "1px 7px",
                                          }}
                                          title={s.model}
                                        >
                                          {prettyModel(s.model)}
                                        </span>
                                      )}
                                      {s.contextTokens != null && s.contextTokens > 0 && (
                                        <ContextMeter
                                          tokens={s.contextTokens}
                                          modelId={s.model}
                                          width={40}
                                          compact
                                        />
                                      )}
                                    </div>
                                  </div>
                                  <button onClick={() => handleResume(s)} style={secondaryBtnStyle}>
                                    Resume
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
            <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>
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

      {/* Drag handle between the list and the session pane. */}
      {embedMode && !listCollapsed && (
        <DragHandle
          title="Drag to resize the sessions list"
          onResize={(dx) => setListWidth((w) => clamp(w + dx, 320, window.innerWidth - 420))}
        />
      )}

      {embedMode && conn && (
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          {/* Tab bar */}
          <div
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
              const ended = sessions.find((s) => s.viewer_id === t.vid)?.ended ?? false;
              const name = repoName(t.cwd);
              return (
                <div
                  key={t.vid}
                  onClick={() => setActiveVid(t.vid)}
                  title={t.cwd}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "5px 10px",
                    borderRadius: "7px 7px 0 0",
                    background: active ? T.surface : T.surface1,
                    border: `1px solid ${T.border}`,
                    borderBottom: active ? `1px solid ${T.surface}` : `1px solid ${T.border}`,
                    marginBottom: -1,
                    cursor: "pointer",
                    maxWidth: 200,
                    flexShrink: 0,
                  }}
                >
                  <span
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: "50%",
                      background: ended ? T.idle : T.success,
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
                    {name}
                  </span>
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(t.vid);
                    }}
                    title="Close tab (session keeps running)"
                    style={{ color: T.textFaint, fontSize: 12, padding: "0 2px", cursor: "pointer" }}
                  >
                    ✕
                  </span>
                </div>
              );
            })}
            <div style={{ flex: 1 }} />
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

          {/* Panes: all tabs stay mounted so every session renders live;
              only the active one is visible. */}
          <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
            {tabs.map((t) => (
              <div
                key={t.vid}
                style={{
                  position: "absolute",
                  inset: 0,
                  display: t.vid === activeVid ? "flex" : "none",
                  flexDirection: "column",
                }}
              >
                <SessionWindow
                  vid={t.vid}
                  port={String(conn.port)}
                  token={conn.token}
                  cwd={t.cwd}
                  embedded
                />
              </div>
            ))}
            {tabs.length === 0 && (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: T.textFaint,
                  fontSize: 14,
                  textAlign: "center",
                  padding: 24,
                }}
              >
                Select a session — it opens as a tab here.
                <br />
                New Session, Open, and Focus all add tabs.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  background: T.surface1,
  border: `1px solid ${T.border}`,
  borderRadius: 12,
  padding: "13px 15px",
  display: "flex",
  alignItems: "center",
  gap: 13,
};

const pastCardStyle: React.CSSProperties = {
  background: T.surface1,
  border: `1px solid ${T.border}`,
  borderRadius: 11,
  padding: "11px 14px",
  display: "flex",
  alignItems: "center",
  gap: 12,
};

const pathStyle: React.CSSProperties = {
  fontFamily: T.mono,
  fontSize: 11.5,
  color: T.path,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const searchWrapStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  background: T.surface1,
  border: `1px solid ${T.border}`,
  borderRadius: 10,
  padding: "0 12px",
  height: 42,
  marginBottom: 22,
};

const primaryBtnStyle: React.CSSProperties = {
  background: T.accent,
  border: "none",
  borderRadius: 9,
  color: T.accentInk,
  cursor: "pointer",
  fontSize: 14,
  fontWeight: 600,
  padding: "10px 18px",
  display: "flex",
  alignItems: "center",
  gap: 7,
  boxShadow: "0 4px 14px rgba(91,157,255,0.28)",
  flexShrink: 0,
};

const accentBtnStyle: React.CSSProperties = {
  background: T.accent,
  border: "none",
  borderRadius: 8,
  color: T.accentInk,
  cursor: "pointer",
  fontSize: 12.5,
  fontWeight: 600,
  padding: "7px 15px",
  flexShrink: 0,
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

const hooksCardStyle: React.CSSProperties = {
  background: "linear-gradient(180deg,#1a1d22,#1c1f24)",
  border: `1px solid ${T.border}`,
  borderRadius: 12,
  padding: "14px 16px",
  display: "flex",
  alignItems: "center",
  gap: 14,
};
