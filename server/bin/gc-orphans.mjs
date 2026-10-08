// Removes stored objects that nothing points at. Thumbnails and collaboration
// snapshots were written on every save and the one they replaced was left
// behind, so the bucket holds far more objects than the workspace uses.
//
//   node bin/gc-orphans.mjs                      # report, changes nothing
//   node bin/gc-orphans.mjs --apply --confirm-objects=<n from the report>
//
// An object is a candidate only when no row in any table names it, it cannot be
// reached by a naming convention, and it is older than the grace window.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.includes("=")
    ? hit.slice(hit.indexOf("=") + 1)
    : process.argv[process.argv.indexOf(hit) + 1] ?? fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const GRACE_HOURS = Math.max(1, Number(arg("grace-hours", 48)));
const APPLY = flag("apply");
const CONFIRM = arg("confirm-objects", "");
const REPORT = arg("report", "/tmp/gc-orphans-report.json");
const BUCKET = process.env.SOURCE_BUCKET || process.env.S3_BUCKET;
const gb = (b) => (b / 1073741824).toFixed(2) + " GB";

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

// A room scene is served from its column or, failing that, from a fixed name,
// so an object with that name is in use even with no row pointing at it.
const reachableByName = (key) => /^rooms\/[^/]+\/scene\.bin$/.test(key);

const main = async () => {
  const referenced = new Set();
  const collect = async (sql, label) => {
    const { rows } = await db.query(sql);
    for (const row of rows) if (row.k) referenced.add(row.k);
    return `${label}: ${rows.length}`;
  };
  const sources = [
    await collect("SELECT s3_key k FROM scene_versions", "scene_versions"),
    await collect("SELECT s3_key k FROM scenes", "scenes"),
    await collect("SELECT thumb_s3_key k FROM scenes WHERE thumb_s3_key IS NOT NULL", "thumbnails"),
    await collect("SELECT collab_s3_key k FROM scenes WHERE collab_s3_key IS NOT NULL", "collab"),
    await collect("SELECT s3_key k FROM scene_files", "scene_files"),
    await collect("SELECT s3_key k FROM icons", "icons"),
    await collect("SELECT s3_key k FROM shared_scenes", "shared_scenes"),
    await collect("SELECT object_key k FROM workspace_exports WHERE object_key IS NOT NULL", "exports"),
  ];
  console.log("referenced by: " + sources.join(", "));

  const cutoff = Date.now() - GRACE_HOURS * 3600 * 1000;
  const orphans = [];
  const byPrefix = new Map();
  let token, total = 0, bytes = 0, tooNew = 0, byName = 0;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, ContinuationToken: token }));
    for (const o of r.Contents || []) {
      total++;
      bytes += o.Size;
      if (referenced.has(o.Key)) continue;
      if (reachableByName(o.Key)) { byName++; continue; }
      // A write and the row naming it are not one operation, so anything recent
      // is left alone rather than raced.
      if (o.LastModified.getTime() > cutoff) { tooNew++; continue; }
      orphans.push({ key: o.Key, size: o.Size });
      const p = o.Key.split("/")[0];
      const e = byPrefix.get(p) || { n: 0, b: 0 };
      e.n++; e.b += o.Size;
      byPrefix.set(p, e);
    }
    token = r.NextContinuationToken;
  } while (token);

  const orphanBytes = orphans.reduce((s, o) => s + o.size, 0);
  console.log(`\nbucket:            ${total} objects, ${gb(bytes)}`);
  console.log(`referenced:        ${referenced.size} keys in the database`);
  console.log(`kept, reachable by name: ${byName}`);
  console.log(`kept, newer than ${GRACE_HOURS}h: ${tooNew}`);
  console.log(`ORPHANED:          ${orphans.length} objects, ${gb(orphanBytes)}\n`);
  for (const [p, e] of [...byPrefix].sort((a, b) => b[1].b - a[1].b))
    console.log(`  ${p.padEnd(20)} ${String(e.n).padStart(7)} objects  ${gb(e.b).padStart(10)}`);
  console.log(`\nbucket after:      ${total - orphans.length} objects, ${gb(bytes - orphanBytes)}`);

  await writeFile(
    path.resolve(REPORT),
    JSON.stringify({ bucket: BUCKET, graceHours: GRACE_HOURS, objects: orphans.length, bytes: orphanBytes, keys: orphans.map((o) => o.key) }, null, 2),
  );
  console.log(`\nFull list written to ${path.resolve(REPORT)}`);

  if (!orphans.length) return;
  if (!APPLY) {
    console.log("\nDRY RUN — nothing was changed.");
    console.log(`To apply: --apply --confirm-objects=${orphans.length}`);
    return;
  }
  if (CONFIRM !== String(orphans.length)) {
    console.error(`\nRefusing to delete. --confirm-objects must be ${orphans.length}, got "${CONFIRM}".`);
    console.error("Re-run the report and pass the number it prints.");
    process.exitCode = 1;
    return;
  }
  let removed = 0;
  const refused = [];
  for (let i = 0; i < orphans.length; i += 1000) {
    const batch = orphans.slice(i, i + 1000);
    // Quiet mode reports per-object refusals in the response rather than
    // throwing, so a run with the wrong credentials otherwise looks successful.
    const result = await s3.send(
      new DeleteObjectsCommand({
        Bucket: BUCKET,
        Delete: { Objects: batch.map((o) => ({ Key: o.key })), Quiet: true },
      }),
    );
    for (const error of result.Errors || []) refused.push(error);
    removed += batch.length - (result.Errors?.length || 0);
    console.log(`deleted ${removed}/${orphans.length}`);
  }
  if (refused.length) {
    console.error(`\n${refused.length} objects were REFUSED by storage, for example:`);
    for (const error of refused.slice(0, 3))
      console.error(`  ${error.Key}: ${error.Code} ${error.Message || ""}`);
    process.exitCode = 1;
    return;
  }
  console.log("Done.");
};

main()
  .catch((error) => {
    console.error("gc failed:", error.message);
    process.exitCode = 1;
  })
  .finally(() => db.end());
