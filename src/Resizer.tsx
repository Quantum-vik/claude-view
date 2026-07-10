import { useEffect, useRef } from "react";

/**
 * A thin vertical drag handle with a 3-dot grip. Reports the horizontal drag
 * delta (in px) to `onResize`; the parent decides how that maps to a width.
 * Window-level listeners keep the drag alive even when the cursor passes over
 * an xterm terminal or other child that would otherwise swallow mouse events.
 */
export function DragHandle({
  onResize,
  title,
}: {
  onResize: (deltaX: number) => void;
  title?: string;
}) {
  const active = useRef(false);
  const last = useRef(0);
  const cb = useRef(onResize);
  cb.current = onResize;

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!active.current) return;
      const cur = e.clientX;
      cb.current(cur - last.current);
      last.current = cur;
    };
    const up = () => {
      if (!active.current) return;
      active.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, []);

  return (
    <div
      title={title ?? "Drag to resize"}
      onMouseDown={(e) => {
        active.current = true;
        last.current = e.clientX;
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        e.preventDefault();
      }}
      style={{
        width: 8,
        flexShrink: 0,
        cursor: "col-resize",
        background: "#161617",
        borderLeft: "1px solid #2a2a2a",
        borderRight: "1px solid #2a2a2a",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {[0, 1, 2].map((i) => (
          <span key={i} style={{ width: 3, height: 3, borderRadius: "50%", background: "#555" }} />
        ))}
      </div>
    </div>
  );
}

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
