import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DEFAULT_CANVAS_CACHE_BYTES = 20 * 1000 ** 3;
export const DEFAULT_CANVAS_MIN_BYTES = 5 * 1000 ** 2;

// Match the inventory metric: stored scene JSON plus each distinct raw image.
// Older drawings have inline images already counted inside storedSceneBytes.
export function canvasLogicalBytes(
  storedSceneBytes,
  storedScene,
  hydratedScene,
) {
  let bytes = storedSceneBytes;
  const seen = new Set();
  for (const [fileId, ref] of Object.entries(storedScene.blobRefs || {})) {
    if (seen.has(ref.sha256)) {
      continue;
    }
    seen.add(ref.sha256);
    const dataURL = hydratedScene.files?.[fileId]?.dataURL;
    const separator =
      typeof dataURL === "string" ? dataURL.indexOf(";base64,") : -1;
    if (separator < 0) {
      return NaN;
    }
    bytes += Buffer.byteLength(dataURL.slice(separator + 8), "base64");
  }
  return bytes;
}

// A disposable, private copy of fully hydrated drawings. The caller must check
// access and use the current database scene_version before consulting it.
export function createCanvasDiskCache({
  root,
  maxBytes = DEFAULT_CANVAS_CACHE_BYTES,
  minBytes = DEFAULT_CANVAS_MIN_BYTES,
}) {
  if (!root || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("Invalid canvas disk cache configuration");
  }
  const entries = new Map();
  let bytes = 0;
  let ready;
  let writes = Promise.resolve();

  const keyOf = (sceneId, version) => {
    if (!UUID.test(sceneId) || !Number.isSafeInteger(version) || version < 0) {
      throw new Error("Invalid canvas disk cache key");
    }
    return `${sceneId}/${version}.json`;
  };
  const filePath = (key) => path.join(root, key);
  const discard = async (key) => {
    const entry = entries.get(key);
    if (!entry) {
      return;
    }
    await fs.rm(filePath(key), { force: true });
    entries.delete(key);
    bytes -= entry.size;
  };
  const evict = async (incoming) => {
    if (bytes + incoming <= maxBytes) {
      return;
    }
    for (const [key] of [...entries].sort((a, b) => a[1].used - b[1].used)) {
      await discard(key);
      if (bytes + incoming <= maxBytes) {
        break;
      }
    }
  };
  const initialize = async () => {
    entries.clear();
    bytes = 0;
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    for (const directory of await fs.readdir(root, { withFileTypes: true })) {
      if (!directory.isDirectory() || !UUID.test(directory.name)) {
        continue;
      }
      const sceneDir = path.join(root, directory.name);
      for (const file of await fs.readdir(sceneDir, { withFileTypes: true })) {
        if (file.isFile() && file.name.endsWith(".tmp")) {
          await fs.rm(path.join(sceneDir, file.name), { force: true });
          continue;
        }
        if (!file.isFile() || !/^(0|[1-9]\d*)\.json$/.test(file.name)) {
          continue;
        }
        const key = `${directory.name}/${file.name}`;
        const stat = await fs.stat(filePath(key));
        entries.set(key, { size: stat.size, used: stat.mtimeMs });
        bytes += stat.size;
      }
    }
    await evict(0);
  };
  const ensureReady = () =>
    (ready ??= initialize().catch((error) => {
      ready = undefined;
      throw error;
    }));
  const enqueue = (action) => {
    const next = writes.then(action);
    writes = next.catch(() => {});
    return next;
  };

  return {
    prime: ensureReady,
    stats: () => ({ entries: entries.size, bytes, maxBytes, minBytes }),
    async read(sceneId, version) {
      const key = keyOf(sceneId, version);
      await ensureReady();
      if (!entries.has(key)) {
        return null;
      }
      let raw;
      try {
        raw = await fs.readFile(filePath(key));
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
        await enqueue(() => discard(key));
        return null;
      }
      const body = raw.subarray(32);
      if (
        raw.length < 33 ||
        !crypto
          .createHash("sha256")
          .update(body)
          .digest()
          .equals(raw.subarray(0, 32))
      ) {
        await enqueue(() => discard(key));
        return null;
      }
      try {
        const scene = JSON.parse(body.toString("utf8"));
        if (
          !scene ||
          !Array.isArray(scene.elements) ||
          !scene.files ||
          typeof scene.files !== "object"
        ) {
          await enqueue(() => discard(key));
          return null;
        }
        const entry = entries.get(key);
        if (entry) {
          entry.used = Date.now();
        }
        return scene;
      } catch {
        await enqueue(() => discard(key));
        return null;
      }
    },
    async write(sceneId, version, scene, logicalBytes) {
      const key = keyOf(sceneId, version);
      if (!Number.isFinite(logicalBytes) || logicalBytes <= minBytes) {
        return false;
      }
      const body = Buffer.from(JSON.stringify(scene));
      const raw = Buffer.concat([
        crypto.createHash("sha256").update(body).digest(),
        body,
      ]);
      if (raw.length > maxBytes) {
        return false;
      }
      await ensureReady();
      return enqueue(async () => {
        if (entries.has(key)) {
          return true;
        }
        if (
          [...entries.keys()].some(
            (oldKey) =>
              oldKey.startsWith(`${sceneId}/`) &&
              Number(oldKey.slice(sceneId.length + 1, -5)) > version,
          )
        ) {
          return false;
        }
        for (const oldKey of [...entries.keys()]) {
          if (oldKey.startsWith(`${sceneId}/`)) {
            await discard(oldKey);
          }
        }
        await evict(raw.length);
        const target = filePath(key);
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        const temporary = `${target}.${crypto.randomUUID()}.tmp`;
        try {
          await fs.writeFile(temporary, raw, { flag: "wx", mode: 0o600 });
          await fs.rename(temporary, target);
        } finally {
          await fs.rm(temporary, { force: true });
        }
        entries.set(key, { size: raw.length, used: Date.now() });
        bytes += raw.length;
        return true;
      });
    },
    async removeScene(sceneId) {
      if (!UUID.test(sceneId)) {
        throw new Error("Invalid canvas disk cache key");
      }
      await ensureReady();
      await enqueue(async () => {
        for (const key of [...entries.keys()]) {
          if (key.startsWith(`${sceneId}/`)) {
            await discard(key);
          }
        }
      });
    },
  };
}
