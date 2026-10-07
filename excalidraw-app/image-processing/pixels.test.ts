import { describe, expect, it } from "vitest";

import { parseHexColor, recolorPixels, removeFlatBackground } from "./pixels";

describe("image pixel operations", () => {
  it("recolors RGB without changing transparent or antialiased alpha", () => {
    const source = new Uint8ClampedArray([
      10, 20, 30, 0, 40, 50, 60, 127, 70, 80, 90, 255,
    ]);
    const result = recolorPixels(source, parseHexColor("#12abEF"));
    expect(Array.from(result)).toEqual([
      18, 171, 239, 0, 18, 171, 239, 127, 18, 171, 239, 255,
    ]);
    expect(Array.from(source)).toEqual([
      10, 20, 30, 0, 40, 50, 60, 127, 70, 80, 90, 255,
    ]);
  });

  it("removes only edge-connected background, preserving enclosed matching pixels", () => {
    const colors = ["WWWWW", "WBBBW", "WBWBW", "WBBBW", "WWWWW"];
    const source = new Uint8ClampedArray(
      colors
        .join("")
        .split("")
        .flatMap((color) =>
          color === "W" ? [255, 255, 255, 255] : [0, 0, 0, 255],
        ),
    );
    const result = removeFlatBackground(source, 5, 5, [255, 255, 255], 0);
    expect(result[3]).toBe(0);
    expect(result[(2 * 5 + 2) * 4 + 3]).toBe(255);
    expect(result[(1 * 5 + 1) * 4 + 3]).toBe(255);
  });

  it("validates dimensions and color input", () => {
    expect(() =>
      removeFlatBackground(new Uint8ClampedArray(4), 2, 2, [255, 255, 255], 0),
    ).toThrow();
    expect(() => parseHexColor("red")).toThrow();
  });
});
