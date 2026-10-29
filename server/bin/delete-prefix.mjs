// Deletes one named prefix from a bucket, after showing what it would delete.
//
//   node bin/delete-prefix.mjs archive/2026-10-08T06-32-56Z
//   node bin/delete-prefix.mjs archive/2026-10-08T06-32-56Z --apply
//
// Written for one-off clearances — an archive taken before a prune, kept while
// it might be needed and then not needed. `prune-backups.mjs` deliberately
// refuses to touch anything that is not a backup it recognises, which is
// right; this is the deliberate, named exception, and it is separate so that
// deleting something by name is always a decision somebody made on purpose.
//
// It will not take a prefix that is empty, that is the whole bucket, or that
// is the nightly backups: those are not one-off clearances and must not be
// removed by a tool whose whole argument is "I meant this one".
import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";

const prefix = process.argv[2];
const apply = process.argv.includes("--apply");
const BUCKET = process.env.BACKUP_BUCKET || process.env.S3_BUCKET;

const refuse = (why) => {
  console.error(`delete-prefix: ${why}`);
  process.exit(1);
};

if (!prefix || prefix.startsWith("-")) {
  refuse("usage: delete-prefix.mjs <prefix> [--apply]");
}
if (!BUCKET) refuse("BACKUP_BUCKET or S3_BUCKET must be set");
if (prefix === "/" || prefix === "*" || prefix.length < 4) {
  refuse(`"${prefix}" is too broad to be something anybody meant`);
}
if (
  /^backups\/?$/.test(prefix) ||
  /^backups\/(database|drawings)\/?$/.test(prefix)
) {
  refuse(
    "the nightly backups are not a one-off clearance; prune-backups.mjs keeps them to a policy",
  );
}

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT } : {}),
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const gb = (n) => `${(n / 1024 ** 3).toFixed(2)} GB`;
const keys = [];
let bytes = 0;
let token;
do {
  const page = await s3.send(
    new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: prefix,
      ContinuationToken: token,
      MaxKeys: 1000,
    }),
  );
  for (const object of page.Contents || []) {
    keys.push(object.Key);
    bytes += object.Size || 0;
  }
  token = page.IsTruncated ? page.NextContinuationToken : undefined;
} while (token);

console.log(`bucket ${BUCKET}, prefix ${prefix}`);
console.log(`  ${keys.length} objects, ${gb(bytes)}`);
for (const key of keys.slice(0, 5)) console.log(`    ${key}`);
if (keys.length > 5) console.log(`    … and ${keys.length - 5} more`);

if (!keys.length) {
  console.log("nothing there.");
  process.exit(0);
}
if (!apply) {
  console.log("\nnothing was deleted. Run again with --apply to do it.");
  process.exit(0);
}

let done = 0;
for (let i = 0; i < keys.length; i += 1000) {
  const batch = keys.slice(i, i + 1000);
  await s3.send(
    new DeleteObjectsCommand({
      Bucket: BUCKET,
      Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
    }),
  );
  done += batch.length;
  console.log(`  deleted ${done}/${keys.length}`);
}
console.log(`\ndeleted ${done} objects, freed ${gb(bytes)}`);
