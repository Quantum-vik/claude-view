import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Terminal from "./Terminal";
import { ConnectionStatus } from "./ws";
import { T } from "./tokens";
import ThemeMenu from "./ThemeMenu";

/** Split a cwd into a dim parent prefix and the bright leaf name, compressing a
 *  leading /Users/<name>/ or /home/<name>/ to ~/. (Mirrors SessionWindow.) */
function breadcrumb(cwd: string): { parent: string; name: string } {
  if (!cwd) return { parent: "", name: "(no cwd)" };
  const home = cwd.replace(/^\/(?:Users|home)\/[^/]+\//, "~/");
  const segs = home.split("/").filter(Boolean);
  const name = segs.length ? segs[segs.length - 1] : home;
  const parent = home.slice(0, home.length - name.length);
  return { parent, name };
}

interface TerminalWindowProps {
  /** When set, connection details come from props (embedded in the launcher's
   *  split pane) instead of the window URL. */
  vid?: string;
  port?: string;
  token?: string;
  cwd?: string;
  embedded?: boolean;
}

/** A terminal-only viewer: the same live PTY mirror as a Claude session, minus
 *  the claude-specific chrome (no timeline, model switcher, context meter, or
 *  hooks chip) — because a shell/tmux terminal has no transcript to drive them.
 *  Deliberately its own component so it doesn't touch SessionWindow. */
export default function TerminalWindow(props: TerminalWindowProps = {}) {
  const params = new URLSearchParams(window.location.search);
  const vid = props.vid ?? params.get("vid") ?? "";
  const port = props.port ?? params.get("port") ?? "";
  const token = props.token ?? params.get("token") ?? "";
  // URLSearchParams already percent-decodes.
  const cwd = props.cwd ?? params.get("cwd") ?? "";

  const [ended, setEnded] = useState(false);
  const [connStatus, setConnStatus] = useState<ConnectionStatus>("connecting");

  function handleControl(raw: unknown) {
    if ((raw as { type?: string })?.type === "exit") setEnded(true);
  }

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
          background: T.titlebar,
          borderBottom: `1px solid ${T.divider}`,
          flexShrink: 0,
          height: 46,
        }}
      >
        {/* Terminal glyph */}
        <span style={{ fontFamily: T.mono, fontSize: 13, color: T.path, flexShrink: 0 }}>❯_</span>

        {/* Breadcrumbed cwd */}
        <span
          style={{
            display: "flex",
            alignItems: "center",
            fontFamily: T.serif,
            fontSize: 13.5,
            overflow: "hidden",
            whiteSpace: "nowrap",
            maxWidth: 460,
          }}
          title={cwd}
        >
          <span style={{ color: T.textFaint, overflow: "hidden", textOverflow: "ellipsis" }}>
            {crumb.parent}
          </span>
          <span style={{ color: T.accent, fontWeight: 600, flexShrink: 0 }}>{crumb.name}</span>
        </span>

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
          terminal
        </span>

        <div style={{ flex: 1 }} />

        {/* Live/connection state */}
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

        {/* Popped-out window only: move this terminal back into the main app
            as a tab (closes this window; the shell keeps running). */}
        {!props.embedded && vid && (
          <button
            onClick={() => invoke("dock_session", { viewerId: vid }).catch(() => {})}
            title="Move this terminal back into the main app as a tab"
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
          />
        ) : (
          <div style={{ padding: 24, color: T.error }}>
            Missing connection parameters (vid, port, or token).
          </div>
        )}
      </div>
    </div>
  );
}
