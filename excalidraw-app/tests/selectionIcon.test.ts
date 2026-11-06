import { describe, expect, it } from "vitest";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import { selectedForIcon } from "../data/selectionIcon";

const element = (id: string, isDeleted = false) =>
  ({ id, type: "rectangle", isDeleted } as unknown as ExcalidrawElement);

const selection = (...ids: string[]) => ({
  selectedElementIds: Object.fromEntries(ids.map((id) => [id, true])) as {
    [id: string]: true;
  },
});

describe("selectedForIcon", () => {
  it("takes nothing when nothing is selected", () => {
    expect(selectedForIcon([element("a")], selection())).toEqual([]);
  });

  it("takes a shape somebody drew, not only a stored picture", () => {
    // This is the whole point: a drawn rectangle is an icon candidate now.
    const drawn = element("drawn");
    expect(selectedForIcon([drawn], selection("drawn"))).toEqual([drawn]);
  });

  it("takes every selected element, in canvas order", () => {
    const elements = [element("a"), element("b"), element("c")];
    expect(
      selectedForIcon(elements, selection("c", "a")).map((e) => e.id),
    ).toEqual(["a", "c"]);
  });

  it("leaves out what was deleted", () => {
    // A tombstone is still in the array the editor hands over.
    const elements = [element("gone", true), element("here")];
    expect(
      selectedForIcon(elements, selection("gone", "here")).map((e) => e.id),
    ).toEqual(["here"]);
  });

  it("leaves out what was not selected", () => {
    const elements = [element("a"), element("b")];
    expect(selectedForIcon(elements, selection("b")).map((e) => e.id)).toEqual([
      "b",
    ]);
  });
});
