import { describe, expect, it } from "vitest";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import { mergeOnOpen } from "../data/mergeOnOpen";

const element = (
  id: string,
  version: number,
  versionNonce = 1,
  extra: Record<string, unknown> = {},
) =>
  ({
    id,
    type: "rectangle",
    version,
    versionNonce,
    ...extra,
  } as unknown as ExcalidrawElement);

describe("mergeOnOpen", () => {
  it("keeps what was saved when the room has nothing to say", () => {
    const stored = [element("a", 1), element("b", 1)];
    expect(mergeOnOpen(stored, [])).toBe(stored);
    expect(mergeOnOpen(stored, null)).toBe(stored);
    expect(mergeOnOpen(stored, undefined)).toBe(stored);
  });

  it("keeps an element the room has not heard of", () => {
    // Somebody saved while the room was quiet. Their work was being dropped.
    const merged = mergeOnOpen(
      [element("mine", 1), element("theirs", 1)],
      [element("mine", 1)],
    );
    expect(merged.map((e) => e.id).sort()).toEqual(["mine", "theirs"]);
  });

  it("takes the room's copy when the room's is newer", () => {
    const merged = mergeOnOpen(
      [element("a", 1, 1, { x: 0 })],
      [element("a", 5, 1, { x: 99 })],
    );
    expect(merged).toHaveLength(1);
    expect((merged[0] as unknown as { x: number }).x).toBe(99);
  });

  it("keeps the stored copy when the room's is older", () => {
    const merged = mergeOnOpen(
      [element("a", 9, 1, { x: 0 })],
      [element("a", 2, 1, { x: 99 })],
    );
    expect((merged[0] as unknown as { x: number }).x).toBe(0);
  });

  it("breaks an equal version by the lower nonce, so everyone agrees", () => {
    const lower = mergeOnOpen(
      [element("a", 4, 500, { x: 0 })],
      [element("a", 4, 100, { x: 99 })],
    );
    expect((lower[0] as unknown as { x: number }).x).toBe(99);
    const higher = mergeOnOpen(
      [element("a", 4, 100, { x: 0 })],
      [element("a", 4, 500, { x: 99 })],
    );
    expect((higher[0] as unknown as { x: number }).x).toBe(0);
  });

  it("takes the room whole when nothing was stored", () => {
    const room = [element("a", 1)];
    expect(mergeOnOpen([], room)).toBe(room);
  });

  it("brings in elements only the room has", () => {
    const merged = mergeOnOpen([element("a", 1)], [element("b", 1)]);
    expect(merged.map((e) => e.id).sort()).toEqual(["a", "b"]);
  });

  it("carries a deletion that is newer", () => {
    const merged = mergeOnOpen(
      [element("a", 1, 1, { isDeleted: false })],
      [element("a", 7, 1, { isDeleted: true })],
    );
    expect((merged[0] as unknown as { isDeleted: boolean }).isDeleted).toBe(
      true,
    );
  });
});
