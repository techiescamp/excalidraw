import { pointFrom, type GlobalPoint, type LocalPoint } from "@excalidraw/math";

import { THEME } from "@excalidraw/common";

import { roundRect } from "./roundRect";

import type { PointSnapLine, PointerSnapLine } from "../snapping";
import type { InteractiveCanvasAppState } from "../types";

const SNAP_COLOR_LIGHT = "#ff6b6b";
// dark-mode colors are the equivalents of what the former CSS inversion filter
// produced (see `applyDarkModeFilter`)
const SNAP_COLOR_DARK = "#ff9090";
const SNAP_COLOR_DARK_ZEN = "#da5b5b";
const SNAP_WIDTH = 1;
const SNAP_CROSS_SIZE = 2;
// The label reads the same at every zoom, so its sizes are divided by the zoom
// just as the line widths are.
const SNAP_LABEL_FONT_SIZE = 11;
const SNAP_LABEL_PADDING_X = 4;
const SNAP_LABEL_PADDING_Y = 2;
const SNAP_LABEL_OFFSET = 10;
const FONT_FAMILY_LABEL =
  "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

export const renderSnaps = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
) => {
  if (!appState.snapLines.length) {
    return;
  }

  // in zen mode we draw only crosses, so use a different color to keep them
  // visible
  const snapColor =
    appState.theme === THEME.LIGHT
      ? SNAP_COLOR_LIGHT
      : appState.zenModeEnabled
      ? SNAP_COLOR_DARK_ZEN
      : SNAP_COLOR_DARK;
  // in zen mode make the cross more visible since we don't draw the lines
  const snapWidth =
    (appState.zenModeEnabled ? SNAP_WIDTH * 1.5 : SNAP_WIDTH) /
    appState.zoom.value;

  context.save();
  context.translate(appState.scrollX, appState.scrollY);

  for (const snapLine of appState.snapLines) {
    if (snapLine.type === "pointer") {
      context.lineWidth = snapWidth;
      context.strokeStyle = snapColor;

      drawPointerSnapLine(snapLine, context, appState);
    } else if (snapLine.type === "gap") {
      context.lineWidth = snapWidth;
      context.strokeStyle = snapColor;

      drawGapLine(
        snapLine.points[0],
        snapLine.points[1],
        snapLine.direction,
        appState,
        context,
      );

      // The guides show that two gaps match; the number says what they are, so
      // an icon can be placed at a known distance rather than a plausible one.
      drawGapLabel(
        snapLine.points[0],
        snapLine.points[1],
        snapLine.direction,
        appState,
        context,
        snapColor,
      );
    } else if (snapLine.type === "points") {
      context.lineWidth = snapWidth;
      context.strokeStyle = snapColor;
      drawPointsSnapLine(snapLine, context, appState);
    }
  }

  context.restore();
};

const drawPointsSnapLine = (
  pointSnapLine: PointSnapLine,
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
) => {
  if (!appState.zenModeEnabled) {
    const firstPoint = pointSnapLine.points[0];
    const lastPoint = pointSnapLine.points[pointSnapLine.points.length - 1];

    drawLine(firstPoint, lastPoint, context);
  }

  for (const point of pointSnapLine.points) {
    drawCross(point, appState, context);
  }
};

const drawPointerSnapLine = (
  pointerSnapLine: PointerSnapLine,
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
) => {
  drawCross(pointerSnapLine.points[0], appState, context);
  if (!appState.zenModeEnabled) {
    drawLine(pointerSnapLine.points[0], pointerSnapLine.points[1], context);
  }
};

const drawCross = <Point extends LocalPoint | GlobalPoint>(
  [x, y]: Point,
  appState: InteractiveCanvasAppState,
  context: CanvasRenderingContext2D,
) => {
  context.save();
  const size =
    (appState.zenModeEnabled ? SNAP_CROSS_SIZE * 1.5 : SNAP_CROSS_SIZE) /
    appState.zoom.value;
  context.beginPath();

  context.moveTo(x - size, y - size);
  context.lineTo(x + size, y + size);

  context.moveTo(x + size, y - size);
  context.lineTo(x - size, y + size);

  context.stroke();
  context.restore();
};

const drawLine = <Point extends LocalPoint | GlobalPoint>(
  from: Point,
  to: Point,
  context: CanvasRenderingContext2D,
) => {
  context.beginPath();
  context.lineTo(from[0], from[1]);
  context.lineTo(to[0], to[1]);
  context.stroke();
};

const drawGapLine = <Point extends LocalPoint | GlobalPoint>(
  from: Point,
  to: Point,
  direction: "horizontal" | "vertical",
  appState: InteractiveCanvasAppState,
  context: CanvasRenderingContext2D,
) => {
  // a horizontal gap snap line
  // |–––––––||–––––––|
  // ^    ^   ^       ^
  // \    \   \       \
  // (1)  (2) (3)     (4)

  const FULL = 8 / appState.zoom.value;
  const HALF = FULL / 2;
  const QUARTER = FULL / 4;

  if (direction === "horizontal") {
    const halfPoint = [(from[0] + to[0]) / 2, from[1]];
    // (1)
    if (!appState.zenModeEnabled) {
      drawLine(
        pointFrom(from[0], from[1] - FULL),
        pointFrom(from[0], from[1] + FULL),
        context,
      );
    }

    // (3)
    drawLine(
      pointFrom(halfPoint[0] - QUARTER, halfPoint[1] - HALF),
      pointFrom(halfPoint[0] - QUARTER, halfPoint[1] + HALF),
      context,
    );
    drawLine(
      pointFrom(halfPoint[0] + QUARTER, halfPoint[1] - HALF),
      pointFrom(halfPoint[0] + QUARTER, halfPoint[1] + HALF),
      context,
    );

    if (!appState.zenModeEnabled) {
      // (4)
      drawLine(
        pointFrom(to[0], to[1] - FULL),
        pointFrom(to[0], to[1] + FULL),
        context,
      );

      // (2)
      drawLine(from, to, context);
    }
  } else {
    const halfPoint = [from[0], (from[1] + to[1]) / 2];
    // (1)
    if (!appState.zenModeEnabled) {
      drawLine(
        pointFrom(from[0] - FULL, from[1]),
        pointFrom(from[0] + FULL, from[1]),
        context,
      );
    }

    // (3)
    drawLine(
      pointFrom(halfPoint[0] - HALF, halfPoint[1] - QUARTER),
      pointFrom(halfPoint[0] + HALF, halfPoint[1] - QUARTER),
      context,
    );
    drawLine(
      pointFrom(halfPoint[0] - HALF, halfPoint[1] + QUARTER),
      pointFrom(halfPoint[0] + HALF, halfPoint[1] + QUARTER),
      context,
    );

    if (!appState.zenModeEnabled) {
      // (4)
      drawLine(
        pointFrom(to[0] - FULL, to[1]),
        pointFrom(to[0] + FULL, to[1]),
        context,
      );

      // (2)
      drawLine(from, to, context);
    }
  }
};

const drawGapLabel = <Point extends LocalPoint | GlobalPoint>(
  from: Point,
  to: Point,
  direction: "horizontal" | "vertical",
  appState: InteractiveCanvasAppState,
  context: CanvasRenderingContext2D,
  snapColor: string,
) => {
  // Zen mode hides the lines themselves, so it does not want a number either.
  if (appState.zenModeEnabled) {
    return;
  }

  const horizontal = direction === "horizontal";
  const gap = Math.round(
    Math.abs(horizontal ? to[0] - from[0] : to[1] - from[1]),
  );
  // Touching edges are not worth a label, and a sub-pixel one would only be
  // rounding noise.
  if (gap < 1) {
    return;
  }

  const zoom = appState.zoom.value;
  const fontSize = SNAP_LABEL_FONT_SIZE / zoom;
  const paddingX = SNAP_LABEL_PADDING_X / zoom;
  const paddingY = SNAP_LABEL_PADDING_Y / zoom;
  const offset = SNAP_LABEL_OFFSET / zoom;

  context.save();
  context.font = `${fontSize}px ${FONT_FAMILY_LABEL}`;
  context.textAlign = "center";
  context.textBaseline = "middle";

  const text = String(gap);
  const width = context.measureText(text).width + paddingX * 2;
  const height = fontSize + paddingY * 2;
  // Beside the line rather than on it, so the number never sits on top of the
  // guide it is describing.
  const x = horizontal ? (from[0] + to[0]) / 2 : from[0] + offset + width / 2;
  const y = horizontal ? from[1] - offset - height / 2 : (from[1] + to[1]) / 2;

  context.fillStyle = snapColor;
  roundRect(context, x - width / 2, y - height / 2, width, height, 2 / zoom);
  context.fill();

  context.fillStyle = "#ffffff";
  context.fillText(text, x, y);
  context.restore();
};
