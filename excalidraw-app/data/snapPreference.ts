/**
 * Whether "Snap to objects" is on, remembered per person per drawing.
 *
 * Snapping is a working preference, not a property of the drawing: one person
 * lining two pictures up wants it, and the next person opening the same board
 * wants to drag freely. So it is stored against the `user:workspace:scene` key
 * rather than saved into the scene, which keeps it off everybody else's canvas
 * and off this person's other canvases.
 *
 * Storage can be unavailable or full — a private window, blocked site data —
 * and a preference is never worth an exception, so every access is guarded and
 * a failure simply means the editor's own default applies.
 */
const PREFIX = "excalidraw-snap:";

export const readSnapPreference = (key: string | null): boolean | null => {
  if (!key) {
    return null;
  }
  try {
    const stored = window.localStorage.getItem(`${PREFIX}${key}`);
    return stored === null ? null : stored === "1";
  } catch {
    return null;
  }
};

export const writeSnapPreference = (key: string | null, enabled: boolean) => {
  if (!key) {
    return;
  }
  try {
    window.localStorage.setItem(`${PREFIX}${key}`, enabled ? "1" : "0");
  } catch {
    // remembering is a convenience; losing it must not break the editor
  }
};
