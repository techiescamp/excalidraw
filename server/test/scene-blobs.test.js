import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { installSceneBlobs } from "../lib/scene-blobs.js";

// A cache far smaller than the scene forces eviction while the scene is still
// being assembled, which is what made a drawing refuse to open in production.
test("a scene larger than the image cache still opens", async () => {
  const objects = new Map();
  const blobs = new Map();
  const db = {
    async query(sql, params) {
      if (/INSERT INTO workspace_blobs/.test(sql)) {
        const [workspace, sha256, mime, size, key] = params;
        if (blobs.has(sha256)) return { rowCount: 0, rows: [] };
        blobs.set(sha256, { sha256, mime, size_bytes: size, s3_key: key, workspace });
        return { rowCount: 1, rows: [] };
      }
      if (/SELECT sha256,mime,s3_key FROM workspace_blobs/.test(sql))
        return { rows: params[1].map((sha) => blobs.get(sha)).filter(Boolean) };
      return { rowCount: 0, rows: [] };
    },
  };
  const storage = {
    async put(key, body) {
      objects.set(key, body);
    },
    async read(key) {
      return objects.get(key) ?? null;
    },
  };
  // A cache that holds barely one image forces eviction mid-read.
  const store = installSceneBlobs(db, storage, { cacheBytes: 6000 });

  // Twelve distinct images, each far bigger than the cache allows.
  const files = {};
  for (let i = 0; i < 12; i++) {
    const bytes = Buffer.alloc(4096, i + 1);
    files[`file${i}`] = {
      id: `file${i}`,
      mimeType: "image/png",
      created: 1000 + i,
      dataURL: `data:image/png;base64,${bytes.toString("base64")}`,
    };
  }
  const scene = {
    type: "excalidraw",
    version: 2,
    elements: Object.keys(files).map((fileId) => ({
      id: fileId,
      type: "image",
      fileId,
      isDeleted: false,
    })),
    appState: {},
    files,
  };

  const { payload, refs } = await store.split("ws-1", scene);
  assert.deepEqual(payload.files, {});
  assert.equal(refs.length, 12);
  assert.equal(blobs.size, 12);

  const back = await store.hydrate("ws-1", payload);
  // Every image comes back exactly as it went in, cache pressure or not.
  assert.deepEqual(back.files, files);
  assert.ok(!("blobRefs" in back));
});

test("identical bytes under different file ids are stored once", async () => {
  const blobs = new Map();
  const objects = new Map();
  const db = {
    async query(sql, params) {
      if (/INSERT INTO workspace_blobs/.test(sql)) {
        if (blobs.has(params[1])) return { rowCount: 0, rows: [] };
        blobs.set(params[1], { sha256: params[1], mime: params[2], s3_key: params[4] });
        return { rowCount: 1, rows: [] };
      }
      if (/SELECT sha256,mime,s3_key FROM workspace_blobs/.test(sql))
        return { rows: params[1].map((sha) => blobs.get(sha)).filter(Boolean) };
      return { rowCount: 0, rows: [] };
    },
  };
  const storage = {
    async put(key, body) { objects.set(key, body); },
    async read(key) { return objects.get(key) ?? null; },
  };
  const store = installSceneBlobs(db, storage);
  const dataURL = `data:image/png;base64,${Buffer.from("same bytes").toString("base64")}`;
  const { refs } = await store.split("ws-1", {
    elements: [],
    appState: {},
    files: {
      a: { id: "a", mimeType: "image/png", created: 1, dataURL },
      b: { id: "b", mimeType: "image/png", created: 2, dataURL },
    },
  });
  assert.equal(blobs.size, 1, "one stored object for identical bytes");
  assert.equal(objects.size, 1);
  assert.equal(new Set(refs.map((r) => r.sha256)).size, 1);
  assert.equal(
    crypto.createHash("sha256").update(Buffer.from("same bytes")).digest("hex"),
    refs[0].sha256,
  );
});
