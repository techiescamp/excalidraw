import { test } from "node:test";
import assert from "node:assert/strict";

import { identify, plan } from "../bin/prune-backups.mjs";

const stampOf = (date) =>
  date.toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";

// One night's upload, in the shape `backup.mjs` writes it.
const night = (date, { parts = 1, drawingBytes = 500e6 } = {}) => {
  const stamp = stampOf(date);
  const objects = [
    {
      Key: `backups/database/excalidraw-${stamp}.sql.gz`,
      Size: 2e6,
    },
    {
      Key: `backups/database/excalidraw-${stamp}.sql.gz.sha256`,
      Size: 100,
    },
  ];
  if (parts === 1) {
    objects.push({
      Key: `backups/drawings/drawings-${stamp}.tar.gz`,
      Size: drawingBytes,
    });
  } else {
    for (let p = 1; p <= parts; p++)
      objects.push({
        Key: `backups/drawings/drawings-${stamp}.tar.gz.part-${String(
          p,
        ).padStart(3, "0")}`,
        Size: drawingBytes / parts,
      });
  }
  objects.push({
    Key: `backups/drawings/drawings-${stamp}.tar.gz.sha256`,
    Size: 200,
  });
  return objects;
};

const nightsBack = (n, now) =>
  new Date(now.getTime() - n * 86400_000 + 2 * 3600_000);

test("prune-backups", async (t) => {
  const now = new Date("2026-10-29T12:00:00Z");

  await t.test("recognises a backup, and only a backup", () => {
    const stamp = "2026-10-29T02-31-47Z";
    for (const key of [
      `backups/database/excalidraw-${stamp}.sql.gz`,
      `backups/database/excalidraw-${stamp}.sql.gz.sha256`,
      `backups/drawings/drawings-${stamp}.tar.gz`,
      `backups/drawings/drawings-${stamp}.tar.gz.part-004`,
      `backups/drawings/drawings-${stamp}.tar.gz.sha256`,
    ]) {
      const seen = identify(key);
      assert.ok(seen, `${key} should be recognised`);
      assert.equal(seen.stamp, stamp);
    }
    // Every piece of one night is one backup.
    assert.equal(
      identify(`backups/drawings/drawings-${stamp}.tar.gz.part-001`).group,
      identify(`backups/drawings/drawings-${stamp}.tar.gz.sha256`).group,
    );
    // Anything else in the bucket is none of this script's business.
    for (const key of [
      "blobs/5b6020c4/abc123",
      "scenes/abc/def.json",
      "old-server-backup/2024/dump.tar.gz",
      "backups/database/notes.txt",
      "backups/database/excalidraw-not-a-date.sql.gz",
      `backups/elsewhere/drawings-${stamp}.tar.gz`,
    ])
      assert.equal(identify(key), null, `${key} must not be touched`);
  });

  await t.test("keeps everything inside the daily window", () => {
    const objects = [];
    for (let d = 0; d < 10; d++) objects.push(...night(nightsBack(d, now)));
    const { keep, remove } = plan(objects, now, { keepDays: 14 });
    assert.equal(remove.length, 0, "nothing recent should go");
    assert.equal(keep.length, 20, "ten nights, two kinds");
  });

  await t.test("thins to one a week, then one a month, then stops", () => {
    const objects = [];
    for (let d = 0; d < 400; d++) objects.push(...night(nightsBack(d, now)));
    const { keep, remove } = plan(objects, now, {
      keepDays: 14,
      keepWeeks: 8,
      keepMonths: 12,
    });
    const drawings = keep.filter((g) => g.kind === "drawings");
    // 14 daily + 8 weekly + up to 12 monthly, per kind. Far fewer than 400.
    assert.ok(drawings.length >= 14, `kept ${drawings.length}`);
    assert.ok(drawings.length <= 40, `kept too many: ${drawings.length}`);
    assert.ok(remove.length > 600, `should remove most of 800`);

    // Both kinds are counted apart: neither thins the other.
    assert.equal(
      keep.filter((g) => g.kind === "database").length,
      drawings.length,
    );

    // Nothing older than the whole window survives.
    const oldest = keep
      .map((g) => g.taken.getTime())
      .reduce((a, b) => Math.min(a, b));
    const windowDays = 14 + 8 * 7 + 12 * 31;
    assert.ok((now - oldest) / 86400_000 <= windowDays + 31);
  });

  await t.test("never removes the newest of either kind", () => {
    // Everything is far older than any window.
    const objects = [];
    for (let d = 500; d < 505; d++) objects.push(...night(nightsBack(d, now)));
    const { keep, remove } = plan(objects, now, {
      keepDays: 1,
      keepWeeks: 0,
      keepMonths: 0,
    });
    assert.deepEqual(keep.map((g) => g.why).sort(), [
      "newest of its kind",
      "newest of its kind",
    ]);
    assert.equal(keep.length, 2, "one of each kind survives");
    assert.ok(remove.length > 0);
  });

  await t.test("deletes a backup whole, parts and checksum together", () => {
    const objects = [];
    for (let d = 0; d < 200; d++)
      objects.push(...night(nightsBack(d, now), { parts: 4 }));
    const { remove } = plan(objects, now);
    for (const group of remove) {
      const parts = group.keys.filter((k) => /\.part-\d{3}$/.test(k));
      const sums = group.keys.filter((k) => k.endsWith(".sha256"));
      if (group.kind === "drawings") {
        assert.equal(parts.length, 4, `${group.group} must take all its parts`);
      }
      assert.equal(sums.length, 1, `${group.group} must take its checksum`);
    }
  });

  await t.test(
    "reports what is not its own and never plans to delete it",
    () => {
      const objects = [
        ...night(nightsBack(900, now)),
        { Key: "old-server-backup/2024-01-01/mysql.sql.gz", Size: 38e9 },
        { Key: "something-else/photo.jpg", Size: 1e6 },
      ];
      const { remove, foreign } = plan(objects, now);
      assert.deepEqual(foreign.map((o) => o.Key).sort(), [
        "old-server-backup/2024-01-01/mysql.sql.gz",
        "something-else/photo.jpg",
      ]);
      for (const group of remove)
        for (const key of group.keys)
          assert.ok(
            key.startsWith("backups/"),
            `${key} is outside the backup prefix and must not be deleted`,
          );
    },
  );
});
