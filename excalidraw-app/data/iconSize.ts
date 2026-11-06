/**
 * How big an icon lands on the canvas.
 *
 * Two rules, and the second one is the one that matters for how the icon
 * looks: fit it inside a box so icons sit at a consistent size next to each
 * other, and never scale it up past the pixels it actually has. Stretching a
 * 48px logo to fill a 256px box does not give you a bigger logo, it gives you
 * a blurry one, and no amount of rendering afterwards puts the detail back.
 *
 * The box is in scene units, not screen pixels, so two icons dropped at
 * different zoom levels still match each other on the canvas.
 */
export const ICON_BOX = 256;

export const fitIconSize = (
  natural: { width: number; height: number },
  box: number = ICON_BOX,
): { width: number; height: number } => {
  const longest = Math.max(natural.width, natural.height);
  // An image we could not measure — an SVG with no intrinsic size, or one that
  // failed to decode. A square at the box size is as good a guess as any.
  if (!Number.isFinite(longest) || longest <= 0) {
    return { width: box, height: box };
  }
  const scale = Math.min(1, box / longest);
  return { width: natural.width * scale, height: natural.height * scale };
};
