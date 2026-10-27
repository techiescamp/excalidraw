import { renderSnaps } from "./renderSnaps";

import type { InteractiveCanvasAppState } from "../types";

const setup = (overrides: Partial<InteractiveCanvasAppState> = {}) => {
  const canvas = document.createElement("canvas");
  canvas.width = 400;
  canvas.height = 300;
  const context = canvas.getContext("2d")!;
  const fillText = vi.spyOn(context, "fillText");

  const appState = {
    scrollX: 0,
    scrollY: 0,
    zoom: { value: 1 },
    theme: "light",
    zenModeEnabled: false,
    snapLines: [],
    ...overrides,
  } as unknown as InteractiveCanvasAppState;

  return { context, appState, fillText };
};

const gapLine = (
  from: [number, number],
  to: [number, number],
  direction: "horizontal" | "vertical",
) => ({ type: "gap" as const, direction, points: [from, to] });

describe("gap snap labels", () => {
  it("writes the gap between two elements, so a distance can be read rather than guessed", () => {
    const { context, appState, fillText } = setup({
      snapLines: [gapLine([100, 50], [220, 50], "horizontal")] as any,
    });

    renderSnaps(context, appState);

    expect(fillText).toHaveBeenCalledWith(
      "120",
      expect.any(Number),
      expect.any(Number),
    );
  });

  it("measures a vertical gap along the other axis", () => {
    const { context, appState, fillText } = setup({
      snapLines: [gapLine([40, 20], [40, 95], "vertical")] as any,
    });

    renderSnaps(context, appState);

    expect(fillText).toHaveBeenCalledWith(
      "75",
      expect.any(Number),
      expect.any(Number),
    );
  });

  it("says nothing when the elements touch, because a zero is only noise", () => {
    const { context, appState, fillText } = setup({
      snapLines: [gapLine([100, 50], [100, 50], "horizontal")] as any,
    });

    renderSnaps(context, appState);

    expect(fillText).not.toHaveBeenCalled();
  });

  it("stays quiet in zen mode, which hides the guides themselves", () => {
    const { context, appState, fillText } = setup({
      zenModeEnabled: true,
      snapLines: [gapLine([100, 50], [220, 50], "horizontal")] as any,
    });

    renderSnaps(context, appState);

    expect(fillText).not.toHaveBeenCalled();
  });

  it("keeps the label the same size on screen whatever the zoom", () => {
    const sizes: number[] = [];

    for (const zoom of [0.5, 1, 4]) {
      const { context, appState } = setup({
        zoom: { value: zoom } as InteractiveCanvasAppState["zoom"],
        snapLines: [gapLine([100, 50], [220, 50], "horizontal")] as any,
      });
      const font = vi.spyOn(context, "font", "set");

      renderSnaps(context, appState);

      const size = Number(
        String(font.mock.calls[0][0]).match(/^([\d.]+)px/)![1],
      );
      // The canvas is already scaled by the zoom, so the font has to shrink by
      // the same factor to come out the same size to the eye.
      sizes.push(size * zoom);
    }

    expect(new Set(sizes).size).toBe(1);
  });

  it("does not label a plain alignment line, which has no distance to report", () => {
    const { context, appState, fillText } = setup({
      snapLines: [
        {
          type: "points",
          points: [
            [10, 10],
            [10, 200],
          ],
        },
      ] as any,
    });

    renderSnaps(context, appState);

    expect(fillText).not.toHaveBeenCalled();
  });
});
