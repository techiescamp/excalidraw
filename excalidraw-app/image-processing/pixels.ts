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

/** Replace only edge-connected background pixels with a chosen color. */
export const replaceFlatBackground = (
  source: Uint8ClampedArray,
  width: number,
  height: number,
  background: RGB,
  replacement: RGB,
  tolerance: number,
) => {
  const result = new Uint8ClampedArray(source);
  const transparent = removeFlatBackground(
    source,
    width,
    height,
    background,
    tolerance,
  );
  for (let index = 0; index < result.length; index += 4) {
    if (transparent[index + 3] === 0) {
      result[index] = replacement[0];
      result[index + 1] = replacement[1];
      result[index + 2] = replacement[2];
    }
  }
  return result;
};

/** Extract artwork from a sheet of separate, solid-color icon tiles. */
export const removeIconSheetBackground = (
  source: Uint8ClampedArray,
  width: number,
  height: number,
) => {
  const withoutPage = removeFlatBackground(
    source,
    width,
    height,
    [255, 255, 255],
    12,
  );
  const visited = new Uint8Array(width * height);
  const queue = new Uint32Array(width * height);
  const result = new Uint8ClampedArray(source);
  for (let pixel = 0; pixel < width * height; pixel++) {
    result[pixel * 4 + 3] = 0;
  }

  const colorAt = (x: number, y: number): RGB => {
    const offset = (y * width + x) * 4;
    return [source[offset], source[offset + 1], source[offset + 2]];
  };
  const distance = (a: RGB, b: RGB) =>
    Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  for (let start = 0; start < visited.length; start++) {
    if (visited[start] || !withoutPage[start * 4 + 3]) {
      continue;
    }
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    while (head < tail) {
      const pixel = queue[head++];
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      const neighbors = [
        x > 0 ? pixel - 1 : -1,
        x + 1 < width ? pixel + 1 : -1,
        y > 0 ? pixel - width : -1,
        y + 1 < height ? pixel + width : -1,
      ];
      for (const next of neighbors) {
        if (next < 0 || visited[next] || !withoutPage[next * 4 + 3]) {
          continue;
        }
        visited[next] = 1;
        queue[tail++] = next;
      }
    }
    const tileWidth = maxX - minX + 1;
    const tileHeight = maxY - minY + 1;
    if (tail < 500 || tileWidth < 30 || tileHeight < 30) {
      continue;
    }
    const insetX = Math.max(5, Math.round(tileWidth * 0.12));
    const insetY = Math.max(5, Math.round(tileHeight * 0.12));
    const backgrounds: RGB[] = [
      colorAt(minX + insetX, minY + insetY),
      colorAt(maxX - insetX, minY + insetY),
      colorAt(minX + insetX, maxY - insetY),
      colorAt(maxX - insetX, maxY - insetY),
    ];

    for (let y = minY + 5; y <= maxY - 5; y++) {
      for (let x = minX + 5; x <= maxX - 5; x++) {
        const pixel = y * width + x;
        if (!withoutPage[pixel * 4 + 3]) {
          continue;
        }
        const color = colorAt(x, y);
        const difference = Math.min(
          ...backgrounds.map((background) => distance(color, background)),
        );
        const alpha = Math.max(0, Math.min(255, (difference - 28) * 12));
        result[pixel * 4 + 3] = Math.min(source[pixel * 4 + 3], alpha);
      }
    }
  }
  return result;
};
