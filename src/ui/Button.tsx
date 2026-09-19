/**
 * The three button shapes this app actually uses.
 *
 * Not a general Button: a survey found 48 `cursor: pointer` blocks across 10
 * files, and forcing all of them through one component would mean a prop for
 * every difference. These are the three that repeat with the same INTENT.
 *
 *   chip   a toggle that is on or off — panel views, trace filters
 *   quiet  a secondary action that should not compete — "Show the diff"
 *   link   an action that reads as text — "↻ rescan"
 *
 * The drift this prevents is on record: `SessionWindow.tsx` still carries a
 * comment saying three hand-written copies of one button are "how the Trace and
 * Agents buttons drifted out of sync with Timeline's toggle in the first
 * place". They looked the same until one of them stopped behaving the same.
 */
import type { CSSProperties, MouseEvent, PointerEvent, ReactNode } from "react";
import { T, tint } from "../tokens";

type Variant = "chip" | "quiet" | "link";

export function Button({
  variant = "quiet",
  on = false,
  title,
  onClick,
  onPointerDown,
  style,
  children,
  "aria-label": ariaLabel,
}: {
  variant?: Variant;
  /** `chip` only: whether the toggle is currently on. */
  on?: boolean;
  title?: string;
  /** Receives the event: several call sites are inside a clickable row and must
   *  stop propagation, which is a behaviour need rather than a styling one. */
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  /** Same reason, for rows that begin a drag on pointer-down. */
  onPointerDown?: (e: PointerEvent<HTMLButtonElement>) => void;
  "aria-label"?: string;
  /** Escape hatch for placement (margins, flex), not for repainting. */
  style?: CSSProperties;
  children: ReactNode;
}) {
  const base: CSSProperties = {
    cursor: "pointer",
    fontFamily: T.mono,
    // A real <button> for every variant, link included: the keyboard and the
    // screen reader care what it is, not what it looks like.
    font: "inherit",
  };

  const variants: Record<Variant, CSSProperties> = {
    chip: {
      padding: "3px 11px",
      borderRadius: 999,
      fontSize: 11.5,
      color: on ? T.accent : T.textDim,
      background: on ? tint(T.accent, 0.15) : "transparent",
      border: `1px solid ${on ? T.borderAccent : "transparent"}`,
    },
    quiet: {
      padding: "4px 10px",
      borderRadius: 6,
      fontSize: 11.5,
      color: T.text,
      background: T.surface2,
      border: `1px solid ${T.borderStrong}`,
    },
    link: {
      padding: 0,
      border: "none",
      background: "none",
      color: T.accent,
      fontSize: "inherit",
    },
  };

  return (
    <button
      type="button"
      title={title}
      aria-label={ariaLabel}
      onClick={onClick}
      onPointerDown={onPointerDown}
      aria-pressed={variant === "chip" ? on : undefined}
      style={{ ...base, ...variants[variant], ...style }}
    >
      {children}
    </button>
  );
}
