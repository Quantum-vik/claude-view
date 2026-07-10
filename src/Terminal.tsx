import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm, type ILink } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import { invoke } from "@tauri-apps/api/core";
import "@xterm/xterm/css/xterm.css";
import { createWsClient, ConnectionStatus } from "./ws";

interface TerminalProps {
  vid: string;
  port: string;
  token: string;
  /** Session working directory — relative file paths resolve against it. */
  cwd?: string;
  onControl: (msg: unknown) => void;
  onStatusChange?: (status: ConnectionStatus) => void;
}

// path-ish tokens: optional ~/ ./ ../ prefix, segments, an extension, and an
// optional :line suffix — e.g. src/api/client.ts:42, manga/settings.py, ~/x.md
const PATH_REGEX = /(?:~\/|\.{1,2}\/)?[\w.@-]+(?:\/[\w.@-]+)*\.[A-Za-z][A-Za-z0-9]{0,7}(?::\d+)?/g;
const URL_REGEX = /https?:\/\/[^\s"'<>()\]]+/g;

export default function Terminal({ vid, port, token, cwd, onControl, onStatusChange }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchAddonRef = useRef<SearchAddon | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    // --- Terminal setup ---
    const term = new XTerm({
      scrollback: 20000,
      allowProposedApi: true,
      // Real hyperlinks in the stream (OSC 8), e.g. file:// links Claude
      // Code emits in supporting versions.
      linkHandler: {
        allowNonHttpProtocols: true,
        activate: (_e, uri) => {
          if (uri.startsWith("file://")) {
            try {
              const u = new URL(uri);
              invoke("open_path", { path: decodeURIComponent(u.pathname), cwd: cwd ?? null }).catch(() => {});
            } catch {
              // malformed link — ignore
            }
          } else if (uri.startsWith("http://") || uri.startsWith("https://")) {
            invoke("open_url", { url: uri }).catch(() => {});
          }
        },
      },
      fontFamily: "Menlo, Monaco, 'Courier New', monospace",
      fontSize: 13,
      theme: {
        background: "#1e1e1e",
        foreground: "#d4d4d4",
        cursor: "#d4d4d4",
        selectionBackground: "#264f78",
        black: "#1e1e1e",
        red: "#f44747",
        green: "#6a9955",
        yellow: "#d7ba7d",
        blue: "#569cd6",
        magenta: "#c586c0",
        cyan: "#4ec9b0",
        white: "#d4d4d4",
        brightBlack: "#808080",
        brightRed: "#f44747",
        brightGreen: "#6a9955",
        brightYellow: "#d7ba7d",
        brightBlue: "#569cd6",
        brightMagenta: "#c586c0",
        brightCyan: "#4ec9b0",
        brightWhite: "#ffffff",
      },
    });

    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    searchAddonRef.current = searchAddon;

    term.loadAddon(fitAddon);
    term.loadAddon(searchAddon);
    term.open(containerRef.current);

    // WebGL with fallback
    let webglAddon: WebglAddon | null = null;
    try {
      webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        webglAddon?.dispose();
        webglAddon = null;
      });
      term.loadAddon(webglAddon);
    } catch {
      // fall back silently to canvas renderer
    }

    // Fit only when the container has real size. A tab mounted while hidden
    // (display:none) has 0×0, and fit() there computes 0 cols/rows which — sent
    // as a resize — would corrupt the PTY size shared by all viewers.
    const doFit = (): boolean => {
      const el = containerRef.current;
      if (!el || el.clientWidth === 0 || el.clientHeight === 0) return false;
      fitAddon.fit();
      return true;
    };
    doFit();

    // Plain-text file paths and URLs become clickable (Claude Code styles
    // paths with underlines but doesn't always emit real link escapes).
    const linkProvider = term.registerLinkProvider({
      provideLinks(lineNo, callback) {
        const line = term.buffer.active.getLine(lineNo - 1);
        if (!line) return callback(undefined);
        // No trim: keeps string offsets aligned with terminal columns.
        const text = line.translateToString(false);
        const links: ILink[] = [];
        const push = (index: number, match: string, activate: () => void) => {
          links.push({
            range: {
              start: { x: index + 1, y: lineNo },
              end: { x: index + match.length, y: lineNo },
            },
            text: match,
            activate,
          });
        };
        for (const m of text.matchAll(URL_REGEX)) {
          const url = m[0].replace(/[.,;:]+$/, "");
          push(m.index, url, () => invoke("open_url", { url }).catch(() => {}));
        }
        for (const m of text.matchAll(PATH_REGEX)) {
          const p = m[0];
          // skip anything inside a URL match
          if (text.slice(Math.max(0, m.index - 8), m.index).includes("://")) continue;
          push(m.index, p, () => invoke("open_path", { path: p, cwd: cwd ?? null }).catch(() => {}));
        }
        callback(links.length ? links : undefined);
      },
    });

    // --- WebSocket ---
    // The server replays the full scrollback on every (re)connect. On a
    // reconnect the terminal already has content, so reset first to avoid
    // rendering the history twice. `resync` (server sent after a lag drop) is
    // the same situation mid-connection.
    let hasOpened = false;
    const url = `ws://127.0.0.1:${port}/ws/${vid}?token=${token}`;
    const client = createWsClient(url)
      .onBinary((data) => {
        term.write(new Uint8Array(data));
      })
      .onControl((msg) => {
        if ((msg as { type?: string })?.type === "resync") {
          term.reset();
          return;
        }
        onControl(msg);
      })
      .onStatus((status) => {
        onStatusChange?.(status);
        if (status === "open") {
          if (hasOpened) term.reset();
          hasOpened = true;
          if (doFit()) {
            client.sendControl({ type: "resize", cols: term.cols, rows: term.rows });
          }
        }
      })
      .connect();

    // Input from terminal → server
    const dataDisposable = term.onData((d) => {
      client.sendBinary(new TextEncoder().encode(d));
    });

    // ResizeObserver → fit and send resize (only when visible/non-zero, so a
    // hidden tab never pushes a 0×0 resize to the shared PTY).
    const ro = new ResizeObserver(() => {
      if (doFit()) {
        client.sendControl({ type: "resize", cols: term.cols, rows: term.rows });
      }
    });
    ro.observe(containerRef.current);

    // Keyboard shortcut: Cmd/Ctrl+F → toggle search
    const keyDisposable = term.onKey(({ domEvent }) => {
      if (domEvent.key === "f" && (domEvent.metaKey || domEvent.ctrlKey)) {
        domEvent.preventDefault();
        setSearchOpen((prev) => {
          const next = !prev;
          if (next) {
            setTimeout(() => searchInputRef.current?.focus(), 50);
          }
          return next;
        });
      }
    });

    return () => {
      dataDisposable.dispose();
      keyDisposable.dispose();
      linkProvider.dispose();
      ro.disconnect();
      client.destroy();
      // webglAddon is null if context loss already disposed it.
      webglAddon?.dispose();
      searchAddon.dispose();
      term.dispose();
      searchAddonRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vid, port, token, cwd]);

  function handleSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      if (e.shiftKey) {
        searchAddonRef.current?.findPrevious(searchQuery);
      } else {
        searchAddonRef.current?.findNext(searchQuery);
      }
    } else if (e.key === "Escape") {
      setSearchOpen(false);
      setSearchQuery("");
    }
  }

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div
        ref={containerRef}
        style={{ width: "100%", height: "100%", overflow: "hidden" }}
      />
      {searchOpen && (
        <div
          style={{
            position: "absolute",
            top: 8,
            right: 12,
            zIndex: 100,
            display: "flex",
            gap: 6,
            alignItems: "center",
            background: "#2d2d2d",
            border: "1px solid #444",
            borderRadius: 6,
            padding: "4px 8px",
            boxShadow: "0 2px 8px rgba(0,0,0,0.5)",
          }}
        >
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="Find in terminal…"
            style={{
              background: "transparent",
              border: "none",
              outline: "none",
              color: "#d4d4d4",
              fontFamily: "Menlo, Monaco, 'Courier New', monospace",
              fontSize: 13,
              width: 200,
            }}
          />
          <button
            onClick={() => searchAddonRef.current?.findPrevious(searchQuery)}
            title="Previous (Shift+Enter)"
            style={searchBtnStyle}
          >
            ↑
          </button>
          <button
            onClick={() => searchAddonRef.current?.findNext(searchQuery)}
            title="Next (Enter)"
            style={searchBtnStyle}
          >
            ↓
          </button>
          <button
            onClick={() => { setSearchOpen(false); setSearchQuery(""); }}
            title="Close (Esc)"
            style={{ ...searchBtnStyle, marginLeft: 2 }}
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}

const searchBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: "1px solid #555",
  borderRadius: 4,
  color: "#d4d4d4",
  cursor: "pointer",
  fontSize: 13,
  padding: "1px 6px",
  lineHeight: 1.4,
};
