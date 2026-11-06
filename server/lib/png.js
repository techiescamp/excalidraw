import zlib from "node:zlib";

// Just enough PNG to cut an icon out of a picture and put it back. The server
// has no image library and does not need one: reading and writing a PNG is a
// zlib stream and a handful of chunk headers. Everything here works on 8-bit
// images and refuses anything else by name rather than producing a wrong
// result quietly.

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_PIXELS = 40_000_000; // a 6000 x 6000 picture, well past anything sane

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const unfilter = (raw, width, height, channels) => {
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let at = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[at];
    at += 1;
    const line = raw.subarray(at, at + stride);
    at += stride;
    const row = out.subarray(y * stride, (y + 1) * stride);
    const prior = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? row[i - channels] : 0;
      const up = prior ? prior[i] : 0;
      const upLeft = prior && i >= channels ? prior[i - channels] : 0;
      let value = line[i];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const dl = Math.abs(p - left);
        const du = Math.abs(p - up);
        const dul = Math.abs(p - upLeft);
        value += dl <= du && dl <= dul ? left : du <= dul ? up : upLeft;
      } else if (filter !== 0) {
        throw new Error(`This PNG uses filter ${filter}, which is not valid.`);
      }
      row[i] = value & 0xff;
    }
  }
  return out;
};

/** A PNG in, straight 8-bit RGBA out. */
export function readPng(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.subarray(0, 8).equals(SIGNATURE))
    throw new Error("That file is not a PNG.");
  let at = 8;
  let header = null;
  let palette = null;
  let alphas = null;
  const parts = [];
  while (at + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.toString("ascii", at + 4, at + 8);
    const body = buffer.subarray(at + 8, at + 8 + length);
    at += 12 + length;
    if (type === "IHDR") {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        depth: body[8],
        colour: body[9],
        interlace: body[12],
      };
    } else if (type === "PLTE") palette = Buffer.from(body);
    else if (type === "tRNS") alphas = Buffer.from(body);
    else if (type === "IDAT") parts.push(Buffer.from(body));
    else if (type === "IEND") break;
  }
  if (!header) throw new Error("That PNG has no header.");
  const { width, height, depth, colour, interlace } = header;
  if (interlace)
    throw new Error("That PNG is interlaced, which this cannot read.");
  if (depth !== 8)
    throw new Error(`That PNG is ${depth}-bit; only 8-bit is read here.`);
  if (width <= 0 || height <= 0 || width * height > MAX_PIXELS)
    throw new Error("That PNG's size is out of range.");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colour];
  if (!channels) throw new Error(`That PNG's colour type ${colour} is unknown.`);
  const raw = unfilter(
    zlib.inflateSync(Buffer.concat(parts)),
    width,
    height,
    channels,
  );
  const pixels = Buffer.alloc(width * height * 4, 255);
  for (let i = 0; i < width * height; i += 1) {
    const from = i * channels;
    const to = i * 4;
    if (colour === 6) {
      raw.copy(pixels, to, from, from + 4);
    } else if (colour === 2) {
      raw.copy(pixels, to, from, from + 3);
    } else if (colour === 0) {
      pixels[to] = pixels[to + 1] = pixels[to + 2] = raw[from];
    } else if (colour === 4) {
      pixels[to] = pixels[to + 1] = pixels[to + 2] = raw[from];
      pixels[to + 3] = raw[from + 1];
    } else {
      const index = raw[from];
      if (!palette || index * 3 + 2 >= palette.length)
        throw new Error("That PNG's palette is incomplete.");
      pixels[to] = palette[index * 3];
      pixels[to + 1] = palette[index * 3 + 1];
      pixels[to + 2] = palette[index * 3 + 2];
      pixels[to + 3] = alphas && index < alphas.length ? alphas[index] : 255;
    }
  }
  return { width, height, pixels };
}

const chunk = (type, body) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "ascii");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, tail]);
};

/** 8-bit RGBA in, a PNG out. Every row is written unfiltered. */
export function writePng({ width, height, pixels }) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
