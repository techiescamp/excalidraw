import type { ExcalidrawElement } from "@excalidraw/element/types";

/**
 * What a drawing shows the moment it opens.
 *
 * Two sources answer at once: the database, which is what was saved, and the
 * collaboration room, which is what the people in it were last broadcasting.
 * Neither is reliably newer. Taking the room's answer whole — which is what
 * opening a drawing used to do — hid work that had been saved since the room
 * last spoke, so someone else's shapes were simply missing until something
 * happened to refresh them.
 *
 * So converge the two the way everything else in this app converges: per
 * element, the higher `version` wins, and an equal version is broken by the
 * lower `versionNonce`. That is the editor's own rule, and the same one the
 * server applies when it merges a save, so all three agree on the answer.
 */
export const mergeOnOpen = <T extends ExcalidrawElement>(
  stored: readonly T[],
  fromRoom: readonly T[] | null | undefined,
): readonly T[] => {
  if (!fromRoom?.length) {
    return stored;
  }
  if (!stored.length) {
    return fromRoom;
  }
  const merged = new Map(stored.map((element) => [element.id, element]));
  for (const incoming of fromRoom) {
    const existing = merged.get(incoming.id);
    if (!existing || wins(incoming, existing)) {
      merged.set(incoming.id, incoming);
    }
  }
  return [...merged.values()];
};

const wins = (incoming: ExcalidrawElement, existing: ExcalidrawElement) => {
  const a = incoming.version ?? 0;
  const b = existing.version ?? 0;
  if (a !== b) {
    return a > b;
  }
  // Same version from two places: the nonce decides, so every participant
  // picks the same one rather than whichever they happened to hear last.
  return (incoming.versionNonce ?? 0) < (existing.versionNonce ?? 0);
};
