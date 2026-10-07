export type RGB = readonly [number, number, number];

export const parseHexColor = (value: string): RGB => {
  if (!/^#[\da-f]{6}$/i.test(value)) {
    throw new Error("Choose a six-digit color.");
  }
  return [1, 3, 5].map((index) =>
    parseInt(value.slice(index, index + 2), 16),
  ) as unknown as RGB;
};

export const recolorPixels = (source: Uint8ClampedArray, color: RGB) => {
  const result = new Uint8ClampedArray(source);
  for (let index = 0; index < result.length; index += 4) {
    result[index] = color[0];
    result[index + 1] = color[1];
    result[index + 2] = color[2];
  }
  return result;
};

/** Remove only background-colored pixels connected to an image edge. */
export const removeFlatBackground = (
  source: Uint8ClampedArray,
  width: number,
  height: number,
  color: RGB,
  tolerance: number,
) => {
  if (
    source.length !== width * height * 4 ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error("Invalid image dimensions.");
  }
  const result = new Uint8ClampedArray(source);
  const seen = new Uint8Array(width * height);
  const queue = new Uint32Array(width * height);
  let tail = 0;
  let head = 0;
  const threshold = Math.max(0, Math.min(100, tolerance)) * 4.42;
  const enqueue = (pixel: number) => {
    if (seen[pixel]) {
      return;
    }
    seen[pixel] = 1;
    const offset = pixel * 4;
    const distance = Math.hypot(
      source[offset] - color[0],
      source[offset + 1] - color[1],
      source[offset + 2] - color[2],
    );
    if (distance <= threshold) {
      queue[tail++] = pixel;
    }
  };
  for (let x = 0; x < width; x++) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    enqueue(y * width);
    enqueue(y * width + width - 1);
  }
  while (head < tail) {
    const pixel = queue[head++];
    result[pixel * 4 + 3] = 0;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    if (x > 0) {
      enqueue(pixel - 1);
    }
    if (x + 1 < width) {
      enqueue(pixel + 1);
    }
    if (y > 0) {
      enqueue(pixel - width);
    }
    if (y + 1 < height) {
      enqueue(pixel + width);
    }
  }
  return result;
};
