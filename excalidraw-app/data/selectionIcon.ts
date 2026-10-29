import { exportToBlob } from "@excalidraw/excalidraw";

import type {
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";

/**
 * How wide the longest side of a rendered icon should be.
 *
 * An icon is placed at most `ICON_BOX` (256) across and is never scaled up, so
 * rendering at twice that keeps it sharp on a retina screen while staying far
 * inside the 5 MiB the server accepts.
 */
const ICON_RENDER_SIZE = 512;

/**
 * What the icon library would take from the canvas right now.
 *
 * Anything the person has selected and not deleted — a drawn shape, a group,
 * a label, a photograph. It used to be one stored picture and nothing else,
 * which meant something drawn by hand could never become an icon of its own.
 */
export const selectedForIcon = (
  elements: readonly ExcalidrawElement[],
  appState: { selectedElementIds: AppState["selectedElementIds"] },
): readonly NonDeletedExcalidrawElement[] =>
  elements.filter(
    (element): element is NonDeletedExcalidrawElement =>
      !element.isDeleted && Boolean(appState.selectedElementIds[element.id]),
  );

/**
 * Turns whatever is selected on the canvas into an icon's bytes.
 *
 * PNG, not SVG, and deliberately: Excalidraw's SVG carries its fonts and any
 * placed picture inline as `url(data:…)`, and the server refuses an SVG that
 * reaches outside itself — that rule is what stops a hostile icon reading the
 * page it is dropped into. A picture of the selection has no such problem, and
 * it works for every kind of element, text and photographs included.
 */
export const renderSelectionAsIcon = async (
  elements: readonly NonDeletedExcalidrawElement[],
  appState: Readonly<AppState>,
  files: BinaryFiles,
): Promise<string> => {
  const blob = await exportToBlob({
    elements,
    appState: { ...appState, exportBackground: false, exportScale: 1 },
    files,
    mimeType: "image/png",
    exportPadding: 0,
    // The canvas is sized in finished pixels, so the scale has to be in the
    // width and height as well as in `scale` — returning one without the other
    // renders the drawing larger than the canvas and crops it.
    getDimensions: (width, height) => {
      const longest = Math.max(width, height);
      const scale =
        Number.isFinite(longest) && longest > 0
          ? Math.min(3, Math.max(1, ICON_RENDER_SIZE / longest))
          : 1;
      return { width: width * scale, height: height * scale, scale };
    },
  });
  return await blobToDataURL(blob);
};

const blobToDataURL = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    const fail = () =>
      reject(new Error("Could not turn that selection into an icon."));
    reader.onerror = fail;
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string") {
        resolve(result);
      } else {
        fail();
      }
    };
    reader.readAsDataURL(blob);
  });
