import { useEffect } from "react";

/**
 * Run `fn` every `ms`, but only while the window is actually visible.
 *
 * Every panel in this app polls: the trace at 1.2s, the roster and a watched
 * session's liveness at 1.5s, the launcher's session list at 2s. None of them
 * checked whether anyone could see the result, so a viewer on another
 * workspace — or one simply minimised — kept firing an IPC call per timer and
 * re-rendering on every reply, and each re-render costs a WebKit relayout and
 * a compositor repaint. Measured on an idle window, that was the single
 * largest CPU consumer in the app, and all of it was being thrown away.
 *
 * A hidden tick is **skipped, not queued**: these are all "what is true now"
 * reads, so catching up means one fresh call on return, not replaying the
 * ticks that were missed. `visibilitychange` does exactly that, which is why
 * coming back never shows stale state.
 *
 * `document.hidden` reliably covers minimised and other-workspace. A window
 * merely *occluded* by another on the same workspace may still report visible,
 * depending on the compositor — so this is a large win, not a total one.
 */
export function usePoll(fn: () => void, ms: number) {
  useEffect(() => {
    const tick = () => {
      if (!document.hidden) fn();
    };
    tick();
    const timer = setInterval(tick, ms);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [fn, ms]);
}
