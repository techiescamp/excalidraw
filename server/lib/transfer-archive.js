import {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} from "node:worker_threads";
import { unzipSync, zipSync } from "fflate";
export const MAX_BYTES = 100 * 1024 * 1024;
export const MAX_SCENE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES = 1000;
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
  if (bytes.length > MAX_BYTES) throw new Error("Upload exceeds 100 MB.");
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
          "Archive exceeds 1,000 entries, 25 MB per file, or 100 MB expanded.",
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
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error("Archive processing timed out."));
    }, 60000);
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
