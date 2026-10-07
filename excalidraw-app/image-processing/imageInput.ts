/** Detect APNG and animated WebP before the browser silently decodes one frame. */
export const isAnimatedRaster = (bytes: Uint8Array, mimeType: string) => {
  const tag = (offset: number) =>
    String.fromCharCode(...bytes.slice(offset, offset + 4));
  if (mimeType === "image/png") {
    if (bytes.length < 8 || tag(1) !== "PNG\r") {
      return false;
    }
    for (let offset = 8; offset + 12 <= bytes.length; ) {
      const length = new DataView(
        bytes.buffer,
        bytes.byteOffset + offset,
        4,
      ).getUint32(0);
      const name = tag(offset + 4);
      if (name === "acTL") {
        return true;
      }
      if (name === "IDAT" || name === "IEND") {
        return false;
      }
      offset += length + 12;
    }
  }
  if (mimeType === "image/webp" && tag(0) === "RIFF" && tag(8) === "WEBP") {
    for (let offset = 12; offset + 8 <= bytes.length; ) {
      const name = tag(offset);
      const length = new DataView(
        bytes.buffer,
        bytes.byteOffset + offset + 4,
        4,
      ).getUint32(0, true);
      if (
        name === "ANIM" ||
        (name === "VP8X" && !!(bytes[offset + 8] & 0x02))
      ) {
        return true;
      }
      offset += 8 + length + (length % 2);
    }
  }
  return false;
};
