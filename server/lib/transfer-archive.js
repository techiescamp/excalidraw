import {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} from "node:worker_threads";
import { unzipSync, zipSync } from "fflate";
// An export that cannot be imported again is not a backup, so both directions
// share these figures. The ceiling is what the droplet can hold rather than a
// policy: an upload is buffered whole, copied into the worker, expanded, and
// copied back, so peak memory is roughly four times the archive. Lifting it
// further means streaming the archive through a file instead of memory.
export const MAX_BYTES = 256 * 1024 * 1024;
export const MAX_SCENE_BYTES = 64 * 1024 * 1024;
export const EXPORT_MAX_BYTES = MAX_BYTES;
export const EXPORT_MAX_SCENE_BYTES = MAX_SCENE_BYTES;
export const MAX_FILES = 2000;
const mb = (bytes) => `${Math.round(bytes / 1024 / 1024)} MB`;
export function safePath(name) {
  if (
    typeof name !== "string" ||
    name.length > 1024 ||
    /[\\\x00-\x1f]/.test(name) ||
    name.startsWith("/") ||
    /^[A-Za-z]:/.test(name) ||
    name.split("/").some((p) => p === ".." || p === ".")
  )
    throw new Error("Archive contains an unsafe file path.");
  return name;
}
export function unpack(bytes) {
  if (bytes.length > MAX_BYTES)
    throw new Error(`Upload exceeds ${mb(MAX_BYTES)}.`);
  let count = 0,
    total = 0;
  const names = new Set();
  // Inspect the directory before allocating decompression buffers.
  unzipSync(bytes, {
    filter(file) {
      safePath(file.name);
      if (
        ++count > MAX_FILES ||
        !Number.isSafeInteger(file.originalSize) ||
        file.originalSize > MAX_SCENE_BYTES ||
        (total += file.originalSize) > MAX_BYTES
      )
        throw new Error(
          `Archive exceeds ${MAX_FILES.toLocaleString()} entries, ${mb(
            MAX_SCENE_BYTES,
          )} per file, or ${mb(MAX_BYTES)} expanded.`,
        );
      if (names.has(file.name))
        throw new Error("Archive contains duplicate file paths.");
      names.add(file.name);
      return false;
    },
  });
  return unzipSync(bytes, {
    filter: (file) =>
      /\.excalidraw$/i.test(file.name) || file.name === "manifest.json",
  });
}
export function archiveTask(operation, data) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { operation, data },
      resourceLimits: { maxOldGenerationSizeMb: 1024 },
    });
    // Imports are one upload and stay quick; packing a whole workspace is
    // hundreds of megabytes and needs minutes, not seconds.
    const timer = setTimeout(
      () => {
        worker.terminate();
        reject(
          new Error(
            "Packing the archive took too long. Export one collection at a time.",
          ),
        );
      },
      operation === "zip" ? 600000 : 60000,
    );
    worker.once("message", (result) => {
      clearTimeout(timer);
      result.error ? reject(new Error(result.error)) : resolve(result.value);
    });
    worker.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    worker.once("exit", (code) => {
      clearTimeout(timer);
      if (code) reject(new Error("Archive processing failed."));
    });
  });
}
if (!isMainThread) {
  try {
    parentPort.postMessage({
      value:
        workerData.operation === "zip"
          ? zipSync(workerData.data, { level: 1 })
          : unpack(workerData.data),
    });
  } catch (error) {
    parentPort.postMessage({ error: error.message });
  }
}
