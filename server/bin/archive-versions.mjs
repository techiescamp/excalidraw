// Point-in-time archive of everything a drawing is made of, including the old
// restore points that the nightly backup deliberately skips. Written so a prune
// of version history can be undone; see restore-versions.mjs.
//
//   node bin/archive-versions.mjs                 # archive, then verify
//   node bin/archive-versions.mjs --verify-only --stamp 2026-10-08T06-00-00Z
//
// Nothing is deleted or modified. Objects are copied, never moved. The run is
// resumable: an object already in the archive at the right size is skipped.
import { spawn } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
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

const STAMP = arg("stamp", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z");
const PREFIX = `archive/${STAMP}`;
const CONCURRENCY = Math.max(1, Number(arg("concurrency", 8)));
const SAMPLE = Math.max(0, Number(arg("sample", 25)));
const VERIFY_ONLY = flag("verify-only");

const SRC_BUCKET = process.env.SOURCE_BUCKET || process.env.S3_BUCKET;
const DST_BUCKET = process.env.BACKUP_BUCKET;
const gb = (b) => (Number(b) / 1073741824).toFixed(2) + " GB";
const mb = (b) => (Number(b) / 1048576).toFixed(1) + " MB";

const client = (id, secret) =>
  new S3Client({
    region: process.env.AWS_REGION,
    ...(process.env.S3_ENDPOINT
      ? { endpoint: process.env.S3_ENDPOINT, forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true" }
      : {}),
    credentials: { accessKeyId: id, secretAccessKey: secret },
  });
// The two buckets have separate credentials and neither key can read the other
// bucket, so a server-side copy is impossible: bytes pass through this process.
const source = client(process.env.SOURCE_ACCESS_KEY_ID, process.env.SOURCE_SECRET_ACCESS_KEY);
const target = client(process.env.AWS_ACCESS_KEY_ID, process.env.AWS_SECRET_ACCESS_KEY);
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// When one key is granted on both buckets, Spaces copies server side and no
// bytes pass through this process: 35 GB goes from an hour to about a minute.
// Separately scoped keys cannot do this, so the copy falls back to downloading.
const canCopyServerSide = async () => {
  try {
    const probe = (
      await target.send(
        new ListObjectsV2Command({ Bucket: SRC_BUCKET, Prefix: "scenes/", MaxKeys: 1 }),
      )
    ).Contents?.[0]?.Key;
    if (!probe) return false;
    await target.send(
      new CopyObjectCommand({
        Bucket: DST_BUCKET,
        Key: `${PREFIX}/.copy-probe`,
        CopySource: `/${SRC_BUCKET}/${probe}`,
      }),
    );
    await target.send(
      new HeadObjectCommand({ Bucket: DST_BUCKET, Key: `${PREFIX}/.copy-probe` }),
    );
    return true;
  } catch {
    return false;
  }
};

const listArchive = async () => {
  const seen = new Map();
  let token;
  do {
    const r = await target.send(
      new ListObjectsV2Command({ Bucket: DST_BUCKET, Prefix: `${PREFIX}/objects/`, ContinuationToken: token }),
    );
    for (const o of r.Contents || []) seen.set(o.Key.slice(`${PREFIX}/objects/`.length), o.Size);
    token = r.NextContinuationToken;
  } while (token);
  return seen;
};

const put = (key, body, type) =>
  target.send(new PutObjectCommand({ Bucket: DST_BUCKET, Key: key, Body: body, ContentType: type }));

const manifest = async () => {
  const versions = (
    await db.query(
      `SELECT v.id,v.scene_id,v.s3_key,v.scene_version,v.size_bytes,v.created_by,v.created_at
       FROM scene_versions v ORDER BY v.scene_id, v.scene_version`,
    )
  ).rows;
  const scenes = (
    await db.query(
      `SELECT id,workspace_id,name,s3_key,thumb_s3_key,collab_s3_key,size_bytes,scene_version,deleted_at
       FROM scenes ORDER BY id`,
    )
  ).rows;
  const files = (await db.query("SELECT file_id,scene_id,room_id,s3_key,mime_type,size_bytes FROM scene_files")).rows;
  const icons = (await db.query("SELECT workspace_id,set_name,name,mime,s3_key FROM icons")).rows;
  const shared = (await db.query("SELECT id,s3_key FROM shared_scenes")).rows;
  return { stamp: STAMP, takenAt: new Date().toISOString(), versions, scenes, files, icons, shared };
};

const dump = async () => {
  const file = path.join(tmpdir(), `archive-${STAMP}.sql.gz`);
  const gzip = spawn("gzip", ["-9"], { stdio: ["pipe", "pipe", "inherit"] });
  const pg_dump = spawn("pg_dump", [process.env.DATABASE_URL], { stdio: ["ignore", "pipe", "inherit"] });
  pg_dump.stdout.pipe(gzip.stdin);
  const chunks = [];
  gzip.stdout.on("data", (c) => chunks.push(c));
  await new Promise((resolve, reject) => {
    gzip.on("close", (code) => (code ? reject(new Error("gzip failed")) : resolve()));
    pg_dump.on("error", reject);
    gzip.on("error", reject);
  });
  const body = Buffer.concat(chunks);
  await put(`${PREFIX}/excalidraw.sql.gz`, body, "application/gzip");
  await rm(file, { force: true });
  return body.length;
};

const copyAll = async (keys, already, serverSide) => {
  let done = 0, copied = 0, skipped = 0, bytes = 0;
  const failures = [];
  const queue = [...keys];
  const worker = async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      done++;
      if (already.get(item.key) === Number(item.size) && Number(item.size) > 0) {
        skipped++;
        continue;
      }
      try {
        if (serverSide) {
          await target.send(
            new CopyObjectCommand({
              Bucket: DST_BUCKET,
              Key: `${PREFIX}/objects/${item.key}`,
              CopySource: `/${SRC_BUCKET}/${encodeURIComponent(item.key).replace(/%2F/g, "/")}`,
            }),
          );
          copied++;
          bytes += Number(item.size) || 0;
        } else {
          const object = await source.send(new GetObjectCommand({ Bucket: SRC_BUCKET, Key: item.key }));
          // Spaces rejects the SDK's chunked streaming uploads, so each object is
          // buffered whole; the largest stored drawing is 27 MB.
          const body = Buffer.from(await object.Body.transformToByteArray());
          await put(`${PREFIX}/objects/${item.key}`, body, object.ContentType || "application/json");
          copied++;
          bytes += body.length;
        }
      } catch (error) {
        failures.push({ key: item.key, error: `${error.Code || error.name}: ${error.message}` });
      }
      if (done % 500 === 0)
        console.log(`  ${done}/${keys.length} — copied ${copied}, skipped ${skipped}, ${gb(bytes)}`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { copied, skipped, bytes, failures };
};

// The in-memory manifest is dropped before verification so a long copy does not
// hold tens of megabytes of rows alongside the object buffers.
const reloadManifest = async () => {
  const o = await target.send(
    new GetObjectCommand({ Bucket: DST_BUCKET, Key: `${PREFIX}/manifest.json` }),
  );
  return JSON.parse(Buffer.from(await o.Body.transformToByteArray()).toString("utf8"));
};
const verify = async (data) => {
  console.log("\n--- verification ---");
  const expected = new Map();
  for (const v of data.versions) expected.set(v.s3_key, Number(v.size_bytes));
  for (const s of data.scenes) if (s.s3_key) expected.set(s.s3_key, Number(s.size_bytes));
  for (const f of data.files) expected.set(f.s3_key, Number(f.size_bytes));
  for (const i of data.icons) expected.set(i.s3_key, null);
  for (const s of data.shared) expected.set(s.s3_key, null);

  const present = await listArchive();
  const missing = [...expected.keys()].filter((k) => !present.has(k));
  const short = [...expected.entries()].filter(
    ([k, size]) => present.has(k) && size !== null && size > 0 && present.get(k) !== size,
  );
  const empty = [...present.entries()].filter(([, size]) => size === 0);

  console.log(`expected objects: ${expected.size}`);
  console.log(`in archive:       ${present.size}`);
  console.log(`missing:          ${missing.length}`);
  console.log(`size mismatch:    ${short.length}`);
  console.log(`zero-byte:        ${empty.length}`);

  // A matching byte count proves nothing about content, so read a sample back
  // out of the archive and parse it as a scene.
  const versionKeys = data.versions.map((v) => v.s3_key).filter((k) => present.has(k));
  const picked = [];
  for (let i = 0; i < Math.min(SAMPLE, versionKeys.length); i++)
    picked.push(versionKeys[Math.floor((i * versionKeys.length) / Math.min(SAMPLE, versionKeys.length))]);
  let parsed = 0;
  const bad = [];
  for (const key of picked) {
    try {
      const o = await target.send(new GetObjectCommand({ Bucket: DST_BUCKET, Key: `${PREFIX}/objects/${key}` }));
      const scene = JSON.parse(Buffer.from(await o.Body.transformToByteArray()).toString("utf8"));
      if (Array.isArray(scene.elements)) parsed++;
      else bad.push(key);
    } catch (error) {
      bad.push(`${key} (${error.message})`);
    }
  }
  console.log(`sample parsed:    ${parsed}/${picked.length} readable scenes`);
  if (bad.length) console.log("unreadable:", bad.slice(0, 5));
  for (const m of missing.slice(0, 5)) console.log("  missing:", m);
  for (const [k] of short.slice(0, 5)) console.log("  mismatch:", k);

  const ok = !missing.length && !short.length && !empty.length && parsed === picked.length;
  console.log(`\nVERIFY: ${ok ? "PASS — archive is complete and readable" : "FAIL — do not prune"}`);
  return ok;
};

const main = async () => {
  console.log(`archive ${PREFIX}`);
  console.log(`${SRC_BUCKET} -> ${DST_BUCKET}\n`);
  const data = await manifest();
  const keys = [
    ...data.versions.map((v) => ({ key: v.s3_key, size: v.size_bytes })),
    ...data.scenes.filter((s) => s.s3_key).map((s) => ({ key: s.s3_key, size: s.size_bytes })),
    ...data.scenes.filter((s) => s.thumb_s3_key).map((s) => ({ key: s.thumb_s3_key, size: 0 })),
    ...data.scenes.filter((s) => s.collab_s3_key).map((s) => ({ key: s.collab_s3_key, size: 0 })),
    ...data.files.map((f) => ({ key: f.s3_key, size: f.size_bytes })),
    ...data.icons.map((i) => ({ key: i.s3_key, size: 0 })),
    ...data.shared.map((s) => ({ key: s.s3_key, size: 0 })),
  ];
  const unique = [...new Map(keys.map((k) => [k.key, k])).values()];
  console.log(`manifest: ${data.versions.length} restore points, ${data.scenes.length} drawings, ${data.files.length} files`);
  console.log(`objects to archive: ${unique.length}, ${gb(unique.reduce((s, k) => s + Number(k.size), 0))}\n`);

  if (!VERIFY_ONLY) {
    await put(`${PREFIX}/manifest.json`, Buffer.from(JSON.stringify(data)), "application/json");
    console.log("manifest uploaded");
    console.log(`database dump: ${mb(await dump())}`);
    const already = await listArchive();
    if (already.size) console.log(`resuming: ${already.size} objects already present`);
    const serverSide = await canCopyServerSide();
    console.log(
      serverSide
        ? "copying objects server side (no download)…"
        : "copying objects through this host (keys are scoped to one bucket each)…",
    );
    const result = await copyAll(unique, already, serverSide);
    console.log(`\ncopied ${result.copied}, skipped ${result.skipped}, ${gb(result.bytes)} transferred`);
    if (result.failures.length) {
      console.log(`FAILURES: ${result.failures.length}`);
      for (const f of result.failures.slice(0, 10)) console.log("  ", f.key, f.error);
    }
  }
  const ok = await verify(VERIFY_ONLY ? data : await reloadManifest());
  console.log(`\nArchive prefix: ${DST_BUCKET}/${PREFIX}`);
  if (!ok) process.exitCode = 1;
};

main()
  .catch((error) => {
    console.error("archive failed:", error.message);
    process.exitCode = 1;
  })
  .finally(() => db.end());
