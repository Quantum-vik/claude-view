import { useEffect, useRef, useState } from "react";
import { T } from "./tokens";
import {
  allThemes,
  currentTheme,
  onThemeChange,
  setTheme,
  addCustomTheme,
  removeCustomTheme,
  parseJsonc,
  themeFromVsCode,
  type Theme,
} from "./themes";

/**
 * Theme switcher — a compact ◐ header button that opens a popover listing the
 * built-in themes plus any imported VS Code themes (with per-theme color
 * swatches), and an "Import VS Code theme…" action that accepts a color-theme
 * .json/.jsonc file. The choice persists and follows across app windows.
 */
export default function ThemeMenu({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(currentTheme().id);
  const [importError, setImportError] = useState<string | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  // Follow theme changes from anywhere (this menu, another window).
  useEffect(() => onThemeChange((t) => setActive(t.id)), []);

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    const r = anchorRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
    setImportError(null);
    setOpen(true);
  }

  function handleFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const json = parseJsonc(String(reader.result));
        const name = file.name.replace(/\.(json|jsonc)$/i, "").replace(/[-_.]/g, " ");
        const theme = themeFromVsCode(json, name);
        addCustomTheme(theme);
        setImportError(null);
      } catch {
        setImportError("Couldn't read that file as a VS Code color theme.");
      }
    };
    reader.onerror = () => setImportError("Couldn't read the file.");
    reader.readAsText(file);
  }

  const themes = allThemes();

  return (
    <div ref={anchorRef} style={{ flexShrink: 0, position: "relative" }}>
      <button
        onClick={toggle}
        title="Color theme"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          background: open ? T.surface2 : "transparent",
          border: `1px solid ${open ? T.accentBorder : T.border}`,
          borderRadius: 8,
          color: T.textDim,
          fontSize: compact ? 12 : 13,
          padding: compact ? "4px 9px" : "8px 12px",
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        <span aria-hidden style={{ fontSize: compact ? 12 : 13, lineHeight: 1 }}>
          ◐
        </span>
        {!compact && <span style={{ fontFamily: T.serif, fontWeight: 600 }}>Theme</span>}
      </button>

      {open && pos && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 300 }} />
          <div
            style={{
              position: "fixed",
              top: pos.top,
              right: pos.right,
              zIndex: 301,
              width: 264,
              background: T.surface1,
              border: `1px solid ${T.borderStrong}`,
              borderRadius: 12,
              boxShadow: T.windowShadow,
              padding: 10,
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            <div
              style={{
                fontFamily: T.serif,
                fontSize: 12.5,
                fontWeight: 600,
                color: T.text,
                padding: "2px 4px 6px",
              }}
            >
              Color theme
            </div>

            {/* 19 built-ins + imports — scrolls past ~8 rows. */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 4,
                maxHeight: 330,
                overflowY: "auto",
                overflowX: "hidden",
              }}
            >
              {themes.map((t) => (
                <ThemeRow
                  key={t.id}
                  theme={t}
                  active={t.id === active}
                  onPick={() => setTheme(t.id)}
                  onRemove={t.builtin ? undefined : () => removeCustomTheme(t.id)}
                />
              ))}
            </div>

            <div style={{ height: 1, background: T.divider, margin: "6px 0" }} />

            <button
              onClick={() => fileRef.current?.click()}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                background: "transparent",
                border: `1px dashed ${T.borderStrong}`,
                borderRadius: 8,
                color: T.textDim,
                fontSize: 12,
                padding: "7px 10px",
                cursor: "pointer",
                textAlign: "left",
              }}
              title="Import a VS Code color theme (.json) — find them in ~/.vscode/extensions/*/themes/"
            >
              <span style={{ color: T.accent }}>⇪</span>
              Import VS Code theme…
            </button>
            {importError && (
              <div style={{ color: T.error, fontSize: 11, padding: "2px 4px" }}>{importError}</div>
            )}
            <div style={{ color: T.textFaint, fontSize: 10.5, lineHeight: 1.5, padding: "2px 4px" }}>
              Any VS Code color theme JSON works — colors map onto the app and the terminal.
            </div>

            <input
              ref={fileRef}
              type="file"
              accept=".json,.jsonc,application/json"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
                e.target.value = "";
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}

function ThemeRow({
  theme,
  active,
  onPick,
  onRemove,
}: {
  theme: Theme;
  active: boolean;
  onPick: () => void;
  onRemove?: () => void;
}) {
  const c = theme.colors;
  return (
    <div
      onClick={onPick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 9,
        padding: "6px 8px",
        borderRadius: 8,
        cursor: "pointer",
        background: active ? T.accentSoft : "transparent",
        border: `1px solid ${active ? T.accentBorder : "transparent"}`,
      }}
    >
      {/* Swatch: bg + accent + text preview */}
      <span
        aria-hidden
        style={{
          display: "flex",
          width: 34,
          height: 20,
          borderRadius: 5,
          overflow: "hidden",
          border: `1px solid ${T.borderStrong}`,
          flexShrink: 0,
          background: c.bg,
          alignItems: "center",
          justifyContent: "center",
          gap: 3,
        }}
      >
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: c.accent }} />
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: c.text }} />
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 12.5,
          color: active ? T.text : T.textDim,
          fontWeight: active ? 600 : 400,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {theme.name}
        {!theme.builtin && (
          <span style={{ color: T.textFaint, fontSize: 10.5 }}> · imported</span>
        )}
      </span>
      {active && <span style={{ color: T.accent, fontSize: 11, flexShrink: 0 }}>✓</span>}
      {onRemove && (
        <span
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          title="Remove imported theme"
          style={{ color: T.textFaint, fontSize: 11, padding: "0 2px", cursor: "pointer" }}
        >
          ✕
        </span>
      )}
    </div>
  );
}
