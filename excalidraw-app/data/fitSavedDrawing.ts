import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

/** How often to look at the editor's idea of its own size, in ms. */
const TICK_MS = 50;
/** Consecutive ticks the size must repeat before it counts as settled. */
const STEADY_TICKS = 3;
/** How long to keep waiting for a drawing that has not arrived yet. */
const PATIENCE_MS = 20000;
/** How long after the first fit the view may still correct itself. */
const SETTLE_MS = 3000;

/** Anything that means the person has taken over; the view is theirs now. */
const HANDS_ON = ["pointerdown", "wheel", "keydown", "touchstart"] as const;

/**
 * Shows the whole of a saved drawing when it opens.
 *
 * Two things used to decide where a drawing landed, and both were wrong.
 * `scrollToContent` centres on whichever single element is nearest the current
 * view as soon as the work is wider than the window, so most of a drawing sat
 * outside the viewport; and it ran before the workspace sidebar had narrowed
 * the editor, so even that one element was centred against a window wider than
 * the canvas it was drawn on. Together they opened a saved drawing on empty
 * canvas with the work just off the edge — which reads as the drawing having
 * been lost, until a scroll brings it back.
 *
 * What matters is the width the editor itself will divide by, so that is what
 * is watched — but only once it agrees with the box the editor is drawn in,
 * and only once it has then held still for a few ticks. Either test alone is
 * not enough: a stale width can sit perfectly still, and a width that matches
 * for one frame can still be mid-change.
 *
 * The wait runs until the drawing actually arrives rather than for a fixed few
 * seconds, because a slow load was the difference between a drawing that
 * opened in view and one that did not. After the first fit the size is watched
 * a little longer, since the workspace sidebar opens on its own schedule and
 * changes it. The moment the person touches the canvas, the view is theirs.
 *
 * `scale-down` never zooms past 100%, so a small sketch is not blown up.
 *
 * Returns a teardown function.
 */
export const fitSavedDrawing = (
  api: ExcalidrawImperativeAPI,
  container: HTMLElement,
): (() => void) => {
  const win = container.ownerDocument.defaultView;
  if (!win) {
    return () => {};
  }
  let close: number | undefined;
  let seen = "";
  let steady = 0;
  let fitted = "";
  let done = false;
  const giveUpAt = Date.now() + PATIENCE_MS;

  const stop = () => {
    if (done) {
      return;
    }
    done = true;
    win.clearInterval(timer);
    if (close !== undefined) {
      win.clearTimeout(close);
    }
    for (const event of HANDS_ON) {
      container.removeEventListener(event, stop, true);
    }
  };

  const tick = () => {
    if (done) {
      return;
    }
    if (Date.now() > giveUpAt) {
      // No drawing is coming. Leave the view alone rather than ticking for
      // the rest of the session.
      stop();
      return;
    }
    const { width, height } = api.getAppState();
    if (!width || !height) {
      return;
    }
    // The editor keeps its own copy of its size and only re-measures when
    // something tells it to. Until that copy agrees with the box it is drawn
    // in, it is the stale one — fitting against it is what put drawings off
    // the side of the screen.
    if (
      Math.round(width) !== Math.round(container.clientWidth) ||
      Math.round(height) !== Math.round(container.clientHeight)
    ) {
      seen = "";
      steady = 0;
      return;
    }
    const size = `${Math.round(width)}x${Math.round(height)}`;
    if (size !== seen) {
      seen = size;
      steady = 0;
      return;
    }
    steady += 1;
    if (steady < STEADY_TICKS || size === fitted) {
      return;
    }
    const elements = api.getSceneElements();
    // An empty drawing has nothing to fit, and one whose elements have not
    // arrived yet comes back round on the next tick.
    if (!elements.length) {
      return;
    }
    if (!fitted) {
      // The drawing is on screen. The only thing still worth waiting for is
      // the sidebar changing the size underneath it.
      close = win.setTimeout(stop, SETTLE_MS);
    }
    fitted = size;
    api.setViewport({
      target: elements,
      fit: "scale-down",
      animation: false,
      // Keep the drawing clear of the toolbar and the panels, and off the
      // edges: fitted exactly, the outermost shapes sit flush against the
      // sides and read as cut off.
      offsets: { ui: { padding: 32 } },
    });
  };

  for (const event of HANDS_ON) {
    container.addEventListener(event, stop, true);
  }
  const timer = win.setInterval(tick, TICK_MS);
  tick();
  return stop;
};
