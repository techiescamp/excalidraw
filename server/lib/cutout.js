import { readPng, writePng } from "./png.js";

// Taking an icon out of a picture somebody sent. The editor already does this
// in the browser for a person with a mouse; this is the same idea for an
// assistant copying a reference: cut the region out, drop the flat background
// behind it, trim what is left, and say honestly how well it worked.
//
// The removal is a flood fill inwards from the edges, which is what suits a
// diagram: the background is one flat colour and the artwork never touches it.
// A photograph is a different problem and this does not pretend to solve it.

const MAX_SIDE = 2000;

const at = (pixels, index) => [
  pixels[index * 4],
  pixels[index * 4 + 1],
  pixels[index * 4 + 2],
];
const apart = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** The colour the four corners agree on, which is the page behind the icon. */
const backgroundOf = ({ width, height, pixels }) => {
  const corners = [
    0,
    width - 1,
    (height - 1) * width,
    height * width - 1,
  ].map((index) => at(pixels, index));
  const counts = corners.map(
    (corner) => corners.filter((other) => apart(corner, other) <= 12).length,
  );
  return corners[counts.indexOf(Math.max(...counts))];
};

const crop = ({ width, height, pixels }, box) => {
  const x = Math.max(0, Math.min(width - 1, Math.round(box.x)));
  const y = Math.max(0, Math.min(height - 1, Math.round(box.y)));
  const w = Math.max(1, Math.min(width - x, Math.round(box.w)));
  const h = Math.max(1, Math.min(height - y, Math.round(box.h)));
  const out = Buffer.alloc(w * h * 4);
  for (let row = 0; row < h; row += 1)
    pixels.copy(
      out,
      row * w * 4,
      ((y + row) * width + x) * 4,
      ((y + row) * width + x + w) * 4,
    );
  return { width: w, height: h, pixels: out };
};

/** Clear every background-coloured pixel joined to an edge. */
const clearBackground = ({ width, height, pixels }, colour, tolerance) => {
  const out = Buffer.from(pixels);
  const seen = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  const limit = Math.max(0, Math.min(100, tolerance)) * 4.42;
  let head = 0;
  let tail = 0;
  const consider = (pixel) => {
    if (seen[pixel]) return;
    seen[pixel] = 1;
    if (apart(at(pixels, pixel), colour) <= limit) queue[tail++] = pixel;
  };
  for (let x = 0; x < width; x += 1) {
    consider(x);
    consider((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    consider(y * width);
    consider(y * width + width - 1);
  }
  let cleared = 0;
  while (head < tail) {
    const pixel = queue[head++];
    out[pixel * 4 + 3] = 0;
    cleared += 1;
    const x = pixel % width;
    const y = (pixel - x) / width;
    if (x > 0) consider(pixel - 1);
    if (x + 1 < width) consider(pixel + 1);
    if (y > 0) consider(pixel - width);
    if (y + 1 < height) consider(pixel + width);
  }
  return { picture: { width, height, pixels: out }, cleared };
};

/** Cut away fully transparent margins so the icon sits tight in its box. */
const trim = ({ width, height, pixels }) => {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1)
      if (pixels[(y * width + x) * 4 + 3] !== 0) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
  if (right < 0) return null;
  return crop(
    { width, height, pixels },
    { x: left, y: top, w: right - left + 1, h: bottom - top + 1 },
  );
};

/**
 * Cut one icon out of a picture.
 *
 * Returns the PNG and a plain account of what happened, because an icon with
 * a grey rectangle still behind it is worse than no icon: the caller is told
 * whether the edges came out clear and how much was removed, and can refuse it.
 */
export function cutIcon(
  file,
  { x, y, w, h },
  { tolerance = 12, background = null } = {},
) {
  const picture = readPng(file);
  const cut = crop(picture, { x, y, w, h });
  if (cut.width > MAX_SIDE || cut.height > MAX_SIDE)
    throw new Error(`Cut a region no larger than ${MAX_SIDE}px on a side.`);
  const colour = background || backgroundOf(cut);
  const { picture: cleaned, cleared } = clearBackground(
    cut,
    colour,
    tolerance,
  );
  const tight = trim(cleaned);
  if (!tight)
    throw new Error(
      "Everything in that region was background; nothing was left to keep.",
    );

  // Did it actually work? The border of what is kept should be transparent all
  // the way round, and something should be left in the middle.
  const { width, height, pixels } = tight;
  let edge = 0;
  let solidEdge = 0;
  const check = (pixel) => {
    edge += 1;
    if (pixels[pixel * 4 + 3] !== 0) solidEdge += 1;
  };
  for (let px = 0; px < width; px += 1) {
    check(px);
    check((height - 1) * width + px);
  }
  for (let py = 0; py < height; py += 1) {
    check(py * width);
    check(py * width + width - 1);
  }
  let kept = 0;
  for (let i = 0; i < width * height; i += 1)
    if (pixels[i * 4 + 3] !== 0) kept += 1;

  return {
    png: writePng(tight),
    width,
    height,
    background: `#${colour
      .map((part) => part.toString(16).padStart(2, "0"))
      .join("")}`,
    // Share of the cut region the background took up.
    removed: Math.round((cleared / (cut.width * cut.height)) * 100),
    // Share of the trimmed icon that is actual artwork.
    kept: Math.round((kept / (width * height)) * 100),
    // A clean cut leaves nothing solid around the rim. Corners of a round icon
    // can brush it, so a little is allowed and the number is reported either
    // way rather than hidden behind a yes or no.
    edge_solid: Math.round((solidEdge / Math.max(1, edge)) * 100),
  };
}
