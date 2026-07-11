// Shared design tokens for claude-view.
//
// One warm-neutral dark system used across the launcher, session window, and
// timeline. These are plain JS constants (not a CSS framework) so they drop
// straight into the existing inline-style approach. The same values are also
// mirrored as CSS custom properties on :root in styles.css for the few global
// rules (scrollbar, body) that live in CSS.

export const T = {
  // Surfaces (warm-neutral dark)
  bg: "#0d0e11", // app background / canvas
  surface: "#15171b", // window body
  surface1: "#1c1f24", // cards, inputs
  surface2: "#23272e", // hover / nested
  titlebar: "#101216", // chrome, rails

  // Lines
  border: "#2b2f37", // default hairline
  borderStrong: "#3a3f49", // control borders
  borderAccent: "#2f4a6b", // selected card
  divider: "#22262c", // 1px section rule

  // Text
  text: "#e7e9ec", // primary
  textDim: "#98a0ab", // secondary
  textFaint: "#626a75", // metadata / hints

  // Accent
  accent: "#5b9dff", // primary actions, focus
  accentInk: "#0a1220", // text on the accent button
  accentSoft: "rgba(91,157,255,0.14)",
  accentBorder: "#2f4a6b",
  path: "#7cc5ff", // monospace paths / dirs

  // Status
  success: "#3fb950", // live / ok
  running: "#e3b341",
  error: "#f0616d",
  idle: "#6b7280", // ended / idle
  modelViolet: "#c4a2ff", // opus

  // Type
  ui: "system-ui, -apple-system, 'Segoe UI', sans-serif",
  mono: "'JetBrains Mono', ui-monospace, Menlo, Monaco, monospace",

  // Elevation
  windowShadow: "0 30px 70px rgba(0,0,0,0.55)",
} as const;

/** Soft tint background for a status color, per the reusable status pattern. */
export function tint(hex: string, alpha = 0.12): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
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
