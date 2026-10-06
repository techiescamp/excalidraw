// Scheduled backup: database every run, drawing files weekly.
// Everything lands compressed in the bucket under backups/ and a copy of the
// database dump stays on the droplet. Run by excalidraw-backup.timer.
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const LOCAL_DIR = process.env.BACKUP_DIR || "/opt/excalidraw/backups";
const KEEP_LOCAL_DAYS = Number(process.env.BACKUP_KEEP_DAYS) || 14;
const PREFIX = process.env.BACKUP_PREFIX || "backups";
// Backups are written to their own Space; drawings are read from the app's bucket.
const TARGET_BUCKET = process.env.BACKUP_BUCKET || process.env.S3_BUCKET;
const SOURCE_BUCKET = process.env.SOURCE_BUCKET || process.env.S3_BUCKET;
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";
const weekly =
  process.env.BACKUP_SCOPE === "full" || new Date().getUTCDay() === 0;

const run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let error = "";
    child.stderr.on("data", (chunk) => (error += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code
        ? reject(new Error(`${command} failed: ${error.trim().slice(0, 300)}`))
        : resolve(),
    );
    if (options.pipeTo) child.stdout.pipe(options.pipeTo);
  });

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  ...(process.env.S3_ENDPOINT
    ? {
        endpoint: process.env.S3_ENDPOINT,
        forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
      }
    : {}),
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});
// Spaces rejects the SDK's chunked streaming uploads, so bodies go up as plain
// buffers. Anything large is split into parts that restore with `cat part-* >`.
const PART_BYTES = 128 * 1024 * 1024;
const upload = async (key, file, contentType) => {
  const { size } = await stat(file);
  const put = (suffix, body) =>
    s3.send(
      new PutObjectCommand({
        Bucket: TARGET_BUCKET,
        Key: key + suffix,
        Body: body,
        ContentType: contentType,
      }),
    );
  if (size <= PART_BYTES) {
    await put("", await readFile(file));
    return size;
  }
  let part = 0;
  for (let offset = 0; offset < size; offset += PART_BYTES) {
    const chunk = [];
    for await (const piece of createReadStream(file, {
      start: offset,
      end: Math.min(offset + PART_BYTES, size) - 1,
    }))
      chunk.push(piece);
    await put(`.part-${String(++part).padStart(3, "0")}`, Buffer.concat(chunk));
  }
  console.log(`uploaded in ${part} parts`);
  return size;
};
// Reading the app's bucket and writing the backup Space can use different keys.
const sourceS3 = new S3Client({
  region: process.env.SOURCE_REGION || process.env.AWS_REGION,
  endpoint: process.env.SOURCE_ENDPOINT || process.env.S3_ENDPOINT,
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  credentials: {
    accessKeyId:
      process.env.SOURCE_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey:
      process.env.SOURCE_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY,
  },
});
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function backupDatabase() {
  await mkdir(LOCAL_DIR, { recursive: true });
  const file = path.join(LOCAL_DIR, `excalidraw-${stamp}.sql.gz`);
  const gzip = spawn("gzip", ["-9"], { stdio: ["pipe", "pipe", "inherit"] });
  const out = (await import("node:fs")).createWriteStream(file);
  gzip.stdout.pipe(out);
  await run("pg_dump", [process.env.DATABASE_URL], { pipeTo: gzip.stdin });
  gzip.stdin.end();
  await new Promise((resolve, reject) => {
    out.on("finish", resolve);
    out.on("error", reject);
  });
  const size = await upload(
    `${PREFIX}/database/excalidraw-${stamp}.sql.gz`,
    file,
    "application/gzip",
  );
  console.log(`database backup ${mb(size)} -> ${PREFIX}/database/`);
  // Local copies are pruned; the bucket keeps its own history.
  const cutoff = Date.now() - KEEP_LOCAL_DAYS * 86400_000;
  for (const name of await readdir(LOCAL_DIR)) {
    if (!/^excalidraw-.*\.sql\.gz$/.test(name)) continue;
    const full = path.join(LOCAL_DIR, name);
    if ((await stat(full)).mtimeMs < cutoff) await rm(full, { force: true });
  }
}

// Current drawings and their images, as one compressed archive. Old versions are
// deliberately skipped: they are history, not data you would restore.
async function backupDrawings() {
  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const work = await mkdtemp(path.join(tmpdir(), "excalidraw-backup-"));
  try {
    const { rows } = await db.query(
      `SELECT s.id,s.name,s.s3_key FROM scenes s WHERE s.deleted_at IS NULL AND s.s3_key IS NOT NULL
       UNION ALL SELECT f.scene_id,f.file_id,f.s3_key FROM scene_files f
       JOIN scenes s ON s.id=f.scene_id WHERE s.deleted_at IS NULL`,
    );
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const index = [];
    let copied = 0;
    for (const row of rows) {
      try {
        const object = await sourceS3.send(
          new GetObjectCommand({
            Bucket: SOURCE_BUCKET,
            Key: row.s3_key,
          }),
        );
        const body = Buffer.from(await object.Body.transformToByteArray());
        const safe = row.s3_key.replace(/[^A-Za-z0-9._/-]/g, "_");
        await mkdir(path.join(work, path.dirname(safe)), { recursive: true });
        await writeFile(path.join(work, safe), body);
        index.push({
          id: row.id,
          name: row.name,
          key: row.s3_key,
          bytes: body.length,
        });
        copied += body.length;
      } catch (error) {
        console.error(`skipped ${row.s3_key}: ${error.message}`);
      }
    }
    await writeFile(
      path.join(work, "index.json"),
      JSON.stringify(index, null, 1),
    );
    const archive = path.join(LOCAL_DIR, `drawings-${stamp}.tar.gz`);
    await run("tar", ["-czf", archive, "-C", work, "."]);
    const size = await upload(
      `${PREFIX}/drawings/drawings-${stamp}.tar.gz`,
      archive,
      "application/gzip",
    );
    await rm(archive, { force: true });
    console.log(
      `drawings backup ${index.length} files, ${mb(copied)} raw -> ${mb(
        size,
      )} archive`,
    );
  } finally {
    await rm(work, { recursive: true, force: true });
    await db.end();
  }
}

try {
  await backupDatabase();
  if (weekly) await backupDrawings();
  else console.log("drawings archive runs on Sundays");
  console.log("backup complete");
} catch (error) {
  console.error("backup failed:", error.message);
  process.exitCode = 1;
}
