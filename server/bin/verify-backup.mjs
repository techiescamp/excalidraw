// Checks that the newest backup in the bucket is a backup, not just bytes.
//
//   node bin/verify-backup.mjs
//
// `backup.mjs` checksums each piece as it uploads and reads it back, which
// proves the bytes arrived. It does not prove the dump decompresses, that it
// contains the tables a restore needs, or that the drawings archive holds the
// drawings. Those are the things that matter on the day somebody needs it, and
// nothing checked them until this.
//
// Downloads nothing permanently and changes nothing in the bucket.
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";

const PREFIX = process.env.BACKUP_PREFIX || "backups";
const BUCKET = process.env.BACKUP_BUCKET || process.env.S3_BUCKET;
// Every table a restore would be useless without.
const REQUIRED_TABLES = [
  "users",
  "workspaces",
  "scenes",
  "collections",
  "workspace_members",
];

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT } : {}),
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const run = (command, args) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => resolve({ code, out, err }));
  });

const list = async (prefix) => {
  const objects = [];
  let token;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: prefix,
        ContinuationToken: token,
      }),
    );
    objects.push(...(page.Contents || []));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return objects;
};

const get = async (key) => {
  const object = await s3.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: key }),
  );
  return Buffer.from(await object.Body.transformToByteArray());
};

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const problems = [];
const ok = (what) => console.log(`  ok    ${what}`);
const bad = (what) => {
  console.log(`  FAIL  ${what}`);
  problems.push(what);
};

// The newest backup of a kind, with every piece that belongs to it.
const newest = (objects, kind) => {
  const stamps = new Map();
  for (const object of objects) {
    const match = /-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)\./.exec(object.Key);
    if (!match) continue;
    const group = stamps.get(match[1]) || [];
    group.push(object);
    stamps.set(match[1], group);
  }
  const latest = [...stamps.keys()].sort().pop();
  return latest ? { stamp: latest, objects: stamps.get(latest), kind } : null;
};

// Puts a backup back together from its pieces and checks it against the
// checksums that were written beside it.
const assemble = async (backup, work) => {
  const sums = backup.objects.find((o) => o.Key.endsWith(".sha256"));
  const pieces = backup.objects
    .filter((o) => !o.Key.endsWith(".sha256"))
    .sort((a, b) => a.Key.localeCompare(b.Key));
  if (!sums) {
    bad(`${backup.kind} ${backup.stamp} has no .sha256 beside it`);
    return null;
  }
  const expected = new Map(
    (await get(sums.Key))
      .toString()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [digest, name] = line.trim().split(/\s+/);
        return [name, digest];
      }),
  );
  const bodies = [];
  for (const piece of pieces) {
    const body = await get(piece.Key);
    const digest = crypto.createHash("sha256").update(body).digest("hex");
    const name = path.basename(piece.Key);
    if (!expected.has(name)) bad(`${name} is not listed in the checksum file`);
    else if (expected.get(name) !== digest)
      bad(`${name} does not match its checksum`);
    bodies.push(body);
  }
  if (pieces.length > 1)
    ok(`${backup.kind}: ${pieces.length} parts reassembled`);
  const file = path.join(work, `${backup.kind}.gz`);
  await writeFile(file, Buffer.concat(bodies));
  return file;
};

const main = async () => {
  if (!BUCKET) throw new Error("BACKUP_BUCKET or S3_BUCKET must be set");
  const work = await mkdtemp(path.join(tmpdir(), "verify-backup-"));
  try {
    const database = newest(await list(`${PREFIX}/database/`), "database");
    const drawings = newest(await list(`${PREFIX}/drawings/`), "drawings");
    if (!database) bad("there is no database backup at all");
    if (!drawings) bad("there is no drawings backup at all");

    for (const backup of [database, drawings].filter(Boolean)) {
      const age =
        (Date.now() -
          new Date(
            `${backup.stamp.slice(0, 10)}T${backup.stamp
              .slice(11, 19)
              .replace(/-/g, ":")}Z`,
          )) /
        3600_000;
      console.log(
        `\n${backup.kind}: newest is ${backup.stamp} (${age.toFixed(
          1,
        )} hours old)`,
      );
      // A backup that stopped a week ago still looks like a backup until
      // somebody asks how old it is.
      if (age > 48)
        bad(`${backup.kind} backup is ${Math.round(age / 24)} days old`);
      else ok(`${backup.kind} is recent`);

      const file = await assemble(backup, work);
      if (!file) continue;
      ok(`${backup.kind}: every piece matches its checksum`);

      const test = await run("gzip", ["-t", file]);
      if (test.code !== 0) {
        bad(`${backup.kind}: the archive does not decompress`);
        continue;
      }
      ok(`${backup.kind}: decompresses (${mb((await stat(file)).size)})`);

      if (backup.kind === "database") {
        // Read the dump itself and look for the tables a restore needs.
        const dump = await run("sh", [
          "-c",
          `gzip -dc ${JSON.stringify(file)} | grep -c '^CREATE TABLE'`,
        ]);
        const tables = Number(dump.out.trim()) || 0;
        if (tables < 10) bad(`the dump defines only ${tables} tables`);
        else ok(`the dump defines ${tables} tables`);
        for (const table of REQUIRED_TABLES) {
          const found = await run("sh", [
            "-c",
            `gzip -dc ${JSON.stringify(
              file,
            )} | grep -c '^CREATE TABLE public.${table} '`,
          ]);
          if (Number(found.out.trim()) > 0) ok(`table ${table} is in the dump`);
          else bad(`table ${table} is MISSING from the dump`);
        }
        const copies = await run("sh", [
          "-c",
          `gzip -dc ${JSON.stringify(file)} | grep -c '^COPY public.'`,
        ]);
        if (Number(copies.out.trim()) > 0)
          ok(`the dump carries data for ${copies.out.trim()} tables`);
        else bad("the dump has no data in it, only a schema");
      } else {
        const listing = await run("tar", ["-tzf", file]);
        if (listing.code !== 0) {
          bad("the drawings archive cannot be read");
          continue;
        }
        const entries = listing.out.split("\n").filter(Boolean);
        ok(`the drawings archive holds ${entries.length} entries`);
        if (!entries.some((e) => e.endsWith("index.json")))
          bad("the drawings archive has no index.json");
        else ok("index.json is present");
        const index = await run("sh", [
          "-c",
          `tar -xzOf ${JSON.stringify(
            file,
          )} ./index.json 2>/dev/null | head -c 2000000`,
        ]);
        try {
          const parsed = JSON.parse(index.out);
          if (!Array.isArray(parsed) || parsed.length === 0)
            bad("index.json lists no drawings");
          else ok(`index.json lists ${parsed.length} drawings`);
        } catch {
          bad("index.json is not readable JSON");
        }
      }
    }

    console.log(
      problems.length
        ? `\nNOT HEALTHY: ${problems.length} problem(s)\n` +
            problems.map((p) => `  - ${p}`).join("\n")
        : "\nHEALTHY: the newest backup is recent, complete, and restorable.",
    );
    process.exitCode = problems.length ? 1 : 0;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
};

main().catch((error) => {
  console.error(
    `verify-backup: ${error.name || "error"}: ${error.message}` +
      (error.$metadata?.httpStatusCode
        ? ` [http ${error.$metadata.httpStatusCode}]`
        : ""),
  );
  process.exit(1);
});
