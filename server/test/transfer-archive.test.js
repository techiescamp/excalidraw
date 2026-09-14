import { test } from "node:test";
import assert from "node:assert/strict";
import { zipSync } from "fflate";
import { unpack, MAX_SCENE_BYTES } from "../lib/transfer-archive.js";
test("ZIP parser rejects oversized expansion before allocating scene buffers", () => {
  const zip = zipSync({
    "bomb.excalidraw": new Uint8Array(MAX_SCENE_BYTES + 1),
  });
  assert.throws(() => unpack(zip), /Archive exceeds/);
});
test("ZIP parser rejects traversal, corrupt archives, and excessive entry counts", () => {
  assert.throws(
    () => unpack(zipSync({ "a/../b.excalidraw": new Uint8Array() })),
    /unsafe/,
  );
  assert.throws(() => unpack(Buffer.from("not a zip")));
  assert.throws(
    () =>
      unpack(
        zipSync(
          Object.fromEntries(
            Array.from({ length: 1001 }, (_, i) => [
              i + ".excalidraw",
              new Uint8Array(),
            ]),
          ),
        ),
      ),
    /Archive exceeds/,
  );
});
