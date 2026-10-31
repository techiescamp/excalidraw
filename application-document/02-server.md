# Server blueprint

The machine, the accounts on it, what runs there, how traffic reaches it, how a release gets installed, and how to rebuild the whole thing if it is lost.

Last updated: 31 October 2026, running release `v5.3.0`.

Facts here come from the repository, the deploy pipeline, and `deploy.md`, which records the install exactly as it was performed. Where something could have drifted on the live machine since, it is marked **check on the host**.

---

## 1. The machine

|  |  |
| --- | --- |
| Provider | DigitalOcean droplet, region BLR1 |
| Name | `excalidraw-server` |
| Address | `139.59.41.208` |
| Size | 2 vCPU, 4 GB RAM (plus a swap file, required at 4 GB) |
| Operating system | Ubuntu 24.04 LTS |
| Domain | `draw.devopsproject.dev` |
| TLS | Let's Encrypt, issued and renewed by certbot |
| Object storage | DigitalOcean Spaces, bucket `excalidraw-data`, region `sfo3` |
| Database | PostgreSQL 16, on the same machine |

One machine runs everything: web server, application, database. There is no second server and no staging environment.

---

## 2. Accounts on the server

| Account | Why it exists | Shell | Sudo |
| --- | --- | --- | --- |
| `deploy` | People log in as this | yes | full |
| `ci-deploy` | GitHub Actions logs in as this | yes | should be limited to one command |
| `excalidraw` | The application runs as this | no (`nologin`) | none |
| `postgres` | The database runs as this | system account | none |
| `root` | — | SSH login **disabled on purpose** | — |

Login is by SSH key only; passwords are not accepted. The `deploy` account carries the keys of the people who maintain the system.

`server/deploy/ci-deploy.sudoers` exists so that the CI account may run exactly one root command — the deploy script — and nothing else. **Check on the host:** the last survey found the CI account still holding full passwordless root. Until that file is applied, a leaked deploy key is a leaked machine. This is the single most valuable thing to fix on this list.

---

## 3. Where everything lives

```
/opt/excalidraw
├── api/                 the Node application (server.js, lib/, bin/, node_modules)
├── dashboard/           the static dashboard the API serves
├── app/
│   ├── releases/vX.Y.Z/ one directory per installed editor build
│   └── current →        symlink to the release being served
├── storage/             local object storage, used when Spaces is not configured
├── backups/             nightly database dumps, and one dump per deploy
└── .last-release        what to go back to if a deploy fails
```

Configuration lives outside that tree, in `/etc/excalidraw-api.env`, readable only by root and the service account.

---

## 4. What runs

| Unit | What it does |
| --- | --- |
| `excalidraw-api.service` | The application. `node server.js`, listening on `127.0.0.1:4000`, restarted automatically if it dies |
| `nginx` | TLS on 443, serves the editor files, proxies everything else to port 4000 |
| `postgresql` | The database, tuned for 4 GB of RAM |
| `excalidraw-backup.timer` | Fires the nightly backup at 03:15 UTC |
| `certbot.timer` | Renews the certificate |

Live collaboration is **not** a separate service. It is socket.io inside the same API process. An older `excalidraw-room` service is no longer used.

Useful commands on the host:

```bash
systemctl status excalidraw-api
journalctl -u excalidraw-api -n 200 --no-pager
sudo -u postgres psql -d excalidraw -c "select count(*) from scenes;"
systemctl list-timers | grep excalidraw
```

---

## 5. How traffic flows

```
    person's browser
          │  https://draw.devopsproject.dev
          ▼
    DNS  →  139.59.41.208
          │
          ▼
┌─────────────────────────────────────────────────────────────┐
│ nginx  :80 → redirects to :443        :443 TLS              │
│                                                             │
│  /editor                 → /opt/excalidraw/app/current      │
│  /assets/  /fonts/       → same, cached for a year          │
│  sw.js, manifest, icons  → same                             │
│  /socket.io/             → 127.0.0.1:4000  (1 hour timeout) │
│  everything else         → 127.0.0.1:4000  (60s timeout)    │
└──────────────────────────────┬──────────────────────────────┘
                               ▼
                 ┌─────────────────────────────┐
                 │ API  (node, port 4000)      │
                 │  login, dashboard, admin,   │
                 │  drawings, icons, collab    │
                 └───────┬──────────────┬──────┘
                         │              │
                 PostgreSQL          DigitalOcean Spaces
                 (who, what,         (image bytes, snapshots,
                  permissions)        thumbnails, backups)
```

So: the editor's own files come off the disk through nginx; everything that needs a decision — who you are, what you may open, what the drawing contains — goes to the API. Uploads are capped at 25 MB, except workspace archive imports, which are allowed 100 MB.

---

## 6. Ports and the firewall

| Port | Open to | For |
| --- | --- | --- |
| 22 | should be: the maintainers and GitHub Actions | SSH |
| 80 | everyone | redirect to 443 |
| 443 | everyone | the site |
| 4000 | localhost only | the API, never exposed directly |
| 5432 | localhost only | PostgreSQL |

UFW is enabled on the host, with the OpenSSH rule added before it was turned on.

**Check on the host:** a survey found the droplet also attached to a cloud firewall named `test-firewall` that allows **all TCP from anywhere**, port 22 included. A cloud firewall sits in front of UFW. That should be replaced with a rule set that opens 80 and 443 to the world and 22 to known addresses only.

---

## 7. Configuration and secrets

`/etc/excalidraw-api.env` holds the application's settings. The names, never the values:

```
DATABASE_URL            where PostgreSQL is
JWT_SECRET              signs sessions
APP_ORIGIN              https://draw.devopsproject.dev — also the CSRF check
PORT                    4000
COOKIE_SECURE           true
SESSION_HOURS           how long a session lasts
S3_BUCKET  S3_ENDPOINT  AWS_REGION   object storage
AWS_ACCESS_KEY_ID  AWS_SECRET_ACCESS_KEY
LOCAL_STORAGE_ROOT      used when no Spaces key is present
PRESIGN_TTL_SECONDS     life of a signed upload or download link
ICON_LIBRARY_MAX_BYTES  size cap for the icon library
BLOB_CACHE_BYTES  BLOB_FETCH_CONCURRENCY  CANVAS_DISK_CACHE_*   caching
VERSION_WINDOW_SECONDS  how often a new version row is kept
PASSWORD_BLOCKLIST_FILE weak passwords to refuse
DISCORD_WEBHOOK         where alerts are posted
```

In GitHub, the deploy pipeline uses repository and environment secrets: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DISCORD_WEBHOOK`.

Rules about secrets in this project: a person with admin sets them; an agent never types a secret value into a form, a command or a file. Only names are written down, including here.

**Still open:** the Spaces keys, the DigitalOcean API token and the first Discord webhook were pasted into a chat window earlier and have not been rotated. They should be.

---

## 8. Object storage

Bucket `excalidraw-data` in region `sfo3`. File listing is restricted, so the keys cannot be enumerated by a stranger, and nothing is public: the browser gets a signed link that expires.

What is kept there:

- image bytes, one object per workspace per digest — the same picture used in fifty drawings is stored once;
- collaboration snapshots and dashboard thumbnails;
- workspace export archives;
- the nightly database dumps, under `backups/postgres/`.

If the keys are missing, the API falls back to writing into `/opt/excalidraw/storage` on the disk, so the machine still works while storage is being provisioned.

---

## 9. The database

- Database `excalidraw`, role `excalidraw`, listening on localhost only.
- PostgreSQL's memory settings are tuned down for a 4 GB machine; the swap file exists so a build or a dump cannot push it over.
- The connection pool in the application is capped at 10.
- Migrations run **before** the new code starts, as part of the deploy. They are written to be safe while the old code is still serving: add columns and tables, never remove or rename in the same release that stops using them.

Two rules written in blood, both in `DEVELOPMENT.md` §9:

1. Never hold a transaction open across an upload. Doing so locked a drawing's row for minutes, queued every other save behind it, filled the pool, and stopped the whole site.
2. Never return partial data to make a request succeed. A missing image must be an error, or the browser will save that version back and lose the image.

---

## 10. Backups

- `excalidraw-backup.timer` runs nightly at 03:15 UTC.
- The run dumps PostgreSQL, compresses it, and copies it to Spaces under `backups/postgres/`.
- Local copies in `/opt/excalidraw/backups` are kept for seven days.
- A deploy also takes its own dump first, named `pre-<version>-<timestamp>`.
- The backup script was rewritten after it was caught reporting a skipped file as success: it now fails loudly, checksums every object and reads it back.

To restore:

```bash
gunzip -c excalidraw-<stamp>.sql.gz | psql "$DATABASE_URL"
```

**Not done yet:** nobody restores the dump into a scratch database on a schedule, and nothing shouts if a night is missed. A backup that has never been restored is a hope, not a backup.

---

## 11. How a release reaches this machine

```
  pull request  ──▶  main  ──▶  git tag vX.Y.Z  ──▶  release.yml
                                                        │ builds editor,
                                                        │ packs server+dashboard,
                                                        │ writes checksums,
                                                        ▼ publishes a GitHub Release
                                                   deploy.yml  (started by hand)
                                                        │
                                            a human approves in the
                                            GitHub "production" environment
                                                        │
                                                        ▼
                      ssh ci-deploy@host  →  sudo /usr/local/bin/excalidraw-deploy install vX.Y.Z
```

What the install script does, in order:

1. remembers which release is live, for rollback;
2. dumps the database;
3. unpacks the API and dashboard, installs dependencies;
4. runs migrations;
5. unpacks the editor into `app/releases/vX.Y.Z` and moves the `current` link;
6. restarts the API and reloads nginx.

Then the pipeline calls `/api/me` until it answers; `401` counts as healthy, because it means the API replied and we are simply not signed in. If it never answers, the pipeline runs `excalidraw-deploy rollback`, which moves the link back to the previous release and restarts. **The database is deliberately not rolled back** — migrations are written to be safe for the previous version, and restoring a dump would throw away whatever people saved since the deploy.

Discord gets a message before and after, including the rollback command, so nobody has to look it up while the site is down.

A green health check is not the end. `DEVELOPMENT.md` §10 requires that someone opens the site 5–10 minutes later, signs in, and exercises the thing the release changed. A release once passed every check while serving an editor that silently ignored every saved drawing.

---

## 12. If the machine is lost

Everything needed to rebuild is in this repository.

1. Create a droplet: Ubuntu 24.04, 2 vCPU / 4 GB, and point the DNS name at it.
2. Follow `deploy.md` from section 3. It is the real procedure, command by command: users, firewall, swap, Node, PostgreSQL, Spaces, the service, nginx, TLS, the first administrator.
3. Put `/etc/excalidraw-api.env` back with fresh secrets.
4. Restore the newest dump from `backups/postgres/` in Spaces.
5. Install the current release through `deploy.yml`, choosing the tag.
6. Walk section 13 of `deploy.md`: TLS, health, login, a drawing that saves and reloads, two browsers collaborating, and an anonymous request to the bucket being refused.

The object storage is separate from the machine, so images survive the droplet. Losing the Spaces bucket is the one failure this plan does not cover — keep its keys and its own retention in mind.

---

## 13. Open items on the server

- [ ] Apply `ci-deploy.sudoers` so the CI account can run only the deploy script. It currently has full passwordless root.
- [ ] Replace `test-firewall`, which allows all TCP from anywhere, with a rule set that limits port 22.
- [ ] Rotate the Spaces keys, the DigitalOcean token and the first Discord webhook.
- [ ] Install the operational alerts from `DEVELOPMENT.md` §7b — lock waits and stuck transactions first. The October outage would have been a message instead of a frozen site discovered by a person.
- [ ] Test the backup by restoring it into a scratch database, on a schedule, and alert when a night is missed.
- [ ] Add `EnvironmentFile=/etc/excalidraw-backup.env` to the backup unit in the repository; the live unit has it and the repository copy does not.
- [ ] Apply the pending system updates and reboot during a quiet hour.
