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

/**
 * The page colour, however the caller wrote it.
 *
 * Everything in here works on [r, g, b], but a colour is written `#ffffff`
 * everywhere else in these tools and that is what a caller passes. Handed the
 * string, the old code compared a number against `"#"`, got NaN, quietly
 * removed nothing at all, and then fell over on `colour.map` at the very end.
 * So both forms are read here, and anything else is refused by name rather
 * than failing somewhere further on.
 */
const rgbOf = (value) => {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    if (value.length !== 3 || value.some((part) => !Number.isFinite(part)))
      throw new Error(
        "A background colour given as a list must be three numbers: red, green and blue.",
      );
    return value.map((part) => Math.max(0, Math.min(255, Math.round(part))));
  }
  const text = String(value).trim().replace(/^#/, "");
  // Both the long form and the three-letter shorthand a person types.
  const full =
    text.length === 3
      ? text
          .split("")
          .map((part) => part + part)
          .join("")
      : text;
  if (!/^[0-9a-fA-F]{6}$/.test(full))
    throw new Error(
      `"${value}" is not a colour. Write it as #rrggbb, or leave it out and the corners are read instead.`,
    );
  return [0, 2, 4].map((start) => parseInt(full.slice(start, start + 2), 16));
};

/** The colour the four corners agree on, which is the page behind the icon. */
const backgroundOf = ({ width, height, pixels }) => {
  const corners = [0, width - 1, (height - 1) * width, height * width - 1].map(
    (index) => at(pixels, index),
  );
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
const clearEdgeBackground = ({ width, height, pixels }, colour, tolerance) => {
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

/**
 * Clear what the flood fill could not reach.
 *
 * A flood fill from the edges only takes background that is joined to an edge.
 * The page showing through a gap in the artwork — between a brain and the rays
 * around it, inside the bowl of a letter — is walled in, so it survives, and
 * the icon comes back with patches of the old page still in it. Those patches
 * are cleared too, at a tighter tolerance than the fill used: close enough to
 * the page colour and it is the page, further away and it is artwork that
 * merely resembles it.
 */
const clearTrappedBackground = (
  { width, height, pixels },
  colour,
  tolerance,
) => {
  const out = Buffer.from(pixels);
  const limit = Math.max(0, Math.min(100, tolerance)) * 4.42 * 0.6;
  let cleared = 0;
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    if (out[pixel * 4 + 3] === 0) continue;
    if (apart(at(pixels, pixel), colour) <= limit) {
      out[pixel * 4 + 3] = 0;
      cleared += 1;
    }
  }
  return { picture: { width, height, pixels: out }, cleared };
};

/**
 * Drop whatever runs off the edge of the crop.
 *
 * A rectangle drawn roughly around an icon catches the neighbours: a line of
 * the caption above, the border of the panel below. Those pieces run off the
 * edge of the crop; the icon itself, and the rays or dots around it, sit
 * wholly inside. So anything that touches the rim goes, and what is left is
 * the icon. Only worth asking for when the crop has room around the icon —
 * with a tight crop the artwork touches the rim itself.
 */
const dropWhatLeavesTheFrame = ({ width, height, pixels }) => {
  const out = Buffer.from(pixels);
  const seen = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  for (let start = 0; start < width * height; start += 1) {
    if (seen[start] || out[start * 4 + 3] === 0) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    let touches = false;
    const piece = [];
    while (head < tail) {
      const pixel = queue[head++];
      piece.push(pixel);
      const x = pixel % width;
      const y = (pixel - x) / width;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1)
        touches = true;
      for (const next of [
        x > 0 ? pixel - 1 : -1,
        x + 1 < width ? pixel + 1 : -1,
        y > 0 ? pixel - width : -1,
        y + 1 < height ? pixel + width : -1,
      ]) {
        if (next < 0 || seen[next] || out[next * 4 + 3] === 0) continue;
        seen[next] = 1;
        queue[tail++] = next;
      }
    }
    if (touches) for (const pixel of piece) out[pixel * 4 + 3] = 0;
  }
  return { width, height, pixels: out };
};

/**
 * Keep the main piece and drop the rest.
 *
 * Asked for a logo, a logo is what should come back — not the logo and the
 * stray tick beside it and the end of a line. The largest joined piece is the
 * logo; anything that is not joined to it goes. A logo genuinely made of
 * separate parts loses them this way, which is why it is a choice and not the
 * rule.
 */
const keepMainPiece = ({ width, height, pixels }) => {
  const seen = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let best = null;
  for (let start = 0; start < width * height; start += 1) {
    if (seen[start] || pixels[start * 4 + 3] === 0) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    const piece = [];
    while (head < tail) {
      const pixel = queue[head++];
      piece.push(pixel);
      const x = pixel % width;
      const y = (pixel - x) / width;
      for (const next of [
        x > 0 ? pixel - 1 : -1,
        x + 1 < width ? pixel + 1 : -1,
        y > 0 ? pixel - width : -1,
        y + 1 < height ? pixel + width : -1,
      ]) {
        if (next < 0 || seen[next] || pixels[next * 4 + 3] === 0) continue;
        seen[next] = 1;
        queue[tail++] = next;
      }
    }
    if (!best || piece.length > best.length) best = piece;
  }
  if (!best) return { width, height, pixels };
  const out = Buffer.alloc(width * height * 4);
  for (const pixel of best)
    pixels.copy(out, pixel * 4, pixel * 4, pixel * 4 + 4);
  return { width, height, pixels: out };
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
  box,
  { tolerance = 12, background = null, drop_edges = false, keep = "all" } = {},
) {
  const picture = readPng(file);
  // No rectangle means the picture is already cropped to the icon, which is
  // how a person does it: crop first, then take the background off that.
  const cut = box ? crop(picture, box) : picture;
  if (cut.width > MAX_SIDE || cut.height > MAX_SIDE)
    throw new Error(`Cut a region no larger than ${MAX_SIDE}px on a side.`);
  // What the corners say the page is, worked out whatever the caller passed.
  // The check at the end measures against this rather than against the colour
  // used for the removal: told the wrong colour, the removal does nothing and
  // a check against that same wrong colour would cheerfully report success.
  const page = backgroundOf(cut);
  const colour = rgbOf(background) || page;
  const edged = clearEdgeBackground(cut, colour, tolerance);
  const trapped = clearTrappedBackground(edged.picture, colour, tolerance);
  const cleared = edged.cleared + trapped.cleared;
  let standing = trapped.picture;
  if (drop_edges) standing = dropWhatLeavesTheFrame(standing);
  if (keep === "main") standing = keepMainPiece(standing);
  const tight = trim(standing);
  if (!tight)
    throw new Error(
      drop_edges
        ? "Nothing was left: every piece in that region ran off the edge of it. Give the icon more room around it, or turn drop_edges off."
        : "Everything in that region was background; nothing was left to keep.",
    );

  // Did it actually work? Not "is the rim clear" — a tight crop is meant to
  // have artwork at its rim, and judging it that way called a good cut bad.
  // The honest question is whether any of the old page is still in the icon.
  const { width, height, pixels } = tight;
  const limit = Math.max(0, Math.min(100, tolerance)) * 4.42;
  let kept = 0;
  let stillPage = 0;
  for (let i = 0; i < width * height; i += 1) {
    if (pixels[i * 4 + 3] === 0) continue;
    kept += 1;
    if (apart(at(pixels, i), page) <= limit) stillPage += 1;
  }

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
    // Share of what was kept that is still the old page colour. A clean cut is
    // zero. Anything above a per cent or two means the page is still showing
    // through the icon somewhere, and the number is reported either way rather
    // than hidden behind a yes or no.
    leftover: Math.round((stillPage / Math.max(1, kept)) * 100),
  };
}
