import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import SessionWindow from "./SessionWindow";
import { DragHandle, clamp } from "./Resizer";

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
  // Mirror of activeVid readable synchronously (avoids stale-closure in
  // closeTab, which decides the next active tab).
  const activeVidRef = useRef<string | null>(null);
  useEffect(() => {
    activeVidRef.current = activeVid;
  }, [activeVid]);

  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= SPLIT_MIN_WIDTH);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
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

  function handleGroupScroll(dir: string, total: number, el: HTMLDivElement) {
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) {
      setPageCounts((prev) => {
        const current = prev[dir] ?? PAGE_SIZE;
        if (current >= total) return prev;
        return { ...prev, [dir]: current + PAGE_SIZE };
      });
    }
  }

  const listColumn = (
    <div
      style={{
        width: embedMode ? listWidth : "100%",
        flexShrink: 0,
        height: "100%",
        overflowY: "auto",
        display: "flex",
        justifyContent: "center",
      }}
    >
      <div style={{ width: "100%", maxWidth: 620, padding: "40px 24px 0" }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: "#e8e8e8", letterSpacing: -0.5 }}>
          Claude View
        </h1>
        <p style={{ fontSize: 13, color: "#777", marginTop: 4, marginBottom: 16 }}>
          Live mirror for Claude Code CLI sessions
        </p>

        {/* Hooks toggle bar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            background: "#202021",
            border: "1px solid #2e2e2e",
            borderRadius: 8,
            padding: "10px 14px",
            marginBottom: 24,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#d4d4d4" }}>
              Timeline hooks{" "}
              {hooksInstalled === null ? (
                <span style={{ color: "#666", fontWeight: 400 }}>· checking…</span>
              ) : hooksInstalled ? (
                <span style={{ color: "#2ea043", fontWeight: 400 }}>· on</span>
              ) : (
                <span style={{ color: "#888", fontWeight: 400 }}>· off</span>
              )}
            </div>
            <div style={{ fontSize: 11, color: "#666", marginTop: 2 }}>
              {hooksMessage && !hooksBusy
                ? hooksMessage
                : "On: cards appear live. Off: the timeline still fills in from the session transcript, a little delayed."}
            </div>
          </div>
          {/* Toggle switch */}
          <button
            onClick={toggleHooks}
            disabled={hooksBusy || hooksInstalled === null}
            title={hooksInstalled ? "Uninstall hooks" : "Install hooks"}
            style={{
              position: "relative",
              width: 44,
              height: 24,
              borderRadius: 12,
              border: "none",
              flexShrink: 0,
              cursor: hooksBusy || hooksInstalled === null ? "default" : "pointer",
              background: hooksInstalled ? "#2ea043" : "#3a3a3a",
              opacity: hooksBusy ? 0.6 : 1,
              transition: "background 0.15s",
              padding: 0,
            }}
          >
            <span
              style={{
                position: "absolute",
                top: 3,
                left: hooksInstalled ? 23 : 3,
                width: 18,
                height: 18,
                borderRadius: "50%",
                background: "#fff",
                transition: "left 0.15s",
              }}
            />
          </button>
        </div>

        {/* New Session */}
        <section style={sectionStyle}>
          <button onClick={handleNewSession} style={primaryBtnStyle}>
            + New Session
          </button>
          {newSessionError && (
            <div style={{ marginTop: 8, color: "#f85149", fontSize: 12 }}>{newSessionError}</div>
          )}
        </section>

        {/* Active (mirrored) sessions */}
        <section style={sectionStyle}>
          <h2 style={sectionTitleStyle}>Active in viewer</h2>
          {sessions.length === 0 ? (
            <p style={{ color: "#555", fontSize: 13, margin: 0 }}>No mirrored sessions yet.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {sessions.map((s) => (
                <div
                  key={s.viewer_id}
                  style={{
                    ...cardStyle,
                    border:
                      activeVid === s.viewer_id ? "1px solid #1a6cc4" : cardStyle.border,
                  }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: s.ended ? "#555" : "#2ea043",
                      flexShrink: 0,
                    }}
                  />
                  <div style={{ flex: 1, overflow: "hidden" }}>
                    <div style={pathStyle} title={s.cwd}>
                      {s.cwd}
                    </div>
                    <div style={{ fontSize: 11, color: "#666", marginTop: 2 }}>
                      {s.session_id ? `#${s.session_id.slice(0, 8)}` : "live · id pending (needs hooks)"}
                      {s.ended && <span style={{ marginLeft: 8, color: "#f85149" }}>ended</span>}
                    </div>
                  </div>
                  {!s.ended && (
                    <button onClick={() => handleFocus(s)} style={secondaryBtnStyle}>
                      {embedMode ? "View" : "Focus"}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Past sessions browser */}
        <section style={sectionStyle}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <h2 style={{ ...sectionTitleStyle, margin: 0, flex: "none" }}>Past sessions</h2>
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="filter by directory or prompt…"
              style={{
                flex: 1,
                background: "#252526",
                border: "1px solid #333",
                borderRadius: 5,
                color: "#d4d4d4",
                fontSize: 12,
                padding: "4px 8px",
                outline: "none",
              }}
            />
            <button onClick={refreshPast} style={secondaryBtnStyle} title="Rescan ~/.claude/projects">
              ↻
            </button>
          </div>
          <div style={{ display: "flex", gap: 4, marginBottom: 10 }}>
            {(
              [
                ["recent", "Recent"],
                ["count", "Most sessions"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setSortBy(key)}
                style={{
                  ...secondaryBtnStyle,
                  background: sortBy === key ? "#0e4d92" : "transparent",
                  borderColor: sortBy === key ? "#1a6cc4" : "#444",
                  color: sortBy === key ? "#e0e8f8" : "#c8c8c8",
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <p style={{ fontSize: 11, color: "#666", margin: "0 0 10px" }}>
            Every Claude Code session found on this machine. <b>Open</b> resumes it{" "}
            {embedMode ? "in the pane on the right" : "in a mirrored window"} — exit it in its
            original terminal first if it's still running there.
          </p>

          {pastLoading && past.length === 0 ? (
            <p style={{ color: "#555", fontSize: 13 }}>Scanning…</p>
          ) : grouped.length === 0 ? (
            <p style={{ color: "#555", fontSize: 13 }}>
              {filter ? "No sessions match the filter." : "No past sessions found."}
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 8 }}>
              {grouped.map(([dir, list], rank) => {
                const shown = Math.min(pageCounts[dir] ?? PAGE_SIZE, list.length);
                const visible = list.slice(0, shown);
                return (
                  <div key={dir}>
                    <div
                      style={{
                        ...pathStyle,
                        fontSize: 12,
                        color: "#79b8ff",
                        marginBottom: 6,
                        maxWidth: "100%",
                      }}
                      title={dir}
                    >
                      {sortBy === "count" && (
                        <span style={{ color: "#d29922", fontWeight: 700 }}>#{rank + 1} </span>
                      )}
                      {dir}{" "}
                      <span style={{ color: "#555", fontFamily: "system-ui" }}>
                        ({list.length} session{list.length === 1 ? "" : "s"})
                      </span>
                    </div>
                    <div
                      onScroll={(e) => handleGroupScroll(dir, list.length, e.currentTarget)}
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 6,
                        maxHeight: 290,
                        overflowY: "auto",
                        paddingRight: 4,
                      }}
                    >
                      {visible.map((s) => (
                        <div key={s.session_id} style={{ ...cardStyle, padding: "8px 12px" }}>
                          <div style={{ flex: 1, overflow: "hidden" }}>
                            <div
                              style={{
                                fontSize: 12,
                                color: "#c8c8c8",
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
                                fontSize: 11,
                                color: "#666",
                                marginTop: 2,
                                fontFamily: "Menlo, monospace",
                                display: "flex",
                                alignItems: "center",
                                gap: 6,
                              }}
                            >
                              <span>
                                #{s.session_id.slice(0, 8)} · {relativeTime(s.modifiedMs)}
                              </span>
                              {/* "<synthetic>" marks injected stub messages, not a model */}
                              {s.model && !s.model.startsWith("<") && (
                                <span
                                  style={{
                                    background: "#1f2a3a",
                                    color: "#79b8ff",
                                    borderRadius: 8,
                                    padding: "0 7px",
                                    fontSize: 10,
                                    lineHeight: "16px",
                                  }}
                                  title={s.model}
                                >
                                  {prettyModel(s.model)}
                                </span>
                              )}
                            </div>
                          </div>
                          <button onClick={() => handleResume(s)} style={secondaryBtnStyle}>
                            Open
                          </button>
                        </div>
                      ))}
                    </div>
                    {list.length > shown ? (
                      <div style={{ fontSize: 11, color: "#666", marginTop: 5 }}>
                        showing {shown} of {list.length} — scroll the list for more
                      </div>
                    ) : (
                      list.length > PAGE_SIZE && (
                        <div style={{ fontSize: 11, color: "#666", marginTop: 5 }}>
                          all {list.length} shown
                        </div>
                      )
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

      </div>
    </div>
  );

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        background: "#1e1e1e",
        color: "#d4d4d4",
        fontFamily: "system-ui, -apple-system, sans-serif",
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
              background: "#161617",
              borderBottom: "1px solid #2a2a2a",
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
                border: "1px solid #333",
                borderRadius: 5,
                color: "#c8c8c8",
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
              const name = t.cwd.split("/").filter(Boolean).pop() ?? t.cwd;
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
                    background: active ? "#1e1e1e" : "#232324",
                    border: "1px solid #2a2a2a",
                    borderBottom: active ? "1px solid #1e1e1e" : "1px solid #2a2a2a",
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
                      background: ended ? "#555" : "#2ea043",
                      flexShrink: 0,
                    }}
                  />
                  <span
                    style={{
                      fontSize: 12,
                      color: active ? "#e0e0e0" : "#999",
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
                    style={{ color: "#777", fontSize: 12, padding: "0 2px", cursor: "pointer" }}
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
                  color: "#555",
                  fontSize: 14,
                  textAlign: "center",
                  padding: 24,
                }}
              >
                Select a session — it opens as a tab here.
                <br />
                New Session, Open, and View all add tabs.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const sectionStyle: React.CSSProperties = {
  marginBottom: 28,
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: "#888",
  letterSpacing: 0.8,
  textTransform: "uppercase",
  margin: "0 0 12px",
};

const cardStyle: React.CSSProperties = {
  background: "#252526",
  border: "1px solid #333",
  borderRadius: 8,
  padding: "10px 14px",
  display: "flex",
  alignItems: "center",
  gap: 10,
};

const pathStyle: React.CSSProperties = {
  fontFamily: "Menlo, Monaco, monospace",
  fontSize: 12,
  color: "#9cdcfe",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const primaryBtnStyle: React.CSSProperties = {
  background: "#0e4d92",
  border: "1px solid #1a6cc4",
  borderRadius: 6,
  color: "#e0e8f8",
  cursor: "pointer",
  fontSize: 13,
  fontWeight: 600,
  padding: "7px 18px",
};

const secondaryBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: "1px solid #444",
  borderRadius: 5,
  color: "#c8c8c8",
  cursor: "pointer",
  fontSize: 12,
  padding: "4px 12px",
  flexShrink: 0,
};

const slimBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: "1px solid #3a3a3a",
  borderRadius: 4,
  color: "#aaa",
  cursor: "pointer",
  fontSize: 11,
  padding: "2px 8px",
};
