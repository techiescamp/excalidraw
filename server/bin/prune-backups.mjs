// Retention for the backup bucket.
//
// `backup.mjs` uploads a database dump and a complete archive of every drawing
// each night, and deletes neither: its comment says "the bucket keeps its own
// history", and nothing was ever written to bound that history. One night is
// around half a gigabyte, so the bucket grows by roughly fifteen gigabytes a
// month for as long as it runs. That is the whole of the growth; there is no
// leak to find, only a policy that was never written.
//
// What is kept, newest first:
//
//   every backup from the last KEEP_DAYS days                (default 14)
//   one backup per week for the next KEEP_WEEKS weeks        (default 8)
//   one backup per month for the next KEEP_MONTHS months     (default 12)
//   nothing older
//
// Both kinds — database and drawings — are kept to the same schedule but
// counted separately, so a quiet week in one cannot thin the other.
//
// Three rules it will not break:
//
//   1. It only ever considers objects it can name: under the backup prefix,
//      matching the filenames `backup.mjs` writes. Anything else in the bucket
//      is reported and left alone, because a bucket is allowed to hold things
//      this script knows nothing about.
//   2. A backup is one group — the archive, its `.part-NNN` pieces and its
//      `.sha256`. A group is deleted whole or not at all; half a backup is
//      worse than none, because it still looks like one.
//   3. The newest backup of each kind is never deleted, whatever the dates say.
//
// It prints what it would do and changes nothing unless given `--apply`.
import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";

const PREFIX = process.env.BACKUP_PREFIX || "backups";
const BUCKET = process.env.BACKUP_BUCKET || process.env.S3_BUCKET;
const KEEP_DAYS = Number(process.env.BACKUP_KEEP_DAYS_REMOTE) || 14;
const KEEP_WEEKS = Number(process.env.BACKUP_KEEP_WEEKS) || 8;
const KEEP_MONTHS = Number(process.env.BACKUP_KEEP_MONTHS) || 12;

/**
 * Splits a key into the backup it belongs to.
 *
 * `backups/drawings/drawings-2026-10-29T02-31-47Z.tar.gz.part-002` and its
 * `.sha256` and the archive itself are all one backup, taken at one moment.
 * Returns null for anything that is not one of ours.
 */
export const identify = (key, prefix = PREFIX) => {
  const match = new RegExp(
    `^${prefix}/(database|drawings)/` +
      `(excalidraw|drawings)-(\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}Z)` +
      `\\.(?:sql|tar)\\.gz(?:\\.part-\\d{3})?(?:\\.sha256)?$`,
  ).exec(key);
  if (!match) return null;
  const [, kind, , stamp] = match;
  // The stamp is an ISO instant with the punctuation replaced; put it back so
  // it can be compared as a date rather than as text.
  const iso = `${stamp.slice(0, 10)}T${stamp
    .slice(11, 19)
    .replace(/-/g, ":")}Z`;
  const taken = new Date(iso);
  if (Number.isNaN(taken.getTime())) return null;
  return { kind, stamp, taken, group: `${kind}/${stamp}` };
};

const startOfWeek = (date) => {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  // Monday as the first day, so a week is a week rather than a rolling seven.
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};

/**
 * Decides what to keep. Pure, so the policy can be tested without a bucket.
 *
 * Returns the groups to keep, the groups to delete with the reason, and the
 * keys that are none of this script's business.
 */
export const plan = (objects, now = new Date(), policy = {}) => {
  const keepDays = policy.keepDays ?? KEEP_DAYS;
  const keepWeeks = policy.keepWeeks ?? KEEP_WEEKS;
  const keepMonths = policy.keepMonths ?? KEEP_MONTHS;
  const prefix = policy.prefix ?? PREFIX;

  const groups = new Map();
  const foreign = [];
  for (const object of objects) {
    const seen = identify(object.Key, prefix);
    if (!seen) {
      foreign.push(object);
      continue;
    }
    const group = groups.get(seen.group) || {
      ...seen,
      keys: [],
      bytes: 0,
    };
    group.keys.push(object.Key);
    group.bytes += object.Size || 0;
    groups.set(seen.group, group);
  }

  const keep = [];
  const remove = [];
  for (const kind of ["database", "drawings"]) {
    const mine = [...groups.values()]
      .filter((g) => g.kind === kind)
      .sort((a, b) => b.taken - a.taken);
    const weeksTaken = new Set();
    const monthsTaken = new Set();
    mine.forEach((group, index) => {
      const ageDays = (now - group.taken) / 86400_000;
      const week = startOfWeek(group.taken);
      const month = group.stamp.slice(0, 7);
      let why = null;
      if (index === 0) {
        why = "newest of its kind";
      } else if (ageDays <= keepDays) {
        why = `within the last ${keepDays} days`;
      } else if (ageDays <= keepDays + keepWeeks * 7 && !weeksTaken.has(week)) {
        why = `one per week, week of ${week}`;
      } else if (
        ageDays <= keepDays + keepWeeks * 7 + keepMonths * 31 &&
        !monthsTaken.has(month)
      ) {
        why = `one per month, ${month}`;
      }
      if (why) {
        weeksTaken.add(week);
        monthsTaken.add(month);
        keep.push({ ...group, why });
      } else {
        remove.push({
          ...group,
          why: `${Math.round(ageDays)} days old, already covered`,
        });
      }
    });
  }
  return { keep, remove, foreign };
};

const gb = (n) => `${(n / 1024 ** 3).toFixed(2)} GB`;

const main = async () => {
  const apply = process.argv.includes("--apply");
  if (!BUCKET) throw new Error("BACKUP_BUCKET or S3_BUCKET must be set");
  const s3 = new S3Client({
    region: process.env.AWS_REGION,
    ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT } : {}),
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });

  // Names, not secrets: which bucket, which endpoint, which region, and
  // whether a key is present at all. Enough to see a mismatch without
  // printing anything that must not be printed.
  console.log(
    `using endpoint=${process.env.S3_ENDPOINT || "(default aws)"} ` +
      `region=${process.env.AWS_REGION || "(unset)"} ` +
      `bucket=${BUCKET} ` +
      `key=${process.env.AWS_ACCESS_KEY_ID ? "set, " + process.env.AWS_ACCESS_KEY_ID.length + " chars" : "UNSET"} ` +
      `secret=${process.env.AWS_SECRET_ACCESS_KEY ? "set" : "UNSET"} ` +
      `backup_bucket=${process.env.BACKUP_BUCKET || "(unset)"} ` +
      `s3_bucket=${process.env.S3_BUCKET || "(unset)"}`,
  );

  const objects = [];
  let token;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        ContinuationToken: token,
        MaxKeys: 1000,
      }),
    );
    objects.push(...(page.Contents || []));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);

  const { keep, remove, foreign } = plan(objects, new Date());
  const kept = keep.reduce((n, g) => n + g.bytes, 0);
  const freed = remove.reduce((n, g) => n + g.bytes, 0);
  const other = foreign.reduce((n, o) => n + (o.Size || 0), 0);

  console.log(`bucket ${BUCKET}, prefix ${PREFIX}/`);
  console.log(
    `  keeping  ${String(keep.length).padStart(4)} backups  ${gb(kept)}`,
  );
  console.log(
    `  removing ${String(remove.length).padStart(4)} backups  ${gb(freed)}`,
  );
  console.log(
    `  not mine ${String(foreign.length).padStart(4)} objects  ${gb(
      other,
    )}  (left alone)`,
  );
  if (foreign.length) {
    // Grouped so whoever reads this can see what else is in the bucket and
    // decide what to do about it. This script will not delete any of it.
    const byPrefix = new Map();
    for (const object of foreign) {
      const top = object.Key.split("/").slice(0, 2).join("/") || "(root)";
      const cur = byPrefix.get(top) || {
        bytes: 0,
        n: 0,
        first: "9999",
        last: "",
      };
      cur.bytes += object.Size || 0;
      cur.n++;
      const when = (object.LastModified || new Date())
        .toISOString()
        .slice(0, 10);
      if (when < cur.first) cur.first = when;
      if (when > cur.last) cur.last = when;
      byPrefix.set(top, cur);
    }
    console.log("  what else is in this bucket:");
    for (const [top, v] of [...byPrefix]
      .sort((a, b) => b[1].bytes - a[1].bytes)
      .slice(0, 15))
      console.log(
        `    ${gb(v.bytes).padStart(10)} ${String(v.n).padStart(6)} obj  ${
          v.first
        }..${v.last}  ${top}`,
      );
  }
  for (const group of remove.slice(0, 10))
    console.log(`    - ${group.group}  ${gb(group.bytes)}  ${group.why}`);
  if (remove.length > 10) console.log(`    … and ${remove.length - 10} more`);

  if (!apply) {
    console.log("\nnothing was deleted. Run again with --apply to do it.");
    return;
  }
  // Deleted a backup at a time, every piece of it together, so an interruption
  // leaves whole backups behind rather than a half of one.
  let done = 0;
  for (const group of remove) {
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: BUCKET,
        Delete: { Objects: group.keys.map((Key) => ({ Key })), Quiet: true },
      }),
    );
    done += group.bytes;
  }
  console.log(`\ndeleted ${remove.length} backups, freed ${gb(done)}`);
};

if (
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].split("/").pop())
) {
  main().catch((error) => {
    // The SDK's message is often just "UnknownError"; the name, the HTTP
    // status and the service's own code are what actually say what happened.
    console.error(
      `prune-backups: ${error.name || "error"}: ${error.message}` +
        (error.$metadata?.httpStatusCode
          ? ` [http ${error.$metadata.httpStatusCode}]`
          : "") +
        (error.Code ? ` [code ${error.Code}]` : "") +
        (error.BucketName ? ` [bucket ${error.BucketName}]` : ""),
    );
    process.exit(1);
  });
}
