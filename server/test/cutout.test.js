import test from "node:test";
import assert from "node:assert/strict";
import { readPng, writePng } from "../lib/png.js";
import { cutIcon } from "../lib/cutout.js";

// A picture with a flat page behind it and one solid shape sitting on the
// page, which is what a diagram is.
const picture = ({
  width = 120,
  height = 120,
  page = [240, 240, 240],
  shape = [80, 40, 200],
  box = { x: 40, y: 40, w: 40, h: 40 },
} = {}) => {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const inside =
        x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
      const colour = inside ? shape : page;
      const at = (y * width + x) * 4;
      pixels[at] = colour[0];
      pixels[at + 1] = colour[1];
      pixels[at + 2] = colour[2];
      pixels[at + 3] = 255;
    }
  return writePng({ width, height, pixels });
};

test("reading and writing a PNG", async (t) => {
  await t.test("a picture survives the round trip", () => {
    const file = picture();
    const read = readPng(file);
    assert.equal(read.width, 120);
    assert.equal(read.height, 120);
    // The shape is where it was put, and the page is around it.
    const at = (x, y) => [...read.pixels.subarray((y * 120 + x) * 4, (y * 120 + x) * 4 + 4)];
    assert.deepEqual(at(50, 50), [80, 40, 200, 255]);
    assert.deepEqual(at(5, 5), [240, 240, 240, 255]);
    assert.deepEqual(readPng(writePng(read)).pixels, read.pixels);
  });

  await t.test("anything it cannot read is named, not guessed at", () => {
    assert.throws(() => readPng(Buffer.from("not a png")), /not a PNG/);
  });
});

test("cutting an icon out of a picture", async (t) => {
  await t.test("the page comes away and the artwork is kept", () => {
    const cut = cutIcon(picture(), { x: 20, y: 20, w: 80, h: 80 });
    // Trimmed to the shape itself, not to the rectangle that was asked for.
    assert.equal(cut.width, 40);
    assert.equal(cut.height, 40);
    assert.equal(cut.background, "#f0f0f0");
    assert.equal(cut.kept, 100, "what is left is all artwork");
    assert.equal(cut.leftover, 0, "none of the page is still in it");
    // The page around it is gone.
    assert.ok(cut.removed > 50, `most of the rectangle was page: ${cut.removed}`);
    const art = readPng(cut.png);
    assert.equal(art.width, 40);
    assert.deepEqual(
      [...art.pixels.subarray(0, 4)],
      [80, 40, 200, 255],
      "the first pixel is the shape, not the page",
    );
  });

  await t.test("a rim that will not come away is reported, not hidden", () => {
    // Told the wrong background colour, nothing matches and nothing is
    // removed. The icon still comes back, with the numbers saying plainly
    // that the page is still behind it.
    const cut = cutIcon(
      picture(),
      { x: 0, y: 0, w: 120, h: 120 },
      { background: [10, 200, 10] },
    );
    assert.equal(cut.removed, 0, "none of the page came away");
    assert.equal(
      cut.leftover,
      89,
      "and the caller is told the page is still in it",
    );
    assert.equal(cut.width, 120, "nothing could be trimmed");
  });

  await t.test("the background colour can be given rather than guessed", () => {
    const cut = cutIcon(
      picture(),
      { x: 0, y: 0, w: 120, h: 120 },
      { background: [240, 240, 240] },
    );
    assert.equal(cut.background, "#f0f0f0");
    assert.equal(cut.width, 40);
  });

  await t.test("a region that is all background is refused", () => {
    assert.throws(
      () => cutIcon(picture(), { x: 0, y: 0, w: 20, h: 20 }),
      /nothing was left/,
    );
  });

  await t.test("the page showing through a gap is cleared too", () => {
    // A ring: artwork with the page trapped in the middle of it. A flood fill
    // from the edges cannot reach that middle, and the icon used to come back
    // with a disc of the old page inside it.
    const width = 60;
    const height = 60;
    const pixels = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1) {
        const away = Math.hypot(x - 30, y - 30);
        const ring = away >= 12 && away < 22;
        const at = (y * width + x) * 4;
        pixels[at] = ring ? 20 : 250;
        pixels[at + 1] = ring ? 20 : 250;
        pixels[at + 2] = ring ? 200 : 250;
        pixels[at + 3] = 255;
      }
    const cut = cutIcon(writePng({ width, height, pixels }), null, {
      tolerance: 12,
    });
    assert.equal(cut.leftover, 0, "the middle of the ring came away as well");
    const art = readPng(cut.png);
    assert.equal(
      art.pixels[(Math.floor(art.height / 2) * art.width +
        Math.floor(art.width / 2)) *
        4 +
        3],
      0,
      "the middle of the icon is transparent",
    );
  });

  await t.test("what runs off the edge of the crop can be thrown away", () => {
    // A shape in the middle with a caption line crossing the top of the crop.
    const width = 100;
    const height = 100;
    const pixels = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1) {
        const shape = x >= 35 && x < 65 && y >= 40 && y < 70;
        const caption = y >= 5 && y < 12;
        const at = (y * width + x) * 4;
        const ink = shape || caption;
        pixels[at] = ink ? 30 : 250;
        pixels[at + 1] = ink ? 30 : 250;
        pixels[at + 2] = ink ? 30 : 250;
        pixels[at + 3] = 255;
      }
    const file = writePng({ width, height, pixels });
    const loose = cutIcon(file, null, { tolerance: 12 });
    assert.equal(loose.height, 65, "the caption is kept and stretches it");
    const clean = cutIcon(file, null, { tolerance: 12, drop_edges: true });
    assert.equal(clean.width, 30, "only the shape is left");
    assert.equal(clean.height, 30);
  });

  await t.test("only the logo is kept when that is what was asked", () => {
    // A shape with a stray mark beside it, not joined to it.
    const width = 100;
    const height = 60;
    const pixels = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1) {
        const logo = x >= 10 && x < 50 && y >= 15 && y < 45;
        const speck = x >= 70 && x < 78 && y >= 28 && y < 32;
        const at = (y * width + x) * 4;
        const ink = logo || speck;
        pixels[at] = ink ? 30 : 250;
        pixels[at + 1] = ink ? 30 : 250;
        pixels[at + 2] = ink ? 30 : 250;
        pixels[at + 3] = 255;
      }
    const file = writePng({ width, height, pixels });
    const both = cutIcon(file, null, { tolerance: 12 });
    assert.equal(both.width, 68, "the stray mark stretches the box");
    const logo = cutIcon(file, null, { tolerance: 12, keep: "main" });
    assert.equal(logo.width, 40, "only the logo is left");
    assert.equal(logo.height, 30);
    assert.equal(logo.kept, 100);
  });

  await t.test("a crop outside the picture is pulled back inside it", () => {
    const cut = cutIcon(picture(), { x: -50, y: -50, w: 400, h: 400 });
    assert.equal(cut.width, 40, "it still finds the shape");
  });
});
