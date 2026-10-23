import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  canvasLogicalBytes,
  createCanvasDiskCache,
  DEFAULT_CANVAS_CACHE_BYTES,
  DEFAULT_CANVAS_MIN_BYTES,
} from "../lib/canvas-disk-cache.js";

const sceneId = "00000000-0000-4000-8000-000000000001";
const scene = (dataURL = "") => ({
  type: "excalidraw",
  elements: [],
  appState: {},
  files: dataURL ? { image: { dataURL } } : {},
});
const tempCache = async (t, options = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-cache-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, cache: createCanvasDiskCache({ root, ...options }) };
};

test("the default limit is 20 GB and the threshold is strictly above 5 MB", async (t) => {
  assert.equal(DEFAULT_CANVAS_CACHE_BYTES, 20_000_000_000);
  assert.equal(DEFAULT_CANVAS_MIN_BYTES, 5_000_000);
  const { cache } = await tempCache(t);
  assert.equal(await cache.write(sceneId, 1, scene(), 5_000_000), false);
  assert.equal(await cache.read(sceneId, 1), null);
  assert.equal(await cache.write(sceneId, 1, scene(), 5_000_001), true);
  assert.deepEqual(await cache.read(sceneId, 1), scene());
});

test("large canvas survives restart, version changes, and corrupted entries", async (t) => {
  const { root, cache } = await tempCache(t);
  const image = crypto.randomBytes(5_100_000);
  const large = scene(`data:image/png;base64,${image.toString("base64")}`);
  assert.equal(await cache.write(sceneId, 7, large, 5_100_000), true);
  const restarted = createCanvasDiskCache({ root });
  assert.deepEqual(await restarted.read(sceneId, 7), large);
  assert.equal(await restarted.read(sceneId, 8), null);

  assert.equal(await restarted.write(sceneId, 8, large, 5_100_000), true);
  assert.equal(await restarted.read(sceneId, 7), null);
  assert.equal(await restarted.write(sceneId, 7, large, 5_100_000), false);

  const file = path.join(root, sceneId, "8.json");
  const raw = await fs.readFile(file);
  raw[raw.length - 1] ^= 1;
  await fs.writeFile(file, raw);
  assert.equal(await restarted.read(sceneId, 8), null);
  assert.equal(restarted.stats().entries, 0);
});

test("eviction respects the byte limit and concurrent writes count once", async (t) => {
  const { cache } = await tempCache(t, { maxBytes: 220, minBytes: 1 });
  const first = scene("first");
  const second = scene("second");
  assert.deepEqual(
    await Promise.all([
      cache.write(sceneId, 1, first, 2),
      cache.write(sceneId, 1, first, 2),
    ]),
    [true, true],
  );
  assert.equal(cache.stats().entries, 1);
  assert.equal(await cache.write(sceneId, 2, second, 2), true);
  assert.deepEqual(await cache.read(sceneId, 2), second);
  assert.equal(await cache.read(sceneId, 1), null);
  await cache.removeScene(sceneId);
  assert.equal(cache.stats().bytes, 0);
});

test("canvas size counts each referenced raw image once", () => {
  const image = Buffer.from("six bytes of image data");
  const dataURL = `data:image/png;base64,${image.toString("base64")}`;
  const stored = {
    blobRefs: {
      image: { sha256: "same" },
      duplicate: { sha256: "same" },
    },
  };
  const hydrated = { files: { image: { dataURL }, duplicate: { dataURL } } };
  assert.equal(canvasLogicalBytes(300, stored, hydrated), 300 + image.length);
  assert.equal(canvasLogicalBytes(300, {}, hydrated), 300);
});

test("invalid cache keys cannot escape the cache directory", async (t) => {
  const { cache } = await tempCache(t);
  await assert.rejects(cache.read("../escape", 1), /Invalid canvas/);
  await assert.rejects(
    cache.write(sceneId, -1, scene(), 6_000_000),
    /Invalid canvas/,
  );
});
