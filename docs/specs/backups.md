# Backups

What is backed up, what is wrong with it today, and what each fix is.

## What runs now

`excalidraw-backup.timer` fires `backup.mjs` nightly at 02:30 UTC on the
production droplet, as the `excalidraw` user, reading `/etc/excalidraw-api.env`.

Each run writes, into the `backups-draw` Space:

| object | what it is |
|---|---|
| `backups/database/excalidraw-<stamp>.sql.gz` | `pg_dump` of the whole database — users, workspaces, collections, drawing metadata, icons |
| `backups/drawings/drawings-<stamp>.tar.gz` | every current drawing's scene JSON and images, pulled from the `excalidraw-data` Space, plus an `index.json` |
| `…​.part-NNN` | the same archive split at 128 MB, because Spaces refuses the SDK's streaming uploads |
| `…​.sha256` | the checksum of each piece |

Every piece is checksummed on the way up and **read back** and compared before
the run reports success. A dump also stays on the droplet under
`/opt/excalidraw/backups` for 14 days.

Observed on 2026-10-29: database 2.0 MB, drawings 4077 files, 531.5 MB raw,
493.3 MB compressed, 4 parts, all verified.

It is PostgreSQL, not MySQL. A restore uses `pg_restore`/`psql`.

## Problem 1 — the bucket has no retention

`backup.mjs` prunes the local copies after 14 days and deletes nothing from the
bucket. Its own comment says so: *"Local copies are pruned; the bucket keeps its
own history."* Nothing was ever written to bound that history.

A full archive of every drawing goes up every night, so the bucket grows by
about 15 GB a month for as long as the timer runs. At roughly 90 nights that is
the ~45 GB now in `backups-draw`. There is no leak; there is a policy that was
never written.

**Fix:** `server/bin/prune-backups.mjs`.

Keeps, newest first: every backup from the last 14 days, then one a week for 8
weeks, then one a month for 12 months, then nothing. Database and drawings are
counted apart, so a gap in one cannot thin the other. Tunable with
`BACKUP_KEEP_DAYS_REMOTE`, `BACKUP_KEEP_WEEKS`, `BACKUP_KEEP_MONTHS`.

Three rules it will not break:

1. It only considers objects it can name — under the backup prefix, matching
   the filenames `backup.mjs` writes. Everything else in the bucket is counted,
   reported and left alone.
2. A backup is the archive, its `.part-NNN` pieces and its `.sha256`, deleted
   whole or not at all. Half a backup is worse than none, because it still
   looks like one.
3. The newest backup of each kind is never deleted, whatever the dates say.

Dry run by default; `--apply` deletes. Against 90 nights at the sizes
production reported: 41.5 GB now, 11.1 GB kept, 30.4 GB freed.

Run it on the droplet, so the credentials stay there:

```bash
sudo systemd-run --wait --pipe --collect \
  -p User=excalidraw -p WorkingDirectory=/opt/excalidraw/api \
  -p EnvironmentFile=/etc/excalidraw-api.env \
  /usr/bin/node /opt/excalidraw/api/bin/prune-backups.mjs
```

## Problem 2 — the bucket also held a one-off archive (settled)

The other ~36 GB was `archive/2026-10-08T06-32-56Z`: 17,192 objects written by
`archive-versions.mjs` as a point-in-time copy before a prune of drawing
version history, kept so that prune could be undone. The database still holds
restore points from 2026-09-14 onward, so the archive covered history older
than that and nothing else.

Deleted on 2026-10-29 on the owner's decision, with
`server/bin/delete-prefix.mjs`, which takes one named prefix, shows what it
would remove, and refuses a prefix that is empty, the whole bucket, or the
nightly backups.

The bucket went from ~46 GB to **7.23 GB**: 3.25 GB of backups beyond the
policy, and 35.77 GB of that archive.

## Problem 2a — the service reads an environment file the repository does not have

`excalidraw-backup.service` on the droplet loads **two** environment files:

    EnvironmentFile=/etc/excalidraw-api.env
    EnvironmentFile=/etc/excalidraw-backup.env

The unit in `server/deploy/` has only the first. The second holds the backup
bucket and its credentials: without it the storage settings are the app's, the
bucket resolves to `excalidraw-data` rather than `backups-draw`, and the key is
rejected. Anything run by hand must pass both files or it will fail in a way
that looks like broken credentials.

**Fix, not done:** bring `server/deploy/excalidraw-backup.service` in line with
the droplet, so a deploy cannot overwrite the unit and silently cut the backup
off from its bucket.

## Problem 3 — a backup was never read back, so nobody knew it restores

Checksums prove the bytes arrived. They do not prove the dump decompresses,
that it holds the tables a restore needs, or that the drawings archive holds
drawings.

**Fix:** `server/bin/verify-backup.mjs`. It takes the newest backup of each
kind, reassembles it from its parts, checks every piece against the checksum
written beside it, decompresses it, and then looks inside: the dump must define
a sensible number of tables, must contain `users`, `workspaces`, `scenes`,
`collections` and `workspace_members`, and must carry data and not only a
schema; the drawings archive must list, hold an `index.json`, and that index
must name drawings. It also fails if the newest backup is more than 48 hours
old. It downloads nothing permanently and changes nothing.

First run, 2026-10-29, against the backup taken that morning:

    database: newest is 2026-10-29T02-31-47Z (10.9 hours old)
      ok  every piece matches its checksum
      ok  decompresses (2.0 MB)
      ok  the dump defines 39 tables
      ok  tables users, workspaces, scenes, collections, workspace_members present
      ok  the dump carries data for 39 tables
    drawings: newest is 2026-10-29T02-31-47Z (10.9 hours old)
      ok  4 parts reassembled, every piece matches its checksum
      ok  decompresses (493.3 MB)
      ok  5953 entries, index.json lists 4077 drawings
    HEALTHY

**Still not done:** an actual restore into a scratch database. This reads the
dump; it does not load it. That is the last step to a backup nobody has to
hope about.

## Problem 4 — a failure is silent

If the timer stops, the key lapses, or the disk fills, nothing says so. The
alerts named in `DEVELOPMENT.md` §7b were never built. A backup that silently
stopped three weeks ago looks exactly like one that is working.

**Fix, not built:** `backup.mjs` already has a Discord webhook available in its
environment. Report success and failure to it, and add a check that fails when
the newest object in `backups/database/` is more than 48 hours old.

## Problem 5 — the archive is full every night

Every drawing is re-uploaded whether it changed or not: 4077 files, 531 MB, to
capture whatever changed that day. Retention makes this affordable rather than
unbounded, but it is still the reason a night costs half a gigabyte.

**Fix, not built, lower priority:** keep an index of each drawing's `s3_key` and
digest, upload only what changed, and write a weekly full archive as the base.

## What is verified

`server/test/prune-backups.test.js`, 7 tests over the policy as a pure function
— no bucket needed: the daily window, the weekly and monthly thinning, the floor
under the newest of each kind, that every part and checksum of a pruned night
goes with it, and that objects outside the backup prefix never appear in the
plan. Full server suite 71 passing.

Not verified: the script has never run against the real bucket, because that
needs production access. Its first real run must be the dry run.

## Rollback

`prune-backups.mjs` is a separate script that nothing calls automatically.
Deleting it changes nothing. A deletion it has already made cannot be undone —
which is why it is dry run by default and why the listing is read first.
