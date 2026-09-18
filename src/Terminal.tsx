import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm, type ILink } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { invoke } from "@tauri-apps/api/core";
import "@xterm/xterm/css/xterm.css";
import { createWsClient, ConnectionStatus } from "./ws";
import { T } from "./tokens";
import { currentTheme, onThemeChange } from "./themes";

interface TerminalProps {
  vid: string;
  port: string;
  token: string;
  /** Session working directory — relative file paths resolve against it. */
  cwd?: string;
  onControl: (msg: unknown) => void;
  onStatusChange?: (status: ConnectionStatus) => void;
  /** Populated with a function that injects raw input into this session's PTY
   *  (used by header controls like the model switcher). Cleared on unmount. */
  sendRef?: React.MutableRefObject<((data: string) => void) | null>;
  /** Scan the rendered screen for Claude Code's blocking dialogs and report
   *  them upstream (see {@link detectDialog}). OFF by default: a plain shell's
   *  `git rebase -i` todo list is not a blocked agent. */
  detectDialogs?: boolean;
}

// path-ish tokens: optional ~/ ./ ../ prefix, segments, an extension, and an
// optional :line suffix — e.g. src/api/client.ts:42, manga/settings.py, ~/x.md
const PATH_REGEX = /(?:~\/|\.{1,2}\/)?[\w.@-]+(?:\/[\w.@-]+)*\.[A-Za-z][A-Za-z0-9]{0,7}(?::\d+)?/g;
const URL_REGEX = /https?:\/\/[^\s"'<>()\]]+/g;

// Terminal font: prefer the user's Nerd Font (powerline glyphs, p10k/tmux
// icons — IBM Plex Mono has none of them, which renders prompts as □ boxes),
// fall back to the app mono stack when it isn't installed.
const TERM_FONT = `'MesloLGS NF', 'JetBrainsMono Nerd Font', 'Hack Nerd Font', ${T.mono}`;

// ---------------------------------------------------------------------------
// Dialog detection
//
// Hooks are ground truth for TURN BOUNDARIES (UserPromptSubmit → working,
// Stop → idle) but they are blind to dialogs: a session parked on "Do you trust
// this folder?" is genuinely stopped, waiting on a human, and reports `idle`
// because no hook fires for it. xterm already has the screen parsed, so we read
// the grid here and tell the server, which merges it with hook state.
// ---------------------------------------------------------------------------

export type DialogKind = "trust" | "permission" | "plan" | "choice";

export interface DialogState {
  blocked: boolean;
  /** Only meaningful when `blocked`. */
  kind: DialogKind | null;
}

/** Selection carets Claude Code draws beside the highlighted choice. */
const CARET_CLASS = "❯>▶→›»";
/** Leading/trailing box-drawing border (permission prompts are boxed) plus
 *  surrounding padding, stripped so the option regexes can stay anchored. */
const BORDER_RE = /^[\s│┃║|╎┆┊╭╰┌└]+|[\s│┃║|╎┆┊╮╯┐┘]+$/g;
/** Rule 1, the load-bearing signal: a caret-marked numbered option. */
const CARET_OPTION_RE = new RegExp(`^\\s*[${CARET_CLASS}]\\s*\\d+[.)]\\s+\\S`);
/** Rule 2a: any numbered option, caret or not. */
const OPTION_RE = new RegExp(`^\\s*(?:[${CARET_CLASS}]\\s*)?\\d+[.)]\\s+\\S`);
/** Rule 2b: a confirm affordance ("Enter to confirm · Esc to cancel"). */
const CONFIRM_RE = /enter to (?:confirm|select|continue)|esc to (?:cancel|exit)/i;
/** Claude Code prints "esc to interrupt" while it is WORKING. It must never
 *  satisfy the affordance rule, and its presence at/below the options means the
 *  spinner is live — i.e. mid-turn, not waiting on a human. (Claude Code draws
 *  the spinner and a dialog in the same slot, so they never co-render; if that
 *  ever changes, narrow this veto rather than dropping it.) */
const INTERRUPT_RE = /\bto interrupt\b/i;

/** How far up from the bottom of the viewport a dialog's caret may sit.
 *  Dialogs render at the bottom; a numbered list halfway up the screen is prose. */
const TAIL_LINES = 20;
/** Lines pulled in above the caret for option counting and classification —
 *  the question text sits a few lines above the choices. */
const CONTEXT_LINES = 14;

const NOT_BLOCKED: DialogState = { blocked: false, kind: null };

/**
 * Decide whether the visible screen is a blocking Claude Code dialog.
 *
 * Takes the viewport as rendered grid text (top row first). Pure — exported
 * for tests.
 *
 * Predicate: within the bottom {@link TAIL_LINES} rows there is a caret-marked
 * numbered option, nothing at or below it is a live "esc to interrupt" spinner,
 * and the surrounding block has either two numbered options or a confirm
 * affordance. Deliberately biased toward false negatives — an incorrectly
 * "blocked" session poisons the launcher's triage view.
 *
 * Real capture (Claude Code v2.1.220, trust dialog; spacing approximate) —
 * detectDialog(...) → { blocked: true, kind: "trust" }:
 *
 *      Accessing workspace:
 *      /private/tmp/cv-wt-test
 *
 *      Quick safety check: Is this a project you created or one you trust? (Like your own code, a
 *      well-known open source project, or work from your team). If not, take a moment to review
 *      what's in this folder first.
 *
 *      Claude Code'll be able to read, edit, and execute files here.
 *      Security guide
 *
 *      ❯ 1. Yes, I trust this folder
 *        2. No, exit
 *
 *      Enter to confirm · Esc to cancel
 */
export function detectDialog(lines: string[]): DialogState {
  const clean = lines.map((l) => l.replace(BORDER_RE, ""));

  // Rule 1 — a caret-marked numbered option, low on the screen. A Claude
  // response containing a plain numbered list has no caret and stops here.
  const floor = Math.max(0, clean.length - TAIL_LINES);
  let caret = -1;
  for (let i = clean.length - 1; i >= floor; i--) {
    if (CARET_OPTION_RE.test(clean[i])) {
      caret = i;
      break;
    }
  }
  if (caret === -1) return NOT_BLOCKED;

  // Working-spinner veto (see INTERRUPT_RE). The spinner renders BELOW the
  // streamed transcript, so anything caret-ish above a live one is output, not
  // a prompt.
  for (let i = caret; i < clean.length; i++) {
    if (INTERRUPT_RE.test(clean[i])) return NOT_BLOCKED;
  }

  // Rule 2 — corroboration: two numbered options, or a confirm affordance.
  const block = clean.slice(Math.max(0, caret - CONTEXT_LINES));
  let options = 0;
  let affordance = false;
  for (const l of block) {
    if (OPTION_RE.test(l)) options++;
    if (CONFIRM_RE.test(l) && !INTERRUPT_RE.test(l)) affordance = true;
  }
  if (options < 2 && !affordance) return NOT_BLOCKED;

  // Classify from the block's text, first match wins. Two deliberate tweaks:
  // `plan` is word-bounded so "explanation" can't claim it, and "do you want
  // to…" counts as permission — that is the literal wording of Claude Code's
  // tool-permission prompt ("Do you want to proceed?" / "Do you want to make
  // this edit to X?"), the single most common dialog we will ever see. Plan
  // approval says "Would you like to proceed?", so the two do not collide.
  const text = block.join("\n").toLowerCase();
  const kind: DialogKind = /trust this folder|do you trust/.test(text)
    ? "trust"
    : /permission|wants to (?:run|use)|do you want to|\ballow\b[^\n]{0,60}?\bto\b/.test(text)
    ? "permission"
    : /would you like to proceed|proceed with|\bplan\b/.test(text)
    ? "plan"
    : "choice";
  return { blocked: true, kind };
}

export default function Terminal({
  vid,
  port,
  token,
  cwd,
  onControl,
  onStatusChange,
  sendRef,
  detectDialogs = false,
}: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchAddonRef = useRef<SearchAddon | null>(null);

  // Scroll roller: our own always-visible scrollbar for the chat scrollback.
  // macOS overlay scrollbars + the WebGL canvas leave xterm's native viewport
  // bar invisible, so we draw a thumb from buffer state and drive
  // term.scrollToLine() from drags.
  const [sb, setSb] = useState({ thumbTop: 0, thumbH: 0, visible: false });
  const termRef = useRef<XTerm | null>(null);
  const sbDrag = useRef<{ startY: number; startLine: number } | null>(null);
  const sbGeom = useRef({ total: 0, rows: 0, trackH: 0, thumbH: 0 });

  // Latest-callback refs: the xterm effect below runs once per connection, so
  // it must not capture the parent's (re-created every render) handlers.
  const onControlRef = useRef(onControl);
  const onStatusRef = useRef(onStatusChange);
  const detectDialogsRef = useRef(detectDialogs);
  onControlRef.current = onControl;
  onStatusRef.current = onStatusChange;
  // Read through a ref rather than a dependency: toggling it must never tear
  // down and rebuild the WebSocket (that resets the terminal and replays the
  // whole scrollback). In practice it is fixed per mount — the terminal-vs-
  // session routing decides it — but the ref keeps that from being load-bearing.
  detectDialogsRef.current = detectDialogs;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // --- Terminal setup ---
    // Persisted font size (a global default shared by every terminal). Cmd/Ctrl
    // +/-/0 and Ctrl/pinch-to-zoom adjust it live.
    const DEFAULT_FONT_SIZE = 13;
    const MIN_FONT_SIZE = 6;
    const MAX_FONT_SIZE = 40;
    const savedFont = Number(localStorage.getItem("cv.term.fontSize"));
    const initialFont =
      Number.isFinite(savedFont) && savedFont >= MIN_FONT_SIZE && savedFont <= MAX_FONT_SIZE
        ? savedFont
        : DEFAULT_FONT_SIZE;
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
      fontFamily: TERM_FONT,
      fontSize: initialFont,
      // Live palette from the active theme; re-applied on theme switch below.
      theme: currentTheme().terminal,
    });

    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    searchAddonRef.current = searchAddon;

    term.loadAddon(fitAddon);
    term.loadAddon(searchAddon);
    // Unicode 11 width tables: modern glyphs (nerd-font icons, emoji) get
    // their true cell widths — without this, tmux's column math and the
    // renderer disagree and pane borders shred.
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    term.open(container);

    // Follow theme switches without recreating the terminal.
    const unsubscribeTheme = onThemeChange((theme) => {
      term.options.theme = theme.terminal;
    });

    // If the mono webfont (IBM Plex Mono) finishes loading after xterm first
    // measured glyphs, cell widths are stale — poke the renderer to re-measure.
    let disposed = false;
    document.fonts?.ready.then(() => {
      if (disposed) return;
      // Reassigning the font option invalidates xterm's char atlas.
      term.options.fontFamily = TERM_FONT;
      doFit();
    });

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

    // --- Dialog detection ---
    // Edge-triggered: only transitions go on the wire. `null` means "nothing
    // sent on this connection yet", which forces the next scan to send — that
    // is how the re-send on (re)connect happens, since the server does not
    // persist dialog state across a viewer reconnect. Declared up here because
    // the onStatus handler below clears it.
    let sentDialog: DialogState | null = null;

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
        onControlRef.current(msg);
      })
      .onStatus((status) => {
        onStatusRef.current?.(status);
        if (status === "open") {
          if (hasOpened) term.reset();
          hasOpened = true;
          if (doFit()) {
            client.sendControl({ type: "resize", cols: term.cols, rows: term.rows });
          }
          // Fresh connection: the server knows nothing about our dialog state,
          // so drop the edge-trigger baseline. The scan that settles after the
          // scrollback replay then re-sends unconditionally.
          sentDialog = null;
        }
      })
      .connect();

    // Input from terminal → server
    const dataDisposable = term.onData((d) => {
      client.sendBinary(new TextEncoder().encode(d));
    });

    // Expose an imperative input sender for header controls (e.g. model switch).
    if (sendRef) {
      sendRef.current = (d: string) => client.sendBinary(new TextEncoder().encode(d));
    }

    // --- Real-terminal keybindings ---
    // Font zoom persists to a global default, then refits and tells the PTY the
    // new size. Copy/clear/select-all are bound to Cmd (⌘) only — never Ctrl —
    // so Ctrl+A (start of line), Ctrl+C (interrupt), etc. keep working. Paste is
    // xterm's built-in Cmd+V.
    const applyFontSize = (size: number) => {
      const clamped = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, size));
      if (clamped === term.options.fontSize) return;
      term.options.fontSize = clamped;
      localStorage.setItem("cv.term.fontSize", String(clamped));
      if (doFit()) {
        client.sendControl({ type: "resize", cols: term.cols, rows: term.rows });
      }
    };

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const cur = term.options.fontSize ?? DEFAULT_FONT_SIZE;
      // Zoom accepts Cmd or Ctrl (neither combo is meaningful terminal input).
      if (e.metaKey || e.ctrlKey) {
        if (e.key === "=" || e.key === "+") return applyFontSize(cur + 1), false;
        if (e.key === "-") return applyFontSize(cur - 1), false;
        if (e.key === "0") return applyFontSize(DEFAULT_FONT_SIZE), false;
        // Find-in-terminal — handled here (single path) so xterm never also
        // sees the keystroke.
        if (e.key === "f") {
          setSearchOpen((prev) => {
            const next = !prev;
            if (next) setTimeout(() => searchInputRef.current?.focus(), 50);
            return next;
          });
          return false;
        }
      }
      // Editing keys: Cmd only, so Ctrl-versions stay as shell/readline controls.
      if (e.metaKey && !e.ctrlKey) {
        if (e.key === "c" && term.hasSelection()) {
          navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
          return false;
        }
        if (e.key === "k") return term.clear(), false;
        if (e.key === "a") return term.selectAll(), false;
      }
      return true;
    });

    // Cmd/Ctrl+click opens the file path or URL under the cursor (VS Code
    // style). This intercepts in the CAPTURE phase, so it works even while
    // the mirrored TUI (Claude Code enables mouse reporting) is swallowing
    // plain clicks and xterm's own link activation never fires.
    const openAt = (clientX: number, clientY: number): boolean => {
      const screen = container.querySelector(".xterm-screen") as HTMLElement | null;
      if (!screen) return false;
      const rect = screen.getBoundingClientRect();
      if (
        rect.width === 0 ||
        clientX < rect.left ||
        clientX >= rect.right ||
        clientY < rect.top ||
        clientY >= rect.bottom
      ) {
        return false;
      }
      const col = Math.floor(((clientX - rect.left) / rect.width) * term.cols);
      const row = Math.floor(((clientY - rect.top) / rect.height) * term.rows);
      const line = term.buffer.active.getLine(term.buffer.active.viewportY + row);
      if (!line) return false;
      const text = line.translateToString(false);
      for (const m of text.matchAll(URL_REGEX)) {
        const url = m[0].replace(/[.,;:]+$/, "");
        if (col >= m.index && col < m.index + url.length) {
          invoke("open_url", { url }).catch(() => {});
          return true;
        }
      }
      for (const m of text.matchAll(PATH_REGEX)) {
        if (text.slice(Math.max(0, m.index - 8), m.index).includes("://")) continue;
        if (col >= m.index && col < m.index + m[0].length) {
          invoke("open_path", { path: m[0], cwd: cwd ?? null }).catch(() => {});
          return true;
        }
      }
      return false;
    };
    const onModClick = (e: MouseEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (openAt(e.clientX, e.clientY)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    // macOS reports Ctrl+click as a context-menu gesture — catch that too so
    // BOTH Cmd+click and Ctrl+click open the target.
    const onCtxMenu = (e: MouseEvent) => {
      if (!e.ctrlKey) return;
      if (openAt(e.clientX, e.clientY)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    container.addEventListener("click", onModClick, true);
    container.addEventListener("contextmenu", onCtxMenu, true);

    // Ctrl+wheel (and trackpad pinch, which the OS reports as ctrl+wheel) zooms.
    const wheelEl = container;
    const onWheelZoom = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      applyFontSize((term.options.fontSize ?? DEFAULT_FONT_SIZE) + (e.deltaY < 0 ? 1 : -1));
    };
    wheelEl.addEventListener("wheel", onWheelZoom, { passive: false });

    // ResizeObserver → fit + PTY resize. During a live drag this fires at
    // display rate, so: refit at most once per animation frame (keeps the
    // glyphs tracking the pane smoothly), and debounce the PTY resize message
    // (SIGWINCH storms make full-screen apps like Claude Code redraw over and
    // over — the visible "jitter" during resizes).
    let fitRaf = 0;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleFit = () => {
      if (fitRaf) return;
      fitRaf = requestAnimationFrame(() => {
        fitRaf = 0;
        const cols = term.cols;
        const rows = term.rows;
        if (doFit() && (term.cols !== cols || term.rows !== rows)) {
          if (resizeTimer) clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => {
            resizeTimer = null;
            client.sendControl({ type: "resize", cols: term.cols, rows: term.rows });
          }, 140);
        }
      });
    };
    const ro = new ResizeObserver(scheduleFit);
    ro.observe(container);

    // --- Scroll roller state feed ---
    // rAF-throttled: onRender fires per output frame; the setState bails when
    // the thumb hasn't visibly moved.
    const SB_PAD = 8; // must match the overlay track's top/bottom inset
    let sbRaf = 0;
    const updateScrollbar = () => {
      if (sbRaf) return;
      sbRaf = requestAnimationFrame(() => {
        sbRaf = 0;
        const el = containerRef.current;
        if (!el) return;
        const buf = term.buffer.active;
        const total = buf.length;
        const rows = term.rows;
        const trackH = el.clientHeight - SB_PAD * 2;
        if (total <= rows || trackH <= 40) {
          sbGeom.current = { total, rows, trackH, thumbH: 0 };
          setSb((p) => (p.visible ? { thumbTop: 0, thumbH: 0, visible: false } : p));
          return;
        }
        const thumbH = Math.max(28, (rows / total) * trackH);
        const maxTop = trackH - thumbH;
        const thumbTop = (buf.viewportY / (total - rows)) * maxTop;
        sbGeom.current = { total, rows, trackH, thumbH };
        setSb((p) =>
          p.visible && Math.abs(p.thumbTop - thumbTop) < 0.5 && Math.abs(p.thumbH - thumbH) < 0.5
            ? p
            : { thumbTop, thumbH, visible: true }
        );
      });
    };
    const sbScrollDisp = term.onScroll(updateScrollbar);
    const sbRenderDisp = term.onRender(updateScrollbar);
    const sbResizeDisp = term.onResize(updateScrollbar);
    const sbBufferDisp = term.buffer.onBufferChange(updateScrollbar);
    updateScrollbar();

    // --- Dialog scan feed ---
    // Same rAF throttle as the scroll roller, plus a settle delay: onRender
    // fires per output frame, and a dialog is static, so there is no reason to
    // scan mid-stream. Nothing here touches React state — the server owns the
    // merged agent state and broadcasts it back to every viewer.
    const DIALOG_SETTLE_MS = 200;
    let dlgRaf = 0;
    let dlgTimer: ReturnType<typeof setTimeout> | null = null;

    const scanDialog = () => {
      const buf = term.buffer.active;
      // Only the live bottom of the buffer counts. Scrolled back into history,
      // the viewport can be showing a prompt that was answered ten minutes ago.
      if (buf.viewportY < buf.baseY) return;
      const lines: string[] = [];
      for (let i = 0; i < term.rows; i++) {
        // Rendered grid text, not raw bytes: the TUI positions text with cursor
        // moves, so the spaces only exist in the buffer.
        lines.push(buf.getLine(buf.viewportY + i)?.translateToString(true) ?? "");
      }
      const next = detectDialog(lines);
      if (sentDialog && next.blocked === sentDialog.blocked && next.kind === sentDialog.kind) return;
      sentDialog = next;
      client.sendControl({
        type: "dialog",
        blocked: next.blocked,
        kind: next.blocked ? next.kind : null,
      });
    };

    const scheduleDialogScan = () => {
      if (!detectDialogsRef.current) return;
      if (dlgTimer) clearTimeout(dlgTimer);
      dlgTimer = setTimeout(() => {
        dlgTimer = null;
        if (dlgRaf) return;
        dlgRaf = requestAnimationFrame(() => {
          dlgRaf = 0;
          scanDialog();
        });
      }, DIALOG_SETTLE_MS);
    };
    const dlgRenderDisp = term.onRender(scheduleDialogScan);
    const dlgScrollDisp = term.onScroll(scheduleDialogScan);
    scheduleDialogScan();

    termRef.current = term;

    return () => {
      disposed = true;
      termRef.current = null;
      if (sbRaf) cancelAnimationFrame(sbRaf);
      sbScrollDisp.dispose();
      sbRenderDisp.dispose();
      sbResizeDisp.dispose();
      sbBufferDisp.dispose();
      if (dlgRaf) cancelAnimationFrame(dlgRaf);
      if (dlgTimer) clearTimeout(dlgTimer);
      dlgRenderDisp.dispose();
      dlgScrollDisp.dispose();
      // Cut off imperative senders FIRST so nothing writes to a dying client.
      if (sendRef) sendRef.current = null;
      if (fitRaf) cancelAnimationFrame(fitRaf);
      if (resizeTimer) clearTimeout(resizeTimer);
      unsubscribeTheme();
      dataDisposable.dispose();
      linkProvider.dispose();
      ro.disconnect();
      container.removeEventListener("click", onModClick, true);
      container.removeEventListener("contextmenu", onCtxMenu, true);
      wheelEl.removeEventListener("wheel", onWheelZoom);
      client.destroy();
      // webglAddon is null if context loss already disposed it.
      webglAddon?.dispose();
      searchAddon.dispose();
      term.dispose();
      searchAddonRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vid, port, token, cwd]);

  // --- Scroll roller interactions ---
  function sbThumbDown(e: React.PointerEvent<HTMLDivElement>) {
    const term = termRef.current;
    if (!term) return;
    e.preventDefault();
    e.stopPropagation();
    sbDrag.current = { startY: e.clientY, startLine: term.buffer.active.viewportY };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function sbThumbMove(e: React.PointerEvent<HTMLDivElement>) {
    const term = termRef.current;
    const drag = sbDrag.current;
    if (!term || !drag) return;
    const { total, rows, trackH, thumbH } = sbGeom.current;
    const maxTop = trackH - thumbH;
    if (maxTop <= 0) return;
    const lines = ((e.clientY - drag.startY) / maxTop) * (total - rows);
    const target = Math.max(0, Math.min(total - rows, Math.round(drag.startLine + lines)));
    term.scrollToLine(target);
  }

  function sbThumbUp() {
    sbDrag.current = null;
  }

  /** Click on the empty track: jump so the thumb centers on the click. */
  function sbTrackDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return;
    const term = termRef.current;
    if (!term) return;
    const { total, rows, trackH, thumbH } = sbGeom.current;
    const maxTop = Math.max(1, trackH - thumbH);
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientY - rect.top - thumbH / 2) / maxTop));
    term.scrollToLine(Math.round(frac * (total - rows)));
  }

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
      {/* Scroll roller — draggable thumb over the chat scrollback. */}
      {sb.visible && (
        <div
          onPointerDown={sbTrackDown}
          style={{
            position: "absolute",
            top: 8,
            bottom: 8,
            right: 3,
            width: 11,
            zIndex: 90,
            borderRadius: 6,
            background: "color-mix(in srgb, var(--cv-text) 7%, transparent)",
          }}
        >
          <div
            onPointerDown={sbThumbDown}
            onPointerMove={sbThumbMove}
            onPointerUp={sbThumbUp}
            onPointerCancel={sbThumbUp}
            title="Drag to scroll the session"
            style={{
              position: "absolute",
              left: 1.5,
              right: 1.5,
              top: sb.thumbTop,
              height: sb.thumbH,
              borderRadius: 5,
              background: "color-mix(in srgb, var(--cv-text) 32%, transparent)",
              touchAction: "none",
            }}
          />
        </div>
      )}
      {searchOpen && (
        <div
          className="cv-field"
          style={{
            position: "absolute",
            top: 8,
            right: 12,
            zIndex: 100,
            display: "flex",
            gap: 6,
            alignItems: "center",
            background: T.surface1,
            border: `1px solid ${T.borderStrong}`,
            borderRadius: 6,
            padding: "4px 8px",
            boxShadow: T.windowShadow,
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
              color: T.text,
              fontFamily: T.mono,
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
  border: `1px solid ${T.borderStrong}`,
  borderRadius: 4,
  color: T.textDim,
  cursor: "pointer",
  fontSize: 13,
  padding: "1px 6px",
  lineHeight: 1.4,
};
