import { useEffect, useRef, useState } from "react";

import { isAnimatedRaster } from "./imageInput";
import {
  parseHexColor,
  recolorPixels,
  removeFlatBackground,
  removeIconSheetBackground,
  replaceFlatBackground,
} from "./pixels";

type Operation =
  | "recolor"
  | "flat-background"
  | "background-color"
  | "icon-sheet"
  | "ai-background";

export const ImageProcessingDialog = ({
  operation,
  source,
  onApply,
  onClose,
}: {
  operation: Operation;
  source: string;
  onApply: (dataURL: string) => void;
  onClose: () => void;
}) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef(0);
  const [color, setColor] = useState("#ffffff");
  const [tolerance, setTolerance] = useState(12);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const document = dialogRef.current?.ownerDocument;
    const requestToken = requestRef;
    const previousFocus = document?.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => {
      requestToken.current++;
      previousFocus?.focus();
    };
  }, []);

  useEffect(() => {
    setPreview(null);
    setError("");
  }, [color, tolerance, operation, source]);

  const process = () => {
    const request = ++requestRef.current;
    const document = dialogRef.current?.ownerDocument;
    const ownerWindow = document?.defaultView;
    if (!document || !ownerWindow) {
      setError("The image editor is unavailable.");
      return;
    }
    try {
      const [header, payload] = source.split(",", 2);
      if (
        !header.endsWith(";base64") ||
        !payload ||
        source.length > 14_000_000
      ) {
        throw new Error("This image format or size is unsupported.");
      }
      const binary = ownerWindow.atob(payload);
      const bytes = Uint8Array.from(binary, (character) =>
        character.charCodeAt(0),
      );
      if (isAnimatedRaster(bytes, header.slice(5).split(";")[0])) {
        throw new Error("Animated images are not supported.");
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The image cannot be read.",
      );
      return;
    }
    setBusy(true);
    setError("");
    if (operation === "ai-background") {
      void processWithAI(requestRef.current);
      return;
    }
    // Allow the progress message to paint before decoding and pixel processing.
    ownerWindow.setTimeout(() => {
      const image = new ownerWindow.Image();
      image.onload = () => {
        if (request !== requestRef.current) {
          return;
        }
        try {
          if (image.naturalWidth * image.naturalHeight > 4_000_000) {
            throw new Error("Images over 4 megapixels are not supported yet.");
          }
          const canvas = document.createElement("canvas");
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const context = canvas.getContext("2d", { willReadFrequently: true });
          if (!context) {
            throw new Error("Canvas is unavailable.");
          }
          context.drawImage(image, 0, 0);
          const pixels = context.getImageData(
            0,
            0,
            canvas.width,
            canvas.height,
          );
          const rgb = parseHexColor(color);
          pixels.data.set(
            operation === "recolor"
              ? recolorPixels(pixels.data, rgb)
              : operation === "icon-sheet"
              ? removeIconSheetBackground(
                  pixels.data,
                  canvas.width,
                  canvas.height,
                )
              : operation === "background-color"
              ? replaceFlatBackground(
                  pixels.data,
                  canvas.width,
                  canvas.height,
                  [255, 255, 255],
                  rgb,
                  tolerance,
                )
              : removeFlatBackground(
                  pixels.data,
                  canvas.width,
                  canvas.height,
                  rgb,
                  tolerance,
                ),
          );
          context.putImageData(pixels, 0, 0);
          const dataURL = canvas.toDataURL("image/png");
          if (dataURL.length * 0.75 > 4 * 1024 * 1024) {
            throw new Error(
              "The output PNG exceeds the 4 MiB image storage limit.",
            );
          }
          if (request === requestRef.current) {
            setPreview(dataURL);
          }
        } catch (cause) {
          if (request === requestRef.current) {
            setError(
              cause instanceof Error
                ? cause.message
                : "Image processing failed.",
            );
          }
        } finally {
          if (request === requestRef.current) {
            setBusy(false);
          }
        }
      };
      image.onerror = () => {
        if (request === requestRef.current) {
          setError("The source image could not be decoded.");
          setBusy(false);
        }
      };
      image.src = source;
    }, 0);
  };

  const processWithAI = async (request: number) => {
    try {
      const moduleUrl: string =
        "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2/+esm";
      const { pipeline } = await import(
        /* @vite-ignore */
        moduleUrl
      );
      const segmenter = await pipeline("background-removal", "Xenova/modnet", {
        device: "wasm",
      });
      const result = await segmenter(source);
      if (request !== requestRef.current) {
        return;
      }
      const output = result[0] as {
        toCanvas?: () => Promise<HTMLCanvasElement> | HTMLCanvasElement;
        toDataURL?: () => string;
        data?: Uint8ClampedArray;
        width?: number;
        height?: number;
        channels?: number;
      };
      const canvas = output.toCanvas ? await output.toCanvas() : undefined;
      let dataURL =
        output.toDataURL?.() ||
        (canvas && typeof (canvas as HTMLCanvasElement).toDataURL === "function"
          ? (canvas as HTMLCanvasElement).toDataURL("image/png")
          : undefined);
      if (!dataURL && output.data && output.width && output.height) {
        const document = dialogRef.current?.ownerDocument;
        const rgba = document?.createElement("canvas");
        if (!document || !rgba) {
          throw new Error("The AI output cannot be rendered.");
        }
        rgba.width = output.width;
        rgba.height = output.height;
        const context = rgba.getContext("2d");
        if (!context) {
          throw new Error("The AI output cannot be rendered.");
        }
        const imageData = context.createImageData(output.width, output.height);
        if (output.channels === 4) {
          imageData.data.set(output.data);
        } else {
          for (let i = 0; i < output.width * output.height; i++) {
            const alpha = output.data[i] ?? 255;
            imageData.data.set([255, 255, 255, alpha], i * 4);
          }
        }
        context.putImageData(imageData, 0, 0);
        dataURL = rgba.toDataURL("image/png");
      }
      if (!dataURL) {
        throw new Error("The AI model returned no image.");
      }
      setPreview(dataURL);
    } catch (cause) {
      if (request === requestRef.current) {
        setError(
          cause instanceof Error
            ? cause.message
            : "AI background removal failed.",
        );
      }
    } finally {
      if (request === requestRef.current) {
        setBusy(false);
      }
    }
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={
        operation === "recolor"
          ? "Recolor icon"
          : operation === "ai-background"
          ? "Remove background with AI"
          : operation === "icon-sheet"
          ? "Remove tile colors"
          : operation === "background-color"
          ? "Change icon background color"
          : "Remove background"
      }
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          onClose();
        }
        if (event.key === "Tab") {
          const controls = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              "button:not([disabled]), input:not([disabled])",
            ),
          );
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (
            event.shiftKey &&
            (event.currentTarget.ownerDocument.activeElement === first ||
              event.currentTarget.ownerDocument.activeElement ===
                event.currentTarget)
          ) {
            event.preventDefault();
            last?.focus();
          } else if (
            !event.shiftKey &&
            event.currentTarget.ownerDocument.activeElement === last
          ) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10000,
        background: "#0009",
        display: "grid",
        placeItems: "center",
        padding: 16,
      }}
    >
      <div
        style={{
          background: "var(--color-surface-high, white)",
          color: "var(--color-on-surface, #222)",
          padding: 20,
          borderRadius: 12,
          fontFamily: "system-ui, sans-serif",
          lineHeight: 1.4,
          width: "min(680px, 100%)",
          maxHeight: "90vh",
          overflow: "auto",
        }}
      >
        <h2>
          {operation === "recolor"
            ? "Recolor icon"
            : operation === "ai-background"
            ? "Remove background with AI"
            : operation === "icon-sheet"
            ? "Remove tile colors"
            : operation === "background-color"
            ? "Change icon background color"
            : "Remove background"}
        </h2>
        <p>
          {operation === "recolor"
            ? "Visible pixels become one color. Multicolor artwork becomes a silhouette; remove its background first if needed."
            : operation === "ai-background"
            ? "Runs MODNet locally in your browser. The first run downloads the model; the image is not sent to a processing service. Best results are expected for a single prominent foreground subject."
            : operation === "icon-sheet"
            ? "Removes the white page and each colored icon tile, leaving the central artwork. Preview the result before applying it."
            : operation === "background-color"
            ? "Changes the edge-connected white background while preserving the icon artwork. This is intended for icon sheets and flat illustrations."
            : "Removes only areas matching this color that connect to an image edge. Best for icons and images with a solid background."}
        </p>
        <p>
          Processing happens on this device. Applying the result to a shared
          drawing uses its normal save and sync flow.
        </p>
        {operation !== "ai-background" && operation !== "icon-sheet" && (
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {operation === "recolor"
              ? "New icon color"
              : operation === "background-color"
              ? "New background color"
              : "Background color"}
            <input
              type="color"
              value={color}
              disabled={busy}
              onChange={(event) => setColor(event.target.value)}
            />
            <input
              aria-label="Hex color"
              value={color}
              disabled={busy}
              onChange={(event) => setColor(event.target.value)}
              style={{ width: 90 }}
            />
          </label>
        )}
        {operation === "flat-background" && (
          <label style={{ display: "block", marginTop: 12 }}>
            Color tolerance: {tolerance}
            <input
              type="range"
              min="0"
              max="100"
              value={tolerance}
              disabled={busy}
              onChange={(event) => setTolerance(Number(event.target.value))}
              style={{ display: "block", width: "100%" }}
            />
          </label>
        )}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            gap: 12,
            margin: "16px 0",
          }}
        >
          <div>
            <strong>Before</strong>
            <img
              alt="Original"
              src={source}
              style={{
                display: "block",
                width: "100%",
                maxHeight: 240,
                objectFit: "contain",
              }}
            />
          </div>
          <div>
            <strong>After</strong>
            <div
              style={{
                minHeight: 160,
                background:
                  "repeating-conic-gradient(#ddd 0% 25%, #fff 0% 50%) 0 0 / 20px 20px",
              }}
            >
              {preview && (
                <img
                  alt="Processed preview"
                  src={preview}
                  style={{
                    display: "block",
                    width: "100%",
                    maxHeight: 240,
                    objectFit: "contain",
                  }}
                />
              )}
            </div>
          </div>
        </div>
        <p role="status" aria-live="polite">
          {busy
            ? "Processing image…"
            : error ||
              (preview
                ? "Preview ready. Apply to update the drawing."
                : "Choose settings, then preview.")}
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            type="button"
            onClick={onClose}
            style={{ padding: "8px 12px", borderRadius: 8 }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={process}
            disabled={busy || !/^#[\da-f]{6}$/i.test(color)}
            style={{ padding: "8px 12px", borderRadius: 8 }}
          >
            {preview ? "Retry preview" : "Preview"}
          </button>
          <button
            type="button"
            onClick={() => preview && onApply(preview)}
            disabled={!preview || busy}
            style={{
              padding: "8px 12px",
              borderRadius: 8,
              background: "#6965db",
              color: "white",
              border: 0,
            }}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
};
