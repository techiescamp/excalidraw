// Version-history retention. Reports what old restore points could be removed
// and, only when explicitly told to, removes them.
//
//   node bin/prune-versions.mjs                     # dry run, changes nothing
//   node bin/prune-versions.mjs --keep 10 --grace-days 14
//   node bin/prune-versions.mjs --apply --confirm-rows=<n from the dry run>
//
// Current drawings are never candidates. An object is only ever deleted when no
// surviving row in any table still points at it.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { S3Client, DeleteObjectsCommand } from "@aws-sdk/client-s3";

const arg = (name, fallback) => {
  const hit = process.argv.find(
    (a) => a === `--${name}` || a.startsWith(`--${name}=`),
  );
  if (!hit) return fallback;
  const value = hit.includes("=")
    ? hit.slice(hit.indexOf("=") + 1)
    : process.argv[process.argv.indexOf(hit) + 1];
  return value === undefined ? fallback : value;
};
const flag = (name) => process.argv.includes(`--${name}`);

const KEEP = Math.max(1, Number(arg("keep", 10)));
const GRACE_DAYS = Math.max(0, Number(arg("grace-days", 14)));
const APPLY = flag("apply");
const CONFIRM = arg("confirm-rows", "");
const INCLUDE_TRASHED = flag("include-trashed");
const REPORT = arg("report", "/tmp/prune-versions-report.json");

const mb = (bytes) => (Number(bytes) / 1048576).toFixed(1) + " MB";
const gb = (bytes) => (Number(bytes) / 1073741824).toFixed(2) + " GB";

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// Rows eligible to go: ranked beyond the newest KEEP for their drawing, and
// older than the grace window. The newest restore point of a drawing is never
// eligible regardless of KEEP, and neither is the row the drawing points at.
const CANDIDATES = `
  WITH ranked AS (
    SELECT v.id, v.scene_id, v.s3_key, v.scene_version, v.size_bytes, v.created_at,
           row_number() OVER (PARTITION BY v.scene_id ORDER BY v.scene_version DESC) AS rn
    FROM scene_versions v
    JOIN scenes s ON s.id = v.scene_id
    WHERE v.s3_key <> s.s3_key
      AND ($2::boolean OR s.deleted_at IS NULL)
  )
  SELECT * FROM ranked
  WHERE rn > $1 AND created_at < now() - ($3 || ' days')::interval
`;

// Every column anywhere that names a stored object. A candidate object whose key
// appears in any of these, or in a surviving scene_versions row, stays.
const PROTECTED = `
  SELECT s3_key FROM scenes
  UNION SELECT collab_s3_key FROM scenes WHERE collab_s3_key IS NOT NULL
  UNION SELECT thumb_s3_key FROM scenes WHERE thumb_s3_key IS NOT NULL
  UNION SELECT s3_key FROM shared_scenes
  UNION SELECT s3_key FROM scene_files
  UNION SELECT s3_key FROM icons
  UNION SELECT object_key FROM workspace_exports WHERE object_key IS NOT NULL
`;

const main = async () => {
  const candidates = (await db.query(CANDIDATES, [KEEP, INCLUDE_TRASHED, GRACE_DAYS])).rows;
  if (!candidates.length) {
    console.log("Nothing is eligible. No change.");
    return;
  }

  const protectedKeys = new Set(
    (await db.query(PROTECTED)).rows.map((r) => Object.values(r)[0]),
  );
  const candidateIds = candidates.map((r) => r.id);
  // Coalesced saves and restores make several rows share one object, so ask the
  // database which keys still have a reference that is not going away.
  const stillReferenced = new Set(
    (
      await db.query(
        "SELECT DISTINCT s3_key FROM scene_versions WHERE NOT (id = ANY($1::uuid[]))",
        [candidateIds],
      )
    ).rows.map((r) => r.s3_key),
  );

  const deletableKeys = [
    ...new Set(candidates.map((r) => r.s3_key)),
  ].filter((key) => !protectedKeys.has(key) && !stillReferenced.has(key));

  const bytes = candidates.reduce((sum, r) => sum + Number(r.size_bytes), 0);
  const scenes = new Set(candidates.map((r) => r.scene_id));
  const heaviest = Object.entries(
    candidates.reduce((acc, r) => {
      acc[r.scene_id] = (acc[r.scene_id] || 0) + Number(r.size_bytes);
      return acc;
    }, {}),
  )
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  const names = (
    await db.query(
      "SELECT id,name,scene_version FROM scenes WHERE id = ANY($1::uuid[])",
      [heaviest.map(([id]) => id)],
    )
  ).rows;

  const total = await db.query("SELECT sum(size_bytes) AS b, count(*) AS n FROM scene_versions");

  console.log(`\nPolicy: keep newest ${KEEP} per drawing, nothing younger than ${GRACE_DAYS} days`);
  console.log(`Trashed drawings: ${INCLUDE_TRASHED ? "included" : "skipped"}\n`);
  console.log(`History now:        ${gb(total.rows[0].b)} in ${total.rows[0].n} restore points`);
  console.log(`Eligible to remove: ${gb(bytes)} in ${candidates.length} restore points across ${scenes.size} drawings`);
  console.log(`Objects to delete:  ${deletableKeys.length}`);
  console.log(`History after:      ${gb(Number(total.rows[0].b) - bytes)} in ${Number(total.rows[0].n) - candidates.length} restore points\n`);
  console.log("Biggest contributors:");
  for (const [id, size] of heaviest) {
    const scene = names.find((s) => s.id === id);
    console.log(`  ${mb(size).padStart(10)}  ${scene?.name ?? id} (now at v${scene?.scene_version})`);
  }

  const kept = candidates.length - deletableKeys.length;
  if (kept > 0)
    console.log(`\n${kept} rows share an object that something else still uses; those objects stay.`);

  await writeFile(
    path.resolve(REPORT),
    JSON.stringify(
      { policy: { keep: KEEP, graceDays: GRACE_DAYS, includeTrashed: INCLUDE_TRASHED },
        rows: candidates.length, bytes, objects: deletableKeys.length,
        scenes: scenes.size, keys: deletableKeys, ids: candidateIds },
      null,
      2,
    ),
  );
  console.log(`\nFull list written to ${path.resolve(REPORT)}`);

  if (!APPLY) {
    console.log(`\nDRY RUN — nothing was changed.`);
    console.log(`To apply: --apply --confirm-rows=${candidates.length}`);
    return;
  }
  if (CONFIRM !== String(candidates.length)) {
    console.error(
      `\nRefusing to delete. --confirm-rows must be ${candidates.length}, got "${CONFIRM}".`,
    );
    console.error("Re-run the dry run and pass the number it prints.");
    process.exitCode = 1;
    return;
  }

  const s3 = new S3Client({
    region: process.env.AWS_REGION,
    ...(process.env.S3_ENDPOINT
      ? { endpoint: process.env.S3_ENDPOINT,
          forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true" }
      : {}),
    // The drawings bucket has its own credentials; the backup environment file
    // overrides AWS_* with the backup bucket's key, which cannot write here.
    credentials: {
      accessKeyId: process.env.SOURCE_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey:
        process.env.SOURCE_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY,
    },
  });
  const BUCKET = process.env.SOURCE_BUCKET || process.env.S3_BUCKET;
  // Rows go first: a row without its object is a restore point that fails
  // loudly, while an object without a row is simply unreachable.
  await db.query("DELETE FROM scene_versions WHERE id = ANY($1::uuid[])", [candidateIds]);
  console.log(`Removed ${candidateIds.length} restore points.`);
  let removed = 0;
  const refused = [];
  for (let i = 0; i < deletableKeys.length; i += 1000) {
    const batch = deletableKeys.slice(i, i + 1000);
    // Quiet mode reports per-object refusals in the response rather than
    // throwing, so a run with the wrong credentials otherwise looks successful.
    const result = await s3.send(
      new DeleteObjectsCommand({
        Bucket: BUCKET,
        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
      }),
    );
    for (const error of result.Errors || []) refused.push(error);
    removed += batch.length - (result.Errors?.length || 0);
    console.log(`Deleted ${removed}/${deletableKeys.length} objects`);
  }
  if (refused.length) {
    console.error(`\n${refused.length} objects were REFUSED by storage, for example:`);
    for (const error of refused.slice(0, 3))
      console.error(`  ${error.Key}: ${error.Code} ${error.Message || ""}`);
    console.error("The rows are gone but those objects remain; gc-orphans.mjs will find them.");
    process.exitCode = 1;
    return;
  }
  console.log("Done.");
};

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => db.end());
