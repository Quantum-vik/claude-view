import { useRef } from "react";
import { T } from "./tokens";

/**
 * A thin vertical drag handle with a 3-dot grip. Reports the horizontal drag
 * delta (in px) to `onResize`; the parent decides how that maps to a width.
 *
 * Uses Pointer Events with pointer capture: the handle keeps receiving moves
 * and — critically — the pointerup even when the cursor leaves the window
 * mid-drag (a plain window mouseup can be dropped there, which used to leave
 * the drag "stuck" and the parent's commit callback never ran).
 *
 * Smoothness: move events (60–120 Hz) are coalesced with requestAnimationFrame
 * so `onResize` fires at most once per frame. `onResizeEnd` fires exactly once
 * per drag so the parent can commit/persist the final width.
 */
export function DragHandle({
  onResize,
  onResizeEnd,
  title,
}: {
  onResize: (deltaX: number) => void;
  onResizeEnd?: () => void;
  title?: string;
}) {
  const active = useRef(false);
  const last = useRef(0);
  const pending = useRef(0);
  const raf = useRef(0);
  const cb = useRef(onResize);
  const endCb = useRef(onResizeEnd);
  cb.current = onResize;
  endCb.current = onResizeEnd;

  const flush = () => {
    raf.current = 0;
    if (pending.current !== 0) {
      const d = pending.current;
      pending.current = 0;
      cb.current(d);
    }
  };

  const end = () => {
    if (!active.current) return;
    active.current = false;
    if (raf.current) {
      cancelAnimationFrame(raf.current);
      flush();
    }
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    endCb.current?.();
  };

  return (
    <div
      title={title ?? "Drag to resize"}
      // The core layout decision of the app was pointer-only. The callback
      // contract is already delta-shaped, so arrow keys reuse it unchanged —
      // nothing downstream has to know a keyboard moved the handle.
      role="separator"
      aria-orientation="vertical"
      aria-label={title ?? "Resize panel"}
      tabIndex={0}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 64 : 16;
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          cb.current(-step);
          endCb.current?.();
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          cb.current(step);
          endCb.current?.();
        }
      }}
      onPointerDown={(e) => {
        active.current = true;
        last.current = e.clientX;
        pending.current = 0;
        // Capture: moves and the release are delivered to this element even
        // if the cursor leaves the window.
        e.currentTarget.setPointerCapture(e.pointerId);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        e.preventDefault();
      }}
      onPointerMove={(e) => {
        if (!active.current) return;
        pending.current += e.clientX - last.current;
        last.current = e.clientX;
        if (!raf.current) raf.current = requestAnimationFrame(flush);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      // Belt-and-braces: if capture is lost for any reason, finish the drag so
      // the parent still commits.
      onLostPointerCapture={end}
      style={{
        width: 8,
        flexShrink: 0,
        cursor: "col-resize",
        touchAction: "none",
        background: T.titlebar,
        borderLeft: `1px solid ${T.border}`,
        borderRight: `1px solid ${T.border}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            style={{ width: 3, height: 3, borderRadius: "50%", background: T.textFaint }}
          />
        ))}
      </div>
    </div>
  );
}

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
