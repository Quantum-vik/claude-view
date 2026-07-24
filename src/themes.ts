/**
 * themes.ts
 * ---------
 * Runtime theme system. A Theme is a flat set of raw colors (plus an xterm
 * palette). Themes are applied by writing CSS custom properties onto
 * document.documentElement — every component styles itself with var(--cv-*)
 * via src/tokens.ts, so switching themes restyles the whole app instantly
 * with zero re-renders. xterm can't read CSS vars, so Terminal.tsx subscribes
 * via onThemeChange() and re-applies `term.options.theme` live.
 *
 * Built-ins: "Ink & Parchment" (default, per the design handoff), its light
 * companion "Parchment Light", and "Slate" (the original blue dark theme).
 * Users can import any VS Code color theme JSON (Import… in the theme menu);
 * imported themes persist in localStorage and sync across app windows via
 * the `storage` event.
 */

export interface ThemeColors {
  // Surfaces
  bg: string; // app background / terminal pane
  surface: string; // window body
  surface1: string; // cards, inputs, popovers
  surface2: string; // chips, nested, hover
  titlebar: string; // header bars
  sidebar: string; // command-log pane (one shade below bg)
  // Lines
  border: string;
  borderStrong: string;
  divider: string;
  accentBorder: string;
  // Text
  text: string;
  textDim: string;
  textFaint: string;
  timestamp: string; // log timestamps
  cmd: string; // command text in the log + terminal foreground
  cmdFold: string; // folded-child command text
  // Accent
  accent: string;
  accentInk: string; // text on the accent button
  searchGlyph: string; // ⌕ glyph tint
  // Status
  success: string;
  running: string;
  error: string;
  idle: string;
  modelViolet: string; // Opus-tier dot / model chip
  errorText: string; // expanded error output text
  errorPreview: string; // collapsed error preview line
  errorBorder: string; // expanded error output border
  // Tool families
  toolBash: string;
  toolEdit: string;
  toolRead: string;
  toolGrep: string;
  toolWeb: string;
  toolTask: string;
}

export interface XtermPalette {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent?: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface Theme {
  id: string;
  name: string;
  kind: "dark" | "light";
  builtin?: boolean;
  colors: ThemeColors;
  terminal: XtermPalette;
}

/* ------------------------------------------------------------------ */
/* Built-in themes                                                     */
/* ------------------------------------------------------------------ */

export const INK_PARCHMENT: Theme = {
  id: "ink-parchment",
  name: "Ink & Parchment",
  kind: "dark",
  builtin: true,
  colors: {
    bg: "#14110d",
    surface: "#14110d",
    surface1: "#1a1712",
    surface2: "#211c15",
    titlebar: "#181510",
    sidebar: "#12100c",
    border: "#2e2820",
    borderStrong: "#3a332a",
    divider: "#241f18",
    accentBorder: "#4a3d28",
    text: "#e8e2d5",
    textDim: "#a89f8d",
    textFaint: "#6f675a",
    timestamp: "#5c554a",
    cmd: "#cfc8b8",
    cmdFold: "#bdb5a5",
    accent: "#d4a55e",
    accentInk: "#14110d",
    searchGlyph: "#a08a5f",
    success: "#8aab7a",
    running: "#d4b36a",
    error: "#c97b6f",
    idle: "#5c554a",
    modelViolet: "#c9a2c0",
    errorText: "#d3aca6",
    errorPreview: "#c99a92",
    errorBorder: "#4a2f2a",
    toolBash: "#b8905a",
    toolEdit: "#c9a2c0",
    toolRead: "#7a9a8a",
    toolGrep: "#8fb0a0",
    toolWeb: "#b0a37e",
    toolTask: "#b9a2c9",
  },
  terminal: {
    background: "#14110d",
    foreground: "#cfc8b8",
    cursor: "#d4a55e",
    cursorAccent: "#14110d",
    selectionBackground: "#4a3d28",
    black: "#211c15",
    red: "#c97b6f",
    green: "#8aab7a",
    yellow: "#d4b36a",
    blue: "#8fa8c9",
    magenta: "#c9a2c0",
    cyan: "#8fb0a0",
    white: "#cfc8b8",
    brightBlack: "#6f675a",
    brightRed: "#db9186",
    brightGreen: "#a3c193",
    brightYellow: "#e8ca85",
    brightBlue: "#a9c0dd",
    brightMagenta: "#dcb9d4",
    brightCyan: "#a8c7b8",
    brightWhite: "#e8e2d5",
  },
};

export const PARCHMENT_LIGHT: Theme = {
  id: "parchment-light",
  name: "Parchment Light",
  kind: "light",
  builtin: true,
  colors: {
    bg: "#f4efe4",
    surface: "#f4efe4",
    surface1: "#fbf8f0",
    surface2: "#ece5d4",
    titlebar: "#efe9db",
    sidebar: "#f0eadd",
    border: "#ddd3bf",
    borderStrong: "#c9bda5",
    divider: "#e6ddc9",
    accentBorder: "#c3a874",
    text: "#3a3226",
    textDim: "#7a7060",
    textFaint: "#a39784",
    timestamp: "#a39784",
    cmd: "#4a4234",
    cmdFold: "#5f5646",
    accent: "#a87f3e",
    accentInk: "#fbf8f0",
    searchGlyph: "#a87f3e",
    success: "#5f7d4f",
    running: "#a8842f",
    error: "#a85448",
    idle: "#a39784",
    modelViolet: "#8f6a86",
    errorText: "#8f4a40",
    errorPreview: "#a06457",
    errorBorder: "#d8b3ab",
    toolBash: "#96703c",
    toolEdit: "#8f6a86",
    toolRead: "#587a67",
    toolGrep: "#4e7a6c",
    toolWeb: "#847749",
    toolTask: "#7d6592",
  },
  terminal: {
    background: "#f4efe4",
    foreground: "#4a4234",
    cursor: "#a87f3e",
    cursorAccent: "#f4efe4",
    selectionBackground: "#e0d2b2",
    black: "#3a3226",
    red: "#a85448",
    green: "#5f7d4f",
    yellow: "#a8842f",
    blue: "#4e6a8f",
    magenta: "#8f6a86",
    cyan: "#4e7a6c",
    white: "#e6ddc9",
    brightBlack: "#7a7060",
    brightRed: "#c26a5c",
    brightGreen: "#748f62",
    brightYellow: "#c09a42",
    brightBlue: "#6583a8",
    brightMagenta: "#a4809b",
    brightCyan: "#639182",
    brightWhite: "#fbf8f0",
  },
};

export const SLATE: Theme = {
  id: "slate",
  name: "Slate",
  kind: "dark",
  builtin: true,
  colors: {
    bg: "#0d0e11",
    surface: "#15171b",
    surface1: "#1c1f24",
    surface2: "#23272e",
    titlebar: "#101216",
    sidebar: "#0d0e11",
    border: "#2b2f37",
    borderStrong: "#3a3f49",
    divider: "#22262c",
    accentBorder: "#2f4a6b",
    text: "#e7e9ec",
    textDim: "#98a0ab",
    textFaint: "#626a75",
    timestamp: "#4c5561",
    cmd: "#d4d4d4",
    cmdFold: "#a9b1bd",
    accent: "#5b9dff",
    accentInk: "#0a1220",
    searchGlyph: "#56d4dd",
    success: "#3fb950",
    running: "#e3b341",
    error: "#f0616d",
    idle: "#6b7280",
    modelViolet: "#c4a2ff",
    errorText: "#e0b4b8",
    errorPreview: "#e0a0a5",
    errorBorder: "#4a2830",
    toolBash: "#7cc5ff",
    toolEdit: "#d2a8ff",
    toolRead: "#4ec9b0",
    toolGrep: "#56d4dd",
    toolWeb: "#f0883e",
    toolTask: "#c4a2ff",
  },
  terminal: {
    background: "#141519",
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
};

/** Build a bundled preset from a canonical VS Code-style palette. Reuses the
 *  import mapper so presets and user-imported themes color identically. */
function preset(
  id: string,
  name: string,
  type: "dark" | "light",
  colors: Record<string, string>
): Theme {
  return { ...themeFromVsCode({ name, type, colors }, name), id, builtin: true };
}

/* Bundled classics — the most-installed VS Code themes (GitHub ~15M installs,
 * One Dark Pro ~10M, Dracula ~5M, plus the perennial terminal palettes:
 * Tokyo Night, Catppuccin, Nord, Monokai, Gruvbox, Solarized, Night Owl, Ayu,
 * Palenight, Cobalt2, Rosé Pine). All offline, from each theme's published
 * canonical palette. */
export const PRESET_THEMES: readonly Theme[] = [
  preset("dracula", "Dracula", "dark", {
    "editor.background": "#282a36",
    "editor.foreground": "#f8f8f2",
    "sideBar.background": "#21222c",
    "titleBar.activeBackground": "#191a21",
    "input.background": "#343746",
    "panel.border": "#191a21",
    "button.background": "#bd93f9",
    "descriptionForeground": "#6272a4",
    "errorForeground": "#ff5555",
    "terminal.ansiBlack": "#21222c",
    "terminal.ansiRed": "#ff5555",
    "terminal.ansiGreen": "#50fa7b",
    "terminal.ansiYellow": "#f1fa8c",
    "terminal.ansiBlue": "#bd93f9",
    "terminal.ansiMagenta": "#ff79c6",
    "terminal.ansiCyan": "#8be9fd",
    "terminal.ansiWhite": "#f8f8f2",
    "terminal.ansiBrightBlack": "#6272a4",
    "terminal.ansiBrightRed": "#ff6e6e",
    "terminal.ansiBrightGreen": "#69ff94",
    "terminal.ansiBrightYellow": "#ffffa5",
    "terminal.ansiBrightBlue": "#d6acff",
    "terminal.ansiBrightMagenta": "#ff92df",
    "terminal.ansiBrightCyan": "#a4ffff",
    "terminal.ansiBrightWhite": "#ffffff",
  }),
  preset("one-dark-pro", "One Dark Pro", "dark", {
    "editor.background": "#282c34",
    "editor.foreground": "#abb2bf",
    "sideBar.background": "#21252b",
    "input.background": "#1d1f23",
    "panel.border": "#3e4452",
    "button.background": "#61afef",
    "descriptionForeground": "#9da5b3",
    "errorForeground": "#e06c75",
    "terminal.ansiBlack": "#3f4451",
    "terminal.ansiRed": "#e06c75",
    "terminal.ansiGreen": "#98c379",
    "terminal.ansiYellow": "#e5c07b",
    "terminal.ansiBlue": "#61afef",
    "terminal.ansiMagenta": "#c678dd",
    "terminal.ansiCyan": "#56b6c2",
    "terminal.ansiWhite": "#d7dae0",
    "terminal.ansiBrightBlack": "#4f5666",
    "terminal.ansiBrightRed": "#ff616e",
    "terminal.ansiBrightGreen": "#a5e075",
    "terminal.ansiBrightYellow": "#f0a45d",
    "terminal.ansiBrightBlue": "#4dc4ff",
    "terminal.ansiBrightMagenta": "#de73ff",
    "terminal.ansiBrightCyan": "#4cd1e0",
    "terminal.ansiBrightWhite": "#e6e6e6",
  }),
  preset("github-dark", "GitHub Dark", "dark", {
    "editor.background": "#0d1117",
    "editor.foreground": "#e6edf3",
    "sideBar.background": "#010409",
    "input.background": "#161b22",
    "panel.border": "#30363d",
    "button.background": "#58a6ff",
    "descriptionForeground": "#8b949e",
    "errorForeground": "#ff7b72",
    "terminal.ansiBlack": "#484f58",
    "terminal.ansiRed": "#ff7b72",
    "terminal.ansiGreen": "#3fb950",
    "terminal.ansiYellow": "#d29922",
    "terminal.ansiBlue": "#58a6ff",
    "terminal.ansiMagenta": "#bc8cff",
    "terminal.ansiCyan": "#39c5cf",
    "terminal.ansiWhite": "#b1bac4",
    "terminal.ansiBrightBlack": "#6e7681",
    "terminal.ansiBrightRed": "#ffa198",
    "terminal.ansiBrightGreen": "#56d364",
    "terminal.ansiBrightYellow": "#e3b341",
    "terminal.ansiBrightBlue": "#79c0ff",
    "terminal.ansiBrightMagenta": "#d2a8ff",
    "terminal.ansiBrightCyan": "#56d4dd",
    "terminal.ansiBrightWhite": "#ffffff",
  }),
  preset("tokyo-night", "Tokyo Night", "dark", {
    "editor.background": "#1a1b26",
    "editor.foreground": "#a9b1d6",
    "sideBar.background": "#16161e",
    "input.background": "#1b1e2e",
    "panel.border": "#101014",
    "button.background": "#7aa2f7",
    "descriptionForeground": "#565f89",
    "errorForeground": "#f7768e",
    "terminal.ansiBlack": "#15161e",
    "terminal.ansiRed": "#f7768e",
    "terminal.ansiGreen": "#9ece6a",
    "terminal.ansiYellow": "#e0af68",
    "terminal.ansiBlue": "#7aa2f7",
    "terminal.ansiMagenta": "#bb9af7",
    "terminal.ansiCyan": "#7dcfff",
    "terminal.ansiWhite": "#a9b1d6",
    "terminal.ansiBrightBlack": "#414868",
    "terminal.ansiBrightRed": "#f7768e",
    "terminal.ansiBrightGreen": "#9ece6a",
    "terminal.ansiBrightYellow": "#e0af68",
    "terminal.ansiBrightBlue": "#7aa2f7",
    "terminal.ansiBrightMagenta": "#bb9af7",
    "terminal.ansiBrightCyan": "#7dcfff",
    "terminal.ansiBrightWhite": "#c0caf5",
  }),
  preset("catppuccin-mocha", "Catppuccin Mocha", "dark", {
    "editor.background": "#1e1e2e",
    "editor.foreground": "#cdd6f4",
    "sideBar.background": "#181825",
    "input.background": "#313244",
    "panel.border": "#11111b",
    "button.background": "#cba6f7",
    "descriptionForeground": "#a6adc8",
    "errorForeground": "#f38ba8",
    "terminal.ansiBlack": "#45475a",
    "terminal.ansiRed": "#f38ba8",
    "terminal.ansiGreen": "#a6e3a1",
    "terminal.ansiYellow": "#f9e2af",
    "terminal.ansiBlue": "#89b4fa",
    "terminal.ansiMagenta": "#f5c2e7",
    "terminal.ansiCyan": "#94e2d5",
    "terminal.ansiWhite": "#bac2de",
    "terminal.ansiBrightBlack": "#585b70",
    "terminal.ansiBrightRed": "#f38ba8",
    "terminal.ansiBrightGreen": "#a6e3a1",
    "terminal.ansiBrightYellow": "#f9e2af",
    "terminal.ansiBrightBlue": "#89b4fa",
    "terminal.ansiBrightMagenta": "#f5c2e7",
    "terminal.ansiBrightCyan": "#94e2d5",
    "terminal.ansiBrightWhite": "#a6adc8",
  }),
  preset("nord", "Nord", "dark", {
    "editor.background": "#2e3440",
    "editor.foreground": "#d8dee9",
    "sideBar.background": "#2b303b",
    "input.background": "#3b4252",
    "panel.border": "#3b4252",
    "button.background": "#88c0d0",
    "descriptionForeground": "#7b88a1",
    "errorForeground": "#bf616a",
    "terminal.ansiBlack": "#3b4252",
    "terminal.ansiRed": "#bf616a",
    "terminal.ansiGreen": "#a3be8c",
    "terminal.ansiYellow": "#ebcb8b",
    "terminal.ansiBlue": "#81a1c1",
    "terminal.ansiMagenta": "#b48ead",
    "terminal.ansiCyan": "#88c0d0",
    "terminal.ansiWhite": "#e5e9f0",
    "terminal.ansiBrightBlack": "#4c566a",
    "terminal.ansiBrightRed": "#bf616a",
    "terminal.ansiBrightGreen": "#a3be8c",
    "terminal.ansiBrightYellow": "#ebcb8b",
    "terminal.ansiBrightBlue": "#81a1c1",
    "terminal.ansiBrightMagenta": "#b48ead",
    "terminal.ansiBrightCyan": "#8fbcbb",
    "terminal.ansiBrightWhite": "#eceff4",
  }),
  preset("monokai", "Monokai", "dark", {
    "editor.background": "#272822",
    "editor.foreground": "#f8f8f2",
    "sideBar.background": "#1e1f1c",
    "input.background": "#414339",
    "panel.border": "#414339",
    "button.background": "#a6e22e",
    "descriptionForeground": "#75715e",
    "errorForeground": "#f92672",
    "terminal.ansiBlack": "#333333",
    "terminal.ansiRed": "#f92672",
    "terminal.ansiGreen": "#a6e22e",
    "terminal.ansiYellow": "#e6db74",
    "terminal.ansiBlue": "#66d9ef",
    "terminal.ansiMagenta": "#ae81ff",
    "terminal.ansiCyan": "#a1efe4",
    "terminal.ansiWhite": "#f8f8f2",
    "terminal.ansiBrightBlack": "#75715e",
    "terminal.ansiBrightRed": "#f92672",
    "terminal.ansiBrightGreen": "#a6e22e",
    "terminal.ansiBrightYellow": "#e6db74",
    "terminal.ansiBrightBlue": "#66d9ef",
    "terminal.ansiBrightMagenta": "#ae81ff",
    "terminal.ansiBrightCyan": "#a1efe4",
    "terminal.ansiBrightWhite": "#f9f8f5",
  }),
  preset("gruvbox-dark", "Gruvbox Dark", "dark", {
    "editor.background": "#282828",
    "editor.foreground": "#ebdbb2",
    "sideBar.background": "#1d2021",
    "input.background": "#3c3836",
    "panel.border": "#3c3836",
    "button.background": "#d79921",
    "descriptionForeground": "#928374",
    "errorForeground": "#fb4934",
    "terminal.ansiBlack": "#282828",
    "terminal.ansiRed": "#cc241d",
    "terminal.ansiGreen": "#98971a",
    "terminal.ansiYellow": "#d79921",
    "terminal.ansiBlue": "#458588",
    "terminal.ansiMagenta": "#b16286",
    "terminal.ansiCyan": "#689d6a",
    "terminal.ansiWhite": "#a89984",
    "terminal.ansiBrightBlack": "#928374",
    "terminal.ansiBrightRed": "#fb4934",
    "terminal.ansiBrightGreen": "#b8bb26",
    "terminal.ansiBrightYellow": "#fabd2f",
    "terminal.ansiBrightBlue": "#83a598",
    "terminal.ansiBrightMagenta": "#d3869b",
    "terminal.ansiBrightCyan": "#8ec07c",
    "terminal.ansiBrightWhite": "#ebdbb2",
  }),
  preset("solarized-dark", "Solarized Dark", "dark", {
    "editor.background": "#002b36",
    "editor.foreground": "#839496",
    "sideBar.background": "#00212b",
    "input.background": "#073642",
    "panel.border": "#073642",
    "button.background": "#268bd2",
    "descriptionForeground": "#586e75",
    "errorForeground": "#dc322f",
    "terminal.ansiBlack": "#073642",
    "terminal.ansiRed": "#dc322f",
    "terminal.ansiGreen": "#859900",
    "terminal.ansiYellow": "#b58900",
    "terminal.ansiBlue": "#268bd2",
    "terminal.ansiMagenta": "#d33682",
    "terminal.ansiCyan": "#2aa198",
    "terminal.ansiWhite": "#eee8d5",
    "terminal.ansiBrightBlack": "#586e75",
    "terminal.ansiBrightRed": "#cb4b16",
    "terminal.ansiBrightGreen": "#859900",
    "terminal.ansiBrightYellow": "#b58900",
    "terminal.ansiBrightBlue": "#839496",
    "terminal.ansiBrightMagenta": "#6c71c4",
    "terminal.ansiBrightCyan": "#93a1a1",
    "terminal.ansiBrightWhite": "#fdf6e3",
  }),
  preset("night-owl", "Night Owl", "dark", {
    "editor.background": "#011627",
    "editor.foreground": "#d6deeb",
    "sideBar.background": "#011627",
    "input.background": "#0b2942",
    "panel.border": "#122d42",
    "button.background": "#82aaff",
    "descriptionForeground": "#5f7e97",
    "errorForeground": "#ef5350",
    "terminal.ansiBlack": "#011627",
    "terminal.ansiRed": "#ef5350",
    "terminal.ansiGreen": "#22da6e",
    "terminal.ansiYellow": "#addb67",
    "terminal.ansiBlue": "#82aaff",
    "terminal.ansiMagenta": "#c792ea",
    "terminal.ansiCyan": "#21c7a8",
    "terminal.ansiWhite": "#ffffff",
    "terminal.ansiBrightBlack": "#575656",
    "terminal.ansiBrightRed": "#ef5350",
    "terminal.ansiBrightGreen": "#22da6e",
    "terminal.ansiBrightYellow": "#ffeb95",
    "terminal.ansiBrightBlue": "#82aaff",
    "terminal.ansiBrightMagenta": "#c792ea",
    "terminal.ansiBrightCyan": "#7fdbca",
    "terminal.ansiBrightWhite": "#ffffff",
  }),
  preset("ayu-dark", "Ayu Dark", "dark", {
    "editor.background": "#0b0e14",
    "editor.foreground": "#bfbdb6",
    "sideBar.background": "#0d1017",
    "input.background": "#1c1f25",
    "panel.border": "#1c1f25",
    "button.background": "#e6b450",
    "descriptionForeground": "#565b66",
    "errorForeground": "#ea6c73",
    "terminal.ansiBlack": "#1c1f25",
    "terminal.ansiRed": "#ea6c73",
    "terminal.ansiGreen": "#7fd962",
    "terminal.ansiYellow": "#f9af4f",
    "terminal.ansiBlue": "#53bdfa",
    "terminal.ansiMagenta": "#cda1fa",
    "terminal.ansiCyan": "#90e1c6",
    "terminal.ansiWhite": "#c7c7c7",
    "terminal.ansiBrightBlack": "#686868",
    "terminal.ansiBrightRed": "#f07178",
    "terminal.ansiBrightGreen": "#aad94c",
    "terminal.ansiBrightYellow": "#ffb454",
    "terminal.ansiBrightBlue": "#59c2ff",
    "terminal.ansiBrightMagenta": "#d2a6ff",
    "terminal.ansiBrightCyan": "#95e6cb",
    "terminal.ansiBrightWhite": "#ffffff",
  }),
  preset("palenight", "Palenight", "dark", {
    "editor.background": "#292d3e",
    "editor.foreground": "#a6accd",
    "sideBar.background": "#212433",
    "input.background": "#333748",
    "panel.border": "#2b2a3e",
    "button.background": "#c792ea",
    "descriptionForeground": "#676e95",
    "errorForeground": "#f07178",
    "terminal.ansiBlack": "#676e95",
    "terminal.ansiRed": "#f07178",
    "terminal.ansiGreen": "#c3e88d",
    "terminal.ansiYellow": "#ffcb6b",
    "terminal.ansiBlue": "#82aaff",
    "terminal.ansiMagenta": "#c792ea",
    "terminal.ansiCyan": "#89ddff",
    "terminal.ansiWhite": "#ffffff",
    "terminal.ansiBrightBlack": "#676e95",
    "terminal.ansiBrightRed": "#f07178",
    "terminal.ansiBrightGreen": "#c3e88d",
    "terminal.ansiBrightYellow": "#ffcb6b",
    "terminal.ansiBrightBlue": "#82aaff",
    "terminal.ansiBrightMagenta": "#c792ea",
    "terminal.ansiBrightCyan": "#89ddff",
    "terminal.ansiBrightWhite": "#ffffff",
  }),
  preset("cobalt2", "Cobalt2", "dark", {
    "editor.background": "#193549",
    "editor.foreground": "#ffffff",
    "sideBar.background": "#122738",
    "input.background": "#0d3a58",
    "panel.border": "#15232d",
    "button.background": "#ffc600",
    "descriptionForeground": "#aabed4",
    "errorForeground": "#ff628c",
    "terminal.ansiBlack": "#000000",
    "terminal.ansiRed": "#ff628c",
    "terminal.ansiGreen": "#3ad900",
    "terminal.ansiYellow": "#ffc600",
    "terminal.ansiBlue": "#0088ff",
    "terminal.ansiMagenta": "#fb94ff",
    "terminal.ansiCyan": "#80fcff",
    "terminal.ansiWhite": "#ffffff",
    "terminal.ansiBrightBlack": "#0050a4",
    "terminal.ansiBrightRed": "#ff628c",
    "terminal.ansiBrightGreen": "#3ad900",
    "terminal.ansiBrightYellow": "#ffc600",
    "terminal.ansiBrightBlue": "#0088ff",
    "terminal.ansiBrightMagenta": "#fb94ff",
    "terminal.ansiBrightCyan": "#80fcff",
    "terminal.ansiBrightWhite": "#ffffff",
  }),
  preset("rose-pine", "Rosé Pine", "dark", {
    "editor.background": "#191724",
    "editor.foreground": "#e0def4",
    "sideBar.background": "#1f1d2e",
    "input.background": "#26233a",
    "panel.border": "#26233a",
    "button.background": "#ebbcba",
    "descriptionForeground": "#908caa",
    "errorForeground": "#eb6f92",
    "terminal.ansiBlack": "#26233a",
    "terminal.ansiRed": "#eb6f92",
    "terminal.ansiGreen": "#31748f",
    "terminal.ansiYellow": "#f6c177",
    "terminal.ansiBlue": "#9ccfd8",
    "terminal.ansiMagenta": "#c4a7e7",
    "terminal.ansiCyan": "#ebbcba",
    "terminal.ansiWhite": "#e0def4",
    "terminal.ansiBrightBlack": "#6e6a86",
    "terminal.ansiBrightRed": "#eb6f92",
    "terminal.ansiBrightGreen": "#31748f",
    "terminal.ansiBrightYellow": "#f6c177",
    "terminal.ansiBrightBlue": "#9ccfd8",
    "terminal.ansiBrightMagenta": "#c4a7e7",
    "terminal.ansiBrightCyan": "#ebbcba",
    "terminal.ansiBrightWhite": "#e0def4",
  }),
  preset("github-light", "GitHub Light", "light", {
    "editor.background": "#ffffff",
    "editor.foreground": "#1f2328",
    "sideBar.background": "#f6f8fa",
    "input.background": "#f6f8fa",
    "panel.border": "#d1d9e0",
    "button.background": "#0969da",
    "descriptionForeground": "#59636e",
    "errorForeground": "#cf222e",
    "terminal.ansiBlack": "#24292f",
    "terminal.ansiRed": "#cf222e",
    "terminal.ansiGreen": "#116329",
    "terminal.ansiYellow": "#4d2d00",
    "terminal.ansiBlue": "#0969da",
    "terminal.ansiMagenta": "#8250df",
    "terminal.ansiCyan": "#1b7c83",
    "terminal.ansiWhite": "#6e7781",
    "terminal.ansiBrightBlack": "#57606a",
    "terminal.ansiBrightRed": "#a40e26",
    "terminal.ansiBrightGreen": "#1a7f37",
    "terminal.ansiBrightYellow": "#633c01",
    "terminal.ansiBrightBlue": "#218bff",
    "terminal.ansiBrightMagenta": "#a475f9",
    "terminal.ansiBrightCyan": "#3192aa",
    "terminal.ansiBrightWhite": "#8c959f",
  }),
  preset("solarized-light", "Solarized Light", "light", {
    "editor.background": "#fdf6e3",
    "editor.foreground": "#657b83",
    "sideBar.background": "#eee8d5",
    "input.background": "#eee8d5",
    "panel.border": "#ddd6c1",
    "button.background": "#268bd2",
    "descriptionForeground": "#93a1a1",
    "errorForeground": "#dc322f",
    "terminal.ansiBlack": "#073642",
    "terminal.ansiRed": "#dc322f",
    "terminal.ansiGreen": "#859900",
    "terminal.ansiYellow": "#b58900",
    "terminal.ansiBlue": "#268bd2",
    "terminal.ansiMagenta": "#d33682",
    "terminal.ansiCyan": "#2aa198",
    "terminal.ansiWhite": "#eee8d5",
    "terminal.ansiBrightBlack": "#586e75",
    "terminal.ansiBrightRed": "#cb4b16",
    "terminal.ansiBrightGreen": "#859900",
    "terminal.ansiBrightYellow": "#b58900",
    "terminal.ansiBrightBlue": "#839496",
    "terminal.ansiBrightMagenta": "#6c71c4",
    "terminal.ansiBrightCyan": "#93a1a1",
    "terminal.ansiBrightWhite": "#fdf6e3",
  }),
];

export const BUILTIN_THEMES: readonly Theme[] = [
  INK_PARCHMENT,
  PARCHMENT_LIGHT,
  SLATE,
  ...PRESET_THEMES,
];

/* ------------------------------------------------------------------ */
/* Color helpers                                                       */
/* ------------------------------------------------------------------ */

/** "#rgb" | "#rrggbb" | "#rrggbbaa" → [r,g,b] (alpha composited over black is
 *  NOT applied — alpha is simply dropped; VS Code uses it for overlays). */
function hexToRgb(hex: string): [number, number, number] | null {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length === 8) h = h.slice(0, 6);
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Mix `hex` toward `toward` by t∈[0,1]. */
function mix(hex: string, toward: string, t: number): string {
  const a = hexToRgb(hex);
  const b = hexToRgb(toward);
  if (!a || !b) return hex;
  return rgbToHex(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
}

export function rgba(hex: string, alpha: number): string {
  const c = hexToRgb(hex);
  if (!c) return hex;
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})`;
}

function luminance(hex: string): number {
  const c = hexToRgb(hex);
  if (!c) return 0;
  return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
}

/* ------------------------------------------------------------------ */
/* VS Code theme import                                                */
/* ------------------------------------------------------------------ */

/** Strip // and /* *\/ comments + trailing commas — VS Code themes are JSONC. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let inStr = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inStr) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i++;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += ch;
  }
  out = out.replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(out);
}

interface VsCodeThemeJson {
  name?: string;
  type?: string;
  colors?: Record<string, string>;
  tokenColors?: unknown;
}

/** Build a claude-view Theme from a VS Code color-theme JSON. Missing keys are
 *  derived from editor.background/foreground so partial themes still work. */
export function themeFromVsCode(json: unknown, fallbackName: string): Theme {
  const t = (json ?? {}) as VsCodeThemeJson;
  const c = t.colors ?? {};
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = c[k];
      if (typeof v === "string" && hexToRgb(v)) return v;
    }
    return undefined;
  };

  const bg = pick("editor.background") ?? "#1e1e1e";
  const fg = pick("editor.foreground", "foreground") ?? "#d4d4d4";
  const dark = t.type === "light" ? false : t.type ? true : luminance(bg) < 0.5;
  // Elevation direction: dark themes lighten, light themes darken.
  const up = (base: string, amt: number) => mix(base, dark ? "#ffffff" : "#000000", amt);

  const surface1 = pick("sideBar.background", "editorWidget.background") ?? up(bg, 0.04);
  const surface2 = pick("input.background", "dropdown.background") ?? up(bg, 0.08);
  const border = pick("panel.border", "editorGroup.border", "contrastBorder") ?? up(bg, 0.12);
  const accent =
    pick("button.background", "focusBorder", "activityBarBadge.background", "textLink.foreground") ??
    "#5b9dff";
  const textDim = pick("descriptionForeground", "tab.inactiveForeground") ?? mix(fg, bg, 0.35);
  const textFaint = pick("disabledForeground") ?? mix(fg, bg, 0.55);
  const success = pick("terminal.ansiGreen", "gitDecoration.addedResourceForeground", "testing.iconPassed") ?? "#3fb950";
  const running = pick("terminal.ansiYellow", "editorWarning.foreground", "list.warningForeground") ?? "#e3b341";
  const error = pick("errorForeground", "editorError.foreground", "terminal.ansiRed") ?? "#f0616d";
  const violet = pick("terminal.ansiMagenta") ?? "#c4a2ff";
  const cyan = pick("terminal.ansiCyan") ?? "#56d4dd";
  const blue = pick("terminal.ansiBlue") ?? accent;
  const yellow = pick("terminal.ansiYellow") ?? running;

  const name = (typeof t.name === "string" && t.name.trim()) || fallbackName;
  const id =
    "vsc-" +
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

  const colors: ThemeColors = {
    bg,
    surface: bg,
    surface1,
    surface2,
    titlebar: pick("titleBar.activeBackground", "activityBar.background") ?? up(bg, 0.02),
    sidebar: pick("sideBar.background") ?? mix(bg, dark ? "#000000" : "#ffffff", 0.15),
    border,
    borderStrong: up(border, 0.1),
    divider: pick("editorGroup.border") ?? mix(border, bg, 0.4),
    accentBorder: mix(accent, bg, 0.55),
    text: fg,
    textDim,
    textFaint,
    timestamp: mix(fg, bg, 0.6),
    cmd: pick("terminal.foreground") ?? fg,
    cmdFold: mix(fg, bg, 0.25),
    accent,
    accentInk: pick("button.foreground") ?? (luminance(accent) > 0.5 ? "#14110d" : "#ffffff"),
    searchGlyph: mix(accent, fg, 0.25),
    success,
    running,
    error,
    idle: textFaint,
    modelViolet: violet,
    errorText: mix(error, fg, 0.4),
    errorPreview: mix(error, fg, 0.25),
    errorBorder: mix(error, bg, 0.6),
    toolBash: yellow,
    toolEdit: violet,
    toolRead: success,
    toolGrep: cyan,
    toolWeb: blue,
    toolTask: pick("terminal.ansiBrightMagenta") ?? violet,
  };

  const term = (k: string, fb: string) => pick(`terminal.${k}`) ?? fb;
  const terminal: XtermPalette = {
    background: term("background", bg),
    foreground: term("foreground", fg),
    cursor: pick("terminalCursor.foreground") ?? accent,
    cursorAccent: pick("terminalCursor.background") ?? bg,
    selectionBackground: pick("terminal.selectionBackground") ?? mix(accent, bg, 0.6),
    black: term("ansiBlack", up(bg, 0.1)),
    red: term("ansiRed", error),
    green: term("ansiGreen", success),
    yellow: term("ansiYellow", running),
    blue: term("ansiBlue", blue),
    magenta: term("ansiMagenta", violet),
    cyan: term("ansiCyan", cyan),
    white: term("ansiWhite", fg),
    brightBlack: term("ansiBrightBlack", textFaint),
    brightRed: term("ansiBrightRed", error),
    brightGreen: term("ansiBrightGreen", success),
    brightYellow: term("ansiBrightYellow", running),
    brightBlue: term("ansiBrightBlue", blue),
    brightMagenta: term("ansiBrightMagenta", violet),
    brightCyan: term("ansiBrightCyan", cyan),
    brightWhite: term("ansiBrightWhite", dark ? "#ffffff" : fg),
  };

  return { id, name, kind: dark ? "dark" : "light", colors, terminal };
}

/* ------------------------------------------------------------------ */
/* CSS variable application                                            */
/* ------------------------------------------------------------------ */

export function themeToCssVars(theme: Theme): Record<string, string> {
  const c = theme.colors;
  return {
    "--cv-bg": c.bg,
    "--cv-surface": c.surface,
    "--cv-surface1": c.surface1,
    "--cv-surface2": c.surface2,
    "--cv-titlebar": c.titlebar,
    "--cv-sidebar": c.sidebar,
    "--cv-border": c.border,
    "--cv-border-strong": c.borderStrong,
    "--cv-divider": c.divider,
    "--cv-accent-border": c.accentBorder,
    "--cv-text": c.text,
    "--cv-text-dim": c.textDim,
    "--cv-text-faint": c.textFaint,
    "--cv-timestamp": c.timestamp,
    "--cv-cmd": c.cmd,
    "--cv-cmd-fold": c.cmdFold,
    "--cv-accent": c.accent,
    "--cv-accent-ink": c.accentInk,
    "--cv-accent-soft": rgba(c.accent, 0.1),
    "--cv-accent-soft2": rgba(c.accent, 0.15),
    "--cv-accent-hover": rgba(c.accent, 0.05),
    "--cv-search-glyph": c.searchGlyph,
    "--cv-success": c.success,
    "--cv-success-soft": rgba(c.success, 0.1),
    "--cv-success-border": mix(c.success, c.bg, 0.65),
    "--cv-running": c.running,
    "--cv-error": c.error,
    "--cv-error-tint": rgba(c.error, 0.07),
    "--cv-error-text": c.errorText,
    "--cv-error-preview": c.errorPreview,
    "--cv-error-border": c.errorBorder,
    "--cv-idle": c.idle,
    "--cv-model-violet": c.modelViolet,
    "--cv-tool-bash": c.toolBash,
    "--cv-tool-edit": c.toolEdit,
    "--cv-tool-read": c.toolRead,
    "--cv-tool-grep": c.toolGrep,
    "--cv-tool-web": c.toolWeb,
    "--cv-tool-task": c.toolTask,
    "--cv-shadow":
      theme.kind === "dark" ? "0 20px 50px rgba(0,0,0,0.5)" : "0 20px 50px rgba(58,50,38,0.22)",
  };
}

/* ------------------------------------------------------------------ */
/* Store: current theme + custom themes, persisted, cross-window sync  */
/* ------------------------------------------------------------------ */

const CURRENT_KEY = "cv.theme.current";
const CUSTOM_KEY = "cv.theme.custom";

type Listener = (theme: Theme) => void;
const listeners = new Set<Listener>();
let current: Theme = INK_PARCHMENT;

export function customThemes(): Theme[] {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as Theme[];
    return Array.isArray(arr) ? arr.filter((t) => t && t.id && t.colors && t.terminal) : [];
  } catch {
    return [];
  }
}

export function allThemes(): Theme[] {
  return [...BUILTIN_THEMES, ...customThemes()];
}

export function currentTheme(): Theme {
  return current;
}

function themeById(id: string | null): Theme | undefined {
  if (!id) return undefined;
  return allThemes().find((t) => t.id === id);
}

function apply(theme: Theme) {
  current = theme;
  const root = document.documentElement;
  const vars = themeToCssVars(theme);
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.style.colorScheme = theme.kind;
  listeners.forEach((cb) => cb(theme));
}

/** Switch theme and persist the choice (all windows follow via `storage`). */
export function setTheme(id: string) {
  const t = themeById(id);
  if (!t) return;
  apply(t);
  try {
    localStorage.setItem(CURRENT_KEY, id);
  } catch {
    // private mode etc. — theme still applies for this window
  }
}

/** Save an imported theme (replacing any custom theme with the same id) and
 *  switch to it. */
export function addCustomTheme(theme: Theme) {
  const rest = customThemes().filter((t) => t.id !== theme.id);
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify([...rest, theme]));
  } catch {
    // storage full — still usable this session
  }
  apply(theme);
  try {
    localStorage.setItem(CURRENT_KEY, theme.id);
  } catch {
    /* ignore */
  }
}

export function removeCustomTheme(id: string) {
  const rest = customThemes().filter((t) => t.id !== id);
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(rest));
  } catch {
    /* ignore */
  }
  if (current.id === id) setTheme(INK_PARCHMENT.id);
}

/** Live theme subscription (Terminal.tsx re-themes xterm on change). */
export function onThemeChange(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Apply the persisted theme before first render; wires cross-window sync. */
export function initTheme() {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(CURRENT_KEY);
  } catch {
    /* ignore */
  }
  apply(themeById(saved) ?? INK_PARCHMENT);
  window.addEventListener("storage", (e) => {
    if (e.key === CURRENT_KEY || e.key === CUSTOM_KEY) {
      let id: string | null = null;
      try {
        id = localStorage.getItem(CURRENT_KEY);
      } catch {
        /* ignore */
      }
      const t = themeById(id);
      if (t && t.id !== current.id) apply(t);
    }
  });
}
