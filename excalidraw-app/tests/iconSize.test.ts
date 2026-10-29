import { describe, expect, it } from "vitest";

import { ICON_BOX, fitIconSize } from "../data/iconSize";

describe("fitIconSize", () => {
  it("keeps proportions when it shrinks a large icon", () => {
    const { width, height } = fitIconSize({ width: 660, height: 400 });
    expect(Math.max(width, height)).toBe(ICON_BOX);
    expect(width / height).toBeCloseTo(660 / 400, 5);
  });

  it("keeps proportions on a wide icon", () => {
    // A 4:1 banner used to come out square, visibly squashed.
    const { width, height } = fitIconSize({ width: 800, height: 200 });
    expect(width).toBe(ICON_BOX);
    expect(width / height).toBeCloseTo(4, 5);
  });

  it("leaves an icon smaller than the box at its own size", () => {
    // Blowing a 48px logo up to fill the box is what made icons look soft.
    // It has 48px of detail either way; stretching only adds blur.
    expect(fitIconSize({ width: 48, height: 48 })).toEqual({
      width: 48,
      height: 48,
    });
  });

  it("never scales a small non-square icon up either", () => {
    expect(fitIconSize({ width: 120, height: 30 })).toEqual({
      width: 120,
      height: 30,
    });
  });

  it("uses the box exactly when the icon is already that size", () => {
    expect(fitIconSize({ width: ICON_BOX, height: ICON_BOX })).toEqual({
      width: ICON_BOX,
      height: ICON_BOX,
    });
  });

  it("falls back to a square when the icon could not be measured", () => {
    for (const natural of [
      { width: 0, height: 0 },
      { width: Number.NaN, height: Number.NaN },
    ]) {
      expect(fitIconSize(natural)).toEqual({
        width: ICON_BOX,
        height: ICON_BOX,
      });
    }
  });
});
