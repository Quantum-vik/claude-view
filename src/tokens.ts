// Shared design tokens for claude-view.
//
// Every value here is a CSS custom property reference — the actual colors are
// written onto :root by src/themes.ts (initTheme / setTheme). Components keep
// the same inline-style approach (`background: T.surface`), but because the
// values are var() references the whole app restyles instantly when the theme
// switches, with zero React re-renders. Anything that can't read CSS vars
// (xterm) subscribes via onThemeChange() in themes.ts instead.

export const T = {
  // Surfaces
  bg: "var(--cv-bg)", // app background / terminal pane
  surface: "var(--cv-surface)", // window body
  surface1: "var(--cv-surface1)", // cards, inputs, popovers
  surface2: "var(--cv-surface2)", // chips, nested, hover
  titlebar: "var(--cv-titlebar)", // header bars
  sidebar: "var(--cv-sidebar)", // command-log pane (one shade below bg)

  // Lines
  border: "var(--cv-border)", // default hairline
  borderStrong: "var(--cv-border-strong)", // control borders
  borderAccent: "var(--cv-accent-border)", // selected card
  accentBorder: "var(--cv-accent-border)", // (alias — handoff name)
  divider: "var(--cv-divider)", // 1px section rule

  // Text
  text: "var(--cv-text)", // primary
  textDim: "var(--cv-text-dim)", // secondary
  textFaint: "var(--cv-text-faint)", // metadata / hints
  timestamp: "var(--cv-timestamp)", // log timestamps / durations
  cmd: "var(--cv-cmd)", // command text in the log
  cmdFold: "var(--cv-cmd-fold)", // folded-child command text

  // Accent
  accent: "var(--cv-accent)", // primary actions, focus
  accentInk: "var(--cv-accent-ink)", // text on the accent button
  accentSoft: "var(--cv-accent-soft)", // 10% accent tint
  accentSoft2: "var(--cv-accent-soft2)", // 15% accent tint (selected chips)
  accentHover: "var(--cv-accent-hover)", // 5% accent tint (row hover)
  searchGlyph: "var(--cv-search-glyph)", // ⌕ glyph
  path: "var(--cv-tool-bash)", // monospace paths / prompt glyphs

  // Status
  success: "var(--cv-success)",
  successSoft: "var(--cv-success-soft)", // live pill bg
  successBorder: "var(--cv-success-border)", // live pill border
  running: "var(--cv-running)",
  error: "var(--cv-error)",
  errorTint: "var(--cv-error-tint)", // error row / output bg
  errorText: "var(--cv-error-text)", // expanded error output text
  errorPreview: "var(--cv-error-preview)", // collapsed error preview
  errorBorder: "var(--cv-error-border)", // expanded error output border
  idle: "var(--cv-idle)", // ended / idle
  modelViolet: "var(--cv-model-violet)", // opus

  // Type — Lora for headings/labels/buttons, IBM Plex Mono for log/terminal.
  //
  // The rule that generalises it, now that the panel carries prose as well as
  // chrome: SERIF IS FOR HUMAN LANGUAGE, MONO IS FOR MACHINE LANGUAGE. User
  // prompts and assistant messages (and Claude's own thinking) are serif; tool
  // names, commands, output, timestamps, durations and token counts are mono.
  // A tool's error message is mono; a sentence Claude wrote about it is serif.
  ui: "system-ui, -apple-system, 'Segoe UI', sans-serif",
  serif: "'Lora', Georgia, serif",
  mono: "'IBM Plex Mono', ui-monospace, Menlo, Monaco, monospace",

  // Elevation
  windowShadow: "var(--cv-shadow)",
} as const;

/** Soft tint of any token color (works on var() references via color-mix). */
export function tint(color: string, alpha = 0.12): string {
  return `color-mix(in srgb, ${color} ${Math.round(alpha * 100)}%, transparent)`;
}

export type StatusKind = "running" | "success" | "error" | "interrupted";

/** Color for a timeline/session status. */
export function statusColor(status: StatusKind): string {
  switch (status) {
    case "running":
      return T.running;
    case "success":
      return T.success;
    case "error":
      return T.error;
    case "interrupted":
      return T.running;
  }
}

/** A tool's "family": a stable accent color + terminal prompt glyph, so each
 *  tool reads with its own identity in the command log (like a shell prompt). */
export interface ToolFamily {
  color: string;
  glyph: string;
}

export function toolFamily(tool: string): ToolFamily {
  const t = (tool || "").toLowerCase();
  if (t === "bash" || t === "shell") return { color: "var(--cv-tool-bash)", glyph: "$" };
  if (t === "edit" || t === "write" || t === "multiedit")
    return { color: "var(--cv-tool-edit)", glyph: "✎" };
  if (t === "read") return { color: "var(--cv-tool-read)", glyph: "▤" };
  if (t === "grep" || t === "glob") return { color: "var(--cv-tool-grep)", glyph: "⌕" };
  if (t === "webfetch" || t === "websearch") return { color: "var(--cv-tool-web)", glyph: "⇅" };
  if (t === "task") return { color: "var(--cv-tool-task)", glyph: "»" };
  return { color: "var(--cv-text-dim)", glyph: "›" };
}
