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
    assert.equal(cut.edge_solid, 100, "a square icon fills its own rim");
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
    assert.equal(cut.edge_solid, 100, "the caller is told the rim is solid");
    assert.equal(cut.width, 120, "and nothing could be trimmed");
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

  await t.test("a crop outside the picture is pulled back inside it", () => {
    const cut = cutIcon(picture(), { x: -50, y: -50, w: 400, h: 400 });
    assert.equal(cut.width, 40, "it still finds the shape");
  });
});
