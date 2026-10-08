// Undo a version-history prune from an archive written by archive-versions.mjs.
// Copies objects back to their original keys and re-registers the restore points.
//
//   node bin/restore-versions.mjs --stamp <s> --dry-run             # report only
//   node bin/restore-versions.mjs --stamp <s> --scene <uuid>        # one drawing
//   node bin/restore-versions.mjs --stamp <s> --apply               # everything
//
// A drawing's current content is never touched: only rows that are missing are
// inserted, and an object is only written back when it is absent from storage.
import pg from "pg";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.includes("=")
    ? hit.slice(hit.indexOf("=") + 1)
    : process.argv[process.argv.indexOf(hit) + 1] ?? fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const STAMP = arg("stamp", "");
const SCENE = arg("scene", "");
const APPLY = flag("apply");
const CONCURRENCY = Math.max(1, Number(arg("concurrency", 8)));
if (!STAMP) {
  console.error("--stamp is required, e.g. --stamp 2026-10-08T06-32-56Z");
  process.exit(1);
}
const PREFIX = `archive/${STAMP}`;
const SRC_BUCKET = process.env.SOURCE_BUCKET || process.env.S3_BUCKET;
const DST_BUCKET = process.env.BACKUP_BUCKET;
const gb = (b) => (Number(b) / 1073741824).toFixed(2) + " GB";

const client = (id, secret) =>
  new S3Client({
    region: process.env.AWS_REGION,
    ...(process.env.S3_ENDPOINT
      ? { endpoint: process.env.S3_ENDPOINT, forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true" }
      : {}),
    credentials: { accessKeyId: id, secretAccessKey: secret },
  });
const live = client(process.env.SOURCE_ACCESS_KEY_ID, process.env.SOURCE_SECRET_ACCESS_KEY);
const archive = client(process.env.AWS_ACCESS_KEY_ID, process.env.AWS_SECRET_ACCESS_KEY);
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const main = async () => {
  const head = await archive.send(
    new GetObjectCommand({ Bucket: DST_BUCKET, Key: `${PREFIX}/manifest.json` }),
  );
  const data = JSON.parse(Buffer.from(await head.Body.transformToByteArray()).toString("utf8"));
  console.log(`archive ${PREFIX} taken ${data.takenAt}`);

  const wanted = data.versions.filter((v) => !SCENE || v.scene_id === SCENE);
  if (!wanted.length) {
    console.log(SCENE ? `No restore points for scene ${SCENE} in this archive.` : "Archive has no restore points.");
    return;
  }
  // Only the rows that are actually gone need putting back.
  const existing = new Set(
    (
      await db.query("SELECT id FROM scene_versions WHERE id = ANY($1::uuid[])", [
        wanted.map((v) => v.id),
      ])
    ).rows.map((r) => r.id),
  );
  const scenesPresent = new Set(
    (
      await db.query("SELECT id FROM scenes WHERE id = ANY($1::uuid[])", [
        [...new Set(wanted.map((v) => v.scene_id))],
      ])
    ).rows.map((r) => r.id),
  );
  const missing = wanted.filter((v) => !existing.has(v.id) && scenesPresent.has(v.scene_id));
  const orphaned = wanted.filter((v) => !existing.has(v.id) && !scenesPresent.has(v.scene_id));

  console.log(`\nin archive:        ${wanted.length} restore points`);
  console.log(`already present:   ${wanted.length - missing.length - orphaned.length}`);
  console.log(`to restore:        ${missing.length}  (${gb(missing.reduce((s, v) => s + Number(v.size_bytes), 0))})`);
  if (orphaned.length)
    console.log(`skipped:           ${orphaned.length} (their drawing no longer exists)`);
  if (SCENE) console.log(`scope:             scene ${SCENE}`);

  if (!missing.length) {
    console.log("\nNothing to restore.");
    return;
  }
  if (!APPLY) {
    console.log("\nDRY RUN — nothing was changed.");
    console.log(`To restore: --stamp ${STAMP}${SCENE ? ` --scene ${SCENE}` : ""} --apply`);
    return;
  }

  let objects = 0, rows = 0, present = 0;
  const failures = [];
  const queue = [...missing];
  const worker = async () => {
    for (;;) {
      const v = queue.shift();
      if (!v) return;
      try {
        let there = false;
        try {
          await live.send(new HeadObjectCommand({ Bucket: SRC_BUCKET, Key: v.s3_key }));
          there = true;
          present++;
        } catch {
          there = false;
        }
        if (!there) {
          const o = await archive.send(
            new GetObjectCommand({ Bucket: DST_BUCKET, Key: `${PREFIX}/objects/${v.s3_key}` }),
          );
          const body = Buffer.from(await o.Body.transformToByteArray());
          await live.send(
            new PutObjectCommand({
              Bucket: SRC_BUCKET,
              Key: v.s3_key,
              Body: body,
              ContentType: "application/json",
            }),
          );
          objects++;
        }
        // The id is preserved, so re-running is harmless.
        await db.query(
          `INSERT INTO scene_versions(id,scene_id,s3_key,scene_version,size_bytes,created_by,created_at)
           VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
          [v.id, v.scene_id, v.s3_key, v.scene_version, v.size_bytes, v.created_by, v.created_at],
        );
        rows++;
      } catch (error) {
        failures.push({ key: v.s3_key, error: `${error.Code || error.name}: ${error.message}` });
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`\nrestored ${rows} restore points, wrote ${objects} objects, ${present} were still in storage`);
  if (failures.length) {
    console.log(`FAILURES: ${failures.length}`);
    for (const f of failures.slice(0, 10)) console.log("  ", f.key, f.error);
    process.exitCode = 1;
  }
};

main()
  .catch((error) => {
    console.error("restore failed:", error.message);
    process.exitCode = 1;
  })
  .finally(() => db.end());
