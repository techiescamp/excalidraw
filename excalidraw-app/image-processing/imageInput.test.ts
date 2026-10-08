import { describe, expect, it } from "vitest";

import { isAnimatedRaster } from "./imageInput";

const ascii = (text: string) =>
  [...text].map((character) => character.charCodeAt(0));

describe("animated raster detection", () => {
  it("detects APNG animation control before image data", () => {
    const png = new Uint8Array([
      137,
      ...ascii("PNG\r\n\x1a\n"),
      0,
      0,
      0,
      0,
      ...ascii("acTL"),
      0,
      0,
      0,
      0,
    ]);
    expect(isAnimatedRaster(png, "image/png")).toBe(true);
    expect(isAnimatedRaster(png, "image/jpeg")).toBe(false);
  });

  it("detects WebP animation flag", () => {
    const webp = new Uint8Array([
      ...ascii("RIFF"),
      0,
      0,
      0,
      0,
      ...ascii("WEBPVP8X"),
      1,
      0,
      0,
      0,
      2,
      0,
    ]);
    expect(isAnimatedRaster(webp, "image/webp")).toBe(true);
    webp[20] = 0;
    expect(isAnimatedRaster(webp, "image/webp")).toBe(false);
  });
});
