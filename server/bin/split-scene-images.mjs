// Moves images out of stored scenes and into the workspace blob store, so a
// drawing holds references instead of megabytes of base64.
//
//   node bin/split-scene-images.mjs                 # report, changes nothing
//   node bin/split-scene-images.mjs --apply
//   node bin/split-scene-images.mjs --apply --scene <uuid>
//
// Safe to run against a live workspace: readers accept both shapes, a scene
// already split is skipped, and each scene is its own transaction, so the run
// can be stopped and resumed. Nothing is deleted — the object a scene pointed
// at before stays where it is as a restore point.
import crypto from "node:crypto";
import pg from "pg";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.includes("=")
    ? hit.slice(hit.indexOf("=") + 1)
    : process.argv[process.argv.indexOf(hit) + 1] ?? fallback;
};
const APPLY = process.argv.includes("--apply");
const ONLY = arg("scene", "");
const LIMIT = Number(arg("limit", 0)) || null;
const BUCKET = process.env.SOURCE_BUCKET || process.env.S3_BUCKET;
const DATA_URL = /^data:([^;,]+);base64,(.+)$/s;
const mb = (b) => (Number(b) / 1048576).toFixed(1) + " MB";

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  ...(process.env.S3_ENDPOINT
    ? { endpoint: process.env.S3_ENDPOINT, forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true" }
    : {}),
  credentials: {
    accessKeyId: process.env.SOURCE_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.SOURCE_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY,
  },
});
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const main = async () => {
  const { rows: scenes } = await db.query(
    `SELECT id,workspace_id,name,s3_key,size_bytes,scene_version FROM scenes
     WHERE deleted_at IS NULL AND ($1='' OR id=$1::uuid)
     ORDER BY size_bytes DESC ${LIMIT ? "LIMIT " + LIMIT : ""}`,
    [ONLY],
  );
  console.log(`${scenes.length} drawings to examine\n`);

  let before = 0, after = 0, split = 0, skipped = 0, images = 0, unique = new Set();
  const failures = [];

  for (const scene of scenes) {
    try {
      const object = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: scene.s3_key }));
      const body = Buffer.from(await object.Body.transformToByteArray());
      let parsed;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        skipped++;
        continue; // an encrypted legacy scene is left alone
      }
      const files = parsed.files || {};
      const inline = Object.entries(files).filter(([, f]) => DATA_URL.test(f?.dataURL || ""));
      if (!inline.length) {
        skipped++;
        continue;
      }
      const blobRefs = { ...(parsed.blobRefs || {}) };
      const pending = [];
      for (const [fileId, file] of inline) {
        const [, mime, b64] = DATA_URL.exec(file.dataURL);
        const bytes = Buffer.from(b64, "base64");
        const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
        blobRefs[fileId] = { sha256, mimeType: mime };
        pending.push({ fileId, sha256, mime, bytes });
        unique.add(sha256);
      }
      const stored = { ...parsed, files: {}, blobRefs };
      const next = Buffer.from(JSON.stringify(stored));
      before += body.length;
      after += next.length;
      images += pending.length;
      split++;
      console.log(
        `${scene.name.slice(0, 34).padEnd(34)} ${mb(body.length).padStart(9)} -> ${mb(next.length).padStart(9)}  ${pending.length} images`,
      );
      if (!APPLY) continue;

      for (const p of pending) {
        const key = `blobs/${scene.workspace_id}/${p.sha256}`;
        const { rowCount } = await db.query(
          `INSERT INTO workspace_blobs(workspace_id,sha256,mime,size_bytes,s3_key)
           VALUES($1,$2,$3,$4,$5) ON CONFLICT (workspace_id,sha256) DO NOTHING`,
          [scene.workspace_id, p.sha256, p.mime, p.bytes.length, key],
        );
        if (rowCount)
          await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: p.bytes, ContentType: p.mime }));
      }
      // The new object is written under a fresh name and the pointer moved
      // afterwards, so a failure here leaves the drawing on its old object.
      const key = `scenes/${scene.id}/${crypto.randomUUID()}.json`;
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: next, ContentType: "application/json" }));
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await client.query("DELETE FROM scene_blob_refs WHERE scene_id=$1", [scene.id]);
        await client.query(
          `INSERT INTO scene_blob_refs(scene_id,workspace_id,file_id,sha256)
           SELECT $1,$2,f.file_id,f.sha256 FROM unnest($3::text[],$4::text[]) AS f(file_id,sha256)`,
          [scene.id, scene.workspace_id, Object.keys(blobRefs), Object.values(blobRefs).map((r) => r.sha256)],
        );
        await client.query("UPDATE scenes SET s3_key=$2,size_bytes=$3 WHERE id=$1 AND s3_key=$4", [
          scene.id, key, next.length, scene.s3_key,
        ]);
        await client.query(
          "UPDATE scene_versions SET s3_key=$2,size_bytes=$3 WHERE scene_id=$1 AND s3_key=$4",
          [scene.id, key, next.length, scene.s3_key],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      failures.push({ scene: scene.name, error: error.message });
      console.error(`FAILED ${scene.name}: ${error.message}`);
    }
  }

  console.log(`\nsplit ${split} drawings, skipped ${skipped}`);
  console.log(`scene objects: ${mb(before)} -> ${mb(after)}`);
  console.log(`images moved out: ${images}, distinct: ${unique.size}`);
  if (!APPLY) console.log("\nDRY RUN — nothing was changed. Add --apply.");
  if (failures.length) {
    console.error(`\n${failures.length} drawings failed:`);
    for (const f of failures.slice(0, 10)) console.error(`  ${f.scene}: ${f.error}`);
    process.exitCode = 1;
  }
};

main()
  .catch((error) => {
    console.error("split failed:", error.message);
    process.exitCode = 1;
  })
  .finally(() => db.end());
