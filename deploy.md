# Deploying Self-hosted Excalidraw — Step by Step

An Excalidraw deployment with the features of the hosted Excalidraw+ product:
**user accounts, a workspace dashboard, collections, per-scene edit/view
permissions, live collaboration, and object storage in DigitalOcean Spaces.**

This document describes the procedure that was actually executed on
`draw.devopsproject.dev`. Requirements, sizing and acceptance criteria live in
[deploy-spec.md](deploy-spec.md) — read that first.

| | |
|---|---|
| Host | Ubuntu 24.04 LTS, 2 vCPU / 4 GB, DigitalOcean BLR1 |
| Domain | `draw.devopsproject.dev` |
| Object storage | DigitalOcean Spaces, bucket `excalidraw-data`, region `sfo3` |
| Database | PostgreSQL 16 on the same host |

---

## Table of contents

1. [What gets installed](#1-what-gets-installed)
2. [Before you start](#2-before-you-start)
3. [Base system and hardening](#3-base-system-and-hardening)
4. [Runtimes](#4-runtimes)
5. [PostgreSQL and the schema](#5-postgresql-and-the-schema)
6. [Object storage — DigitalOcean Spaces](#6-object-storage--digitalocean-spaces)
7. [The API service](#7-the-api-service)
8. [The collaboration server](#8-the-collaboration-server)
9. [Building the frontend](#9-building-the-frontend)
10. [The dashboard](#10-the-dashboard)
11. [nginx and TLS](#11-nginx-and-tls)
12. [First admin and passwords](#12-first-admin-and-passwords)
13. [Verification](#13-verification)
14. [Backups](#14-backups)
15. [Upgrades and rollback](#15-upgrades-and-rollback)
16. [Troubleshooting](#16-troubleshooting)

---

## 1. What gets installed

```
                     ┌──────────────────────────────────┐
   browser ──────────┤ nginx (443, TLS)                 │
                     │  /            → editor SPA       │
                     │  /dashboard/  → workspace UI     │
                     │  /api/        → :4000 API        │
                     │  /socket.io/  → :3002 collab     │
                     └──────┬─────────────┬─────────────┘
                            │             │
                ┌───────────▼──┐    ┌─────▼─────────────┐
                │ excalidraw-  │    │ excalidraw-room   │
                │ api  :4000   │    │ :3002 (socket.io) │
                └──┬────────┬──┘    └───────────────────┘
                   │        │
          ┌────────▼─┐   ┌──▼──────────────────┐
          │ Postgres │   │ Spaces (or local    │
          │ 16       │   │ disk until keys set)│
          └──────────┘   └─────────────────────┘
```

| Unit | Runs as | Bind | Purpose |
|---|---|---|---|
| `nginx` | `www-data` | `0.0.0.0:80,443` | TLS, static files, reverse proxy |
| `excalidraw-api` | `excalidraw` | `127.0.0.1:4000` | accounts, workspaces, collections, scenes, storage |
| `excalidraw-room` | `excalidraw` | `*:3002` | live collaboration relay |
| `postgresql` | `postgres` | `127.0.0.1:5432` | metadata and permissions |

Upstream Excalidraw stores collaborative scenes in Firebase. This deployment
replaces that with the API above; the change is a **fork-local modification**
that must be re-applied after every upstream rebase (§9.3).

---

## 2. Before you start

- Ubuntu 24.04 host, 2 vCPU / 4 GB, ≥ 40 GB disk.
- DNS `A` record for your domain pointing at the host, resolving publicly.
- SSH key access.
- A DigitalOcean Space and a Spaces access key (§6.1).

```bash
export APP_DOMAIN=draw.devopsproject.dev
export HOST=139.59.41.208
export KEY=~/work-dir/keys/devops-key
```

> **`.dev` domains are HSTS-preloaded.** Browsers refuse plain HTTP on them
> outright, so the site is unreachable in a browser until TLS is issued in §11.
> Test earlier steps with `curl http://$HOST/` against the IP, not the name.

---

## 3. Base system and hardening

### 3.1 Create an admin user — do this before anything else

The droplet ships with root-only SSH. Security requires `PermitRootLogin no`,
so an alternative login must exist **first**.

```bash
ssh -i $KEY root@$HOST '
  adduser --disabled-password --gecos "" deploy
  usermod -aG sudo deploy
  install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
  cp /root/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
  chown deploy:deploy /home/deploy/.ssh/authorized_keys
  chmod 600 /home/deploy/.ssh/authorized_keys
  echo "deploy ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/90-deploy
  chmod 440 /etc/sudoers.d/90-deploy
  visudo -c -f /etc/sudoers.d/90-deploy
'
```

Verify the new path works **from a second terminal** before continuing:

```bash
ssh -i $KEY deploy@$HOST 'whoami && sudo -n true && echo "sudo OK"'
```

> Do not proceed until that prints `deploy` and `sudo OK`. Disabling root login
> without a working `deploy` login locks you out; recovery then requires the
> DigitalOcean web console.

### 3.2 Firewall — OpenSSH rule first

```bash
ssh -i $KEY deploy@$HOST '
  sudo ufw allow OpenSSH
  sudo ufw allow 80/tcp
  sudo ufw allow 443/tcp
  sudo ufw --force enable
  sudo ufw status verbose
'
```

> Enabling `ufw` without the `OpenSSH` rule ends your session and every future
> one. The rule must come first.

Mirror the same rules in the DigitalOcean Cloud Firewall so the host is
protected at both layers, and restrict port 22 to your admin IP range.

### 3.3 Swap — required on 4 GB

The frontend build peaks around 3.5 GB RSS and is OOM-killed without swap.

```bash
ssh -i $KEY deploy@$HOST '
  sudo fallocate -l 4G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo "/swapfile none swap sw 0 0" | sudo tee -a /etc/fstab
  echo "vm.swappiness=10" | sudo tee /etc/sysctl.d/99-swappiness.conf
  sudo sysctl -w vm.swappiness=10
'
```

### 3.4 Packages

```bash
ssh -i $KEY deploy@$HOST '
  export DEBIAN_FRONTEND=noninteractive
  sudo apt-get update -qq
  sudo apt-get install -y -qq curl git ca-certificates gnupg unzip ufw fail2ban \
    jq build-essential python3 nginx postgresql postgresql-contrib \
    certbot python3-certbot-nginx unattended-upgrades rsync
  sudo systemctl enable --now fail2ban
'
```

`build-essential` and `python3` must be present **before** the API's npm install
— `argon2` compiles a native addon.

### 3.5 SSH hardening — only now

```bash
ssh -i $KEY deploy@$HOST '
  printf "PasswordAuthentication no\nPermitRootLogin no\nKbdInteractiveAuthentication no\n" \
    | sudo tee /etc/ssh/sshd_config.d/99-hardening.conf
  sudo sshd -t && sudo systemctl reload ssh
  sudo sshd -T | grep -E "^(passwordauthentication|permitrootlogin) "
'
ssh -i $KEY deploy@$HOST 'echo "deploy login still OK"'
```

### 3.6 Automatic updates and log cap

```bash
ssh -i $KEY deploy@$HOST '
  echo unattended-upgrades unattended-upgrades/enable_auto_updates boolean true \
    | sudo debconf-set-selections
  sudo dpkg-reconfigure -f noninteractive unattended-upgrades
  sudo mkdir -p /etc/systemd/journald.conf.d
  printf "[Journal]\nSystemMaxUse=2G\n" | sudo tee /etc/systemd/journald.conf.d/99-cap.conf
  sudo systemctl restart systemd-journald
'
```

The host has a single partition, so `/var/log` competes with the database for
the same disk. The cap is not optional.

---

## 4. Runtimes

Node 22 LTS and **Yarn 1.22.22 exactly** — the repo pins it via `packageManager`,
and Yarn 2+ will not build this workspace.

```bash
ssh -i $KEY deploy@$HOST '
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y -qq nodejs
  sudo npm i -g yarn@1.22.22
  node -v && yarn -v
'
```

### 4.1 Service user and directory tree

```bash
ssh -i $KEY deploy@$HOST '
  sudo adduser --system --group --home /opt/excalidraw --shell /usr/sbin/nologin excalidraw
  sudo mkdir -p /opt/excalidraw/{api/src,api/bin,room,app,backups,storage}
  sudo chown -R excalidraw:excalidraw /opt/excalidraw
  sudo chmod 755 /opt/excalidraw
  sudo chmod 750 /opt/excalidraw/storage
'
```

> `adduser --system` creates the home directory as `0700`. nginx runs as
> `www-data` and must traverse this tree to serve the SPA, so `/opt/excalidraw`
> is explicitly widened to `755`. Skipping that produces a confusing 403.

---

## 5. PostgreSQL and the schema

### 5.1 Tuning for 4 GB

```bash
ssh -i $KEY deploy@$HOST '
  sudo tee /etc/postgresql/16/main/conf.d/excalidraw.conf >/dev/null <<EOF
shared_buffers = 768MB
effective_cache_size = 2GB
work_mem = 8MB
maintenance_work_mem = 192MB
max_connections = 50
wal_level = replica
listen_addresses = '"'"'localhost'"'"'
EOF
  sudo systemctl restart postgresql
'
```

Do not raise `shared_buffers` on this hardware — it starves Node and the build.

### 5.2 Role and database

The password is generated **on the server** and never leaves it.

```bash
ssh -i $KEY deploy@$HOST '
  sudo bash -c "
    DB_PASS=\$(openssl rand -base64 36 | tr -dc A-Za-z0-9 | head -c 40)
    sudo -u postgres psql -q -c \"CREATE ROLE excalidraw LOGIN PASSWORD '"'"'\$DB_PASS'"'"';\"
    sudo -u postgres psql -q -c \"CREATE DATABASE excalidraw OWNER excalidraw;\"
    install -m 600 /dev/null /root/.excalidraw-dbpass
    printf %s \"\$DB_PASS\" > /root/.excalidraw-dbpass
  "
  sudo -u postgres psql -d excalidraw -q -c "CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS citext;"
'
```

### 5.3 Schema

The schema lives in the repo at [`server/schema.sql`](server/schema.sql) and
[`server/migration-002-collections.sql`](server/migration-002-collections.sql).
Copy and apply them:

```bash
scp -i $KEY server/schema.sql server/migration-002-collections.sql deploy@$HOST:/tmp/
ssh -i $KEY deploy@$HOST '
  sudo -u postgres psql -d excalidraw -q -f /tmp/schema.sql
  sudo -u postgres psql -d excalidraw -q -f /tmp/migration-002-collections.sql
  rm -f /tmp/schema.sql /tmp/migration-002-collections.sql
  sudo -u postgres psql -d excalidraw -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='"'"'public'"'"';"
'
```

Expect **13 tables**:

| Table | Holds |
|---|---|
| `users` | accounts, argon2 hashes, superadmin flag |
| `workspaces`, `workspace_members`, `workspace_invites` | teams and the user-add flow |
| `collections` | the dashboard's Collections sidebar |
| `scenes` | drawing metadata, `s3_key` pointer, `collection_id` |
| `scene_versions` | one immutable row per save |
| `scene_permissions` | per-user **edit / view** grants |
| `share_links`, `shared_scenes` | link sharing |
| `scene_files` | image assets |
| `refresh_tokens`, `audit_log` | sessions and audit trail |

**Effective permission** on a scene resolves in this order: superadmin → owner →
explicit `scene_permissions` row → workspace role (`owner`/`admin`/`editor` =
edit, `viewer` = view) → otherwise 403.

---

## 6. Object storage — DigitalOcean Spaces

Spaces speaks the S3 API. Only the endpoint changes.

| Property | Value |
|---|---|
| Bucket | `excalidraw-data` |
| Region | `sfo3` |
| Endpoint | `https://sfo3.digitaloceanspaces.com` |
| Bucket URL | `https://excalidraw-data.sfo3.digitaloceanspaces.com` |
| Price | $5/month — 250 GiB storage + 1 TiB transfer |

> **Region matters.** `sfo3` is San Francisco; a Bangalore droplet is ~230 ms
> away, which roughly triples scene save latency. A Space in `blr1` would be
> ~1 ms. Moving later means creating a new Space and re-uploading — only the
> three `S3_*`/`AWS_REGION` values in §7.2 change.

### 6.1 Create the Space and key — console only

The S3 API cannot mint its own first credential.

1. **Spaces Object Storage → Create Bucket** → pick the region, name it
   `excalidraw-data`, **File Listing: Restricted**.
2. **Access Keys → Generate New Key**, scoped to that bucket, permissions
   Read/Write/Delete.
3. Copy **both** values. The secret is shown once.

> The console **truncates the Access Key ID** in the table column. A DO Spaces
> key ID is 20 characters — click the copy icon rather than reading it off the
> screen. A short ID produces `InvalidAccessKeyId` with no other clue.

### 6.2 Key layout

```
scenes/<sceneId>/<version>.json        workspace drawings, one key per save
rooms/<roomId>/scene.bin               live-collab ciphertext
files/scenes/<sceneId>/<fileId>        image assets
files/rooms/<roomId>/<fileId>
files/shareLinks/<shareId>/<fileId>
shareLinks/<shareId>.bin               share-link payload ciphertext
thumbnails/<sceneId>.png
backups/postgres/<date>.sql.gz
```

Every save writes a **new key** — nothing is overwritten. Version history is a
property of the key layout plus `scene_versions`, which matters because Spaces
has no object versioning.

### 6.3 CORS and lifecycle

The browser PUTs directly to presigned URLs, so CORS is mandatory. Apply both
with the script in the repo:

```bash
scp -i $KEY server/spaces-setup.mjs deploy@$HOST:/tmp/
ssh -i $KEY deploy@$HOST '
  sudo cp /tmp/spaces-setup.mjs /opt/excalidraw/api/
  sudo bash -c "set -a; . /etc/excalidraw-api.env; set +a; cd /opt/excalidraw/api && node spaces-setup.mjs"
  sudo rm -f /opt/excalidraw/api/spaces-setup.mjs /tmp/spaces-setup.mjs
'
```

It verifies connectivity, then sets a CORS rule for your origin
(`GET,PUT,HEAD`) and lifecycle rules (share links expire at 365 days,
incomplete multipart uploads aborted after 7).

### 6.4 What Spaces does not do

| Capability | AWS S3 | Spaces | Consequence |
|---|---|---|---|
| Object versioning | Yes | **No** | History comes from immutable keys + `scene_versions`; bad-write recovery restores a prior key |
| Credential scoping | IAM, instance roles | Per-bucket keys where offered | No instance-role equivalent — a static key is unavoidable; rotate every 90 days |
| Encryption at rest | Configurable | On, not configurable | No customer-managed keys |

---

## 7. The API service

### 7.1 Install

The service source is in the repo at [`server/`](server/).

```bash
scp -i $KEY server/server.js server/package.json deploy@$HOST:/tmp/
scp -i $KEY server/bin/set-password.mjs deploy@$HOST:/tmp/
ssh -i $KEY deploy@$HOST '
  sudo install -o excalidraw -g excalidraw -m 644 /tmp/server.js  /opt/excalidraw/api/src/server.js
  sudo install -o excalidraw -g excalidraw -m 644 /tmp/package.json /opt/excalidraw/api/package.json
  sudo install -o excalidraw -g excalidraw -m 755 /tmp/set-password.mjs /opt/excalidraw/api/bin/set-password.mjs
  rm -f /tmp/server.js /tmp/package.json /tmp/set-password.mjs
  cd /opt/excalidraw/api
  sudo -u excalidraw env HOME=/opt/excalidraw npm i --no-fund --no-audit
'
```

### 7.2 Configuration

```bash
ssh -i $KEY deploy@$HOST '
  sudo bash -c "
    DB_PASS=\$(cat /root/.excalidraw-dbpass)
    JWT=\$(openssl rand -hex 48)
    cat > /etc/excalidraw-api.env <<EOF
NODE_ENV=production
PORT=4000
APP_ORIGIN=https://draw.devopsproject.dev

DATABASE_URL=postgres://excalidraw:\${DB_PASS}@127.0.0.1:5432/excalidraw

AWS_REGION=sfo3
S3_BUCKET=excalidraw-data
S3_ENDPOINT=https://sfo3.digitaloceanspaces.com
S3_FORCE_PATH_STYLE=false
AWS_ACCESS_KEY_ID=<20-char Spaces key id>
AWS_SECRET_ACCESS_KEY=<43-char Spaces secret>

JWT_SECRET=\${JWT}
COOKIE_SECURE=true
PRESIGN_TTL_SECONDS=300
ALLOW_SIGNUP=false
LOCAL_STORAGE_ROOT=/opt/excalidraw/storage
EOF
    chown root:excalidraw /etc/excalidraw-api.env
    chmod 640 /etc/excalidraw-api.env
  "
'
```

| Variable | Purpose |
|---|---|
| `APP_ORIGIN` | cookie domain, invite links, and the base for local-driver blob URLs |
| `DATABASE_URL` | loopback Postgres |
| `AWS_*` / `S3_*` | Spaces; leave the key as `REPLACE_ME` to run on local disk (§7.3) |
| `JWT_SECRET` | session signing; rotating it invalidates every session |
| `PRESIGN_TTL_SECONDS` | presigned URL lifetime, 300 |
| `ALLOW_SIGNUP` | `true` only while creating the first admin |

> This file holds the database password, the session signing key and the Spaces
> secret. Keep it `0640 root:excalidraw`, never commit it, and rotate the Spaces
> key if it is ever exposed.

### 7.3 The storage driver

The API picks its storage backend at startup:

- **Spaces** when `AWS_ACCESS_KEY_ID` is set to a real value.
- **Local disk** under `LOCAL_STORAGE_ROOT` otherwise.

Both expose presigned PUT/GET, so the browser upload path is identical. The
local driver signs `/api/blob/<key>?exp=…&sig=…` with an HMAC of `JWT_SECRET`,
scoped to one key, one method and a 5-minute expiry — a tampered or expired URL
returns 403.

This means the instance is fully usable before object storage exists. Adding the
key and restarting switches every future write to Spaces; **existing objects are
not migrated automatically** — copy `/opt/excalidraw/storage/` into the bucket if
you have live data:

```bash
ssh -i $KEY deploy@$HOST '
  sudo -u excalidraw aws --endpoint-url https://sfo3.digitaloceanspaces.com \
    s3 sync /opt/excalidraw/storage/ s3://excalidraw-data/
'
```

Check which driver is live:

```bash
curl -sS -b cookies https://$APP_DOMAIN/api/storage-info   # {"driver":"s3"} or {"driver":"local"}
```

### 7.4 systemd unit

```bash
ssh -i $KEY deploy@$HOST '
  sudo tee /etc/systemd/system/excalidraw-api.service >/dev/null <<EOF
[Unit]
Description=Excalidraw API
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=excalidraw
Group=excalidraw
WorkingDirectory=/opt/excalidraw/api
EnvironmentFile=/etc/excalidraw-api.env
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/excalidraw
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF
  sudo systemctl daemon-reload
  sudo systemctl enable --now excalidraw-api
  sleep 3 && curl -sS http://127.0.0.1:4000/api/healthz
'
```

`ReadWritePaths=/opt/excalidraw` is required — `ProtectSystem=strict` otherwise
makes the local storage root read-only.

---

## 8. The collaboration server

Stateless socket.io relay. Scene persistence is the API, not this service.

```bash
ssh -i $KEY deploy@$HOST '
  sudo -u excalidraw git clone -q --depth 1 \
    https://github.com/excalidraw/excalidraw-room.git /opt/excalidraw/room
  sudo -u excalidraw env HOME=/opt/excalidraw yarn --cwd /opt/excalidraw/room install --frozen-lockfile
  sudo -u excalidraw env HOME=/opt/excalidraw yarn --cwd /opt/excalidraw/room build

  sudo tee /etc/systemd/system/excalidraw-room.service >/dev/null <<EOF
[Unit]
Description=Excalidraw collaboration server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=excalidraw
Group=excalidraw
WorkingDirectory=/opt/excalidraw/room
Environment=NODE_ENV=production
Environment=PORT=3002
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF
  sudo systemctl daemon-reload
  sudo systemctl enable --now excalidraw-room
  sleep 2 && curl -sS -o /dev/null -w "room %{http_code}\n" http://127.0.0.1:3002/
'
```

> The room server binds `*:3002`, not loopback — it has no bind-address option.
> `ufw` is what keeps it private, so §3.2 is load-bearing here.

---

## 9. Building the frontend

Build on a workstation and ship the output. A 4 GB droplet can build with swap,
but not comfortably alongside a running Postgres.

### 9.1 Environment

`.env.production.local` in the repo root:

```
VITE_APP_BACKEND_V2_GET_URL=https://draw.devopsproject.dev/api/v2/
VITE_APP_BACKEND_V2_POST_URL=https://draw.devopsproject.dev/api/v2/post/
VITE_APP_WS_SERVER_URL=https://draw.devopsproject.dev
VITE_APP_API_URL=https://draw.devopsproject.dev/api
VITE_APP_FIREBASE_CONFIG={}
VITE_APP_ENABLE_TRACKING=false
VITE_APP_DISABLE_SENTRY=true
VITE_APP_FONTS_CDN=/
```

Every `VITE_APP_*` value is **compiled into public JavaScript**. Never put a
secret in one. Changing any of them requires a rebuild and redeploy.

`VITE_APP_FONTS_CDN=/` is important: by default the build points
`EXCALIDRAW_ASSET_PATH` at Excalidraw's own CDN with your server only as a
fallback. That leaks a request to a third party on every load, and any font
family you add locally is not on that CDN — it 404s there before falling back.

### 9.2 Source modifications

Three changes are carried in this fork:

| File | Change |
|---|---|
| `excalidraw-app/data/firebase.ts` | Firebase replaced with API-backed storage, same six exported symbols so no call sites change |
| `excalidraw-app/data/workspaceScene.ts` | new — loads/saves a dashboard scene via `/?scene=<uuid>` |
| `excalidraw-app/vite.config.mts` | `navigateFallbackDenylist` for `/dashboard` and `/api/` |
| `scripts/woff2/woff2-vite-plugins.js` | font CDN made configurable |

> **The PWA denylist is not optional.** Excalidraw registers a service worker
> whose navigation fallback claims every path under `/`. Without the denylist it
> serves the editor shell for `/dashboard/` from cache, and the dashboard simply
> never appears — with no error anywhere.

`loadFirebaseStorage` now throws: "Export to Excalidraw+" uploads to the
commercial product's Firebase and cannot work self-hosted. All other export
paths (PNG, SVG, `.excalidraw`, share link) are unaffected.

### 9.3 Build and ship

```bash
yarn install
yarn test:typecheck
NODE_OPTIONS=--max-old-space-size=4096 yarn build:app

REL=$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short HEAD)
ssh -i $KEY deploy@$HOST "sudo mkdir -p /opt/excalidraw/app/releases/$REL && sudo chown excalidraw:excalidraw /opt/excalidraw/app/releases/$REL"
rsync -az --delete --rsync-path="sudo rsync" -e "ssh -i $KEY" \
  excalidraw-app/build/ deploy@$HOST:/opt/excalidraw/app/releases/$REL/
ssh -i $KEY deploy@$HOST "
  sudo chown -R excalidraw:excalidraw /opt/excalidraw/app/releases/$REL
  sudo find /opt/excalidraw/app/releases/$REL -type d -exec chmod 755 {} +
  sudo find /opt/excalidraw/app/releases/$REL -type f -exec chmod 644 {} +
  sudo ln -sfn /opt/excalidraw/app/releases/$REL /opt/excalidraw/app/current
  sudo systemctl reload nginx
"
```

Releases are versioned directories with a `current` symlink, so a rollback is a
symlink swap and an nginx reload.

---

## 10. The dashboard

The workspace UI — Dashboard, Collections, Team members, Trash — is a
dependency-free static app in [`dashboard/`](dashboard/).

```bash
ssh -i $KEY deploy@$HOST 'sudo install -d -o excalidraw -g excalidraw -m 755 /opt/excalidraw/app/dashboard'
rsync -az --delete --rsync-path="sudo rsync" -e "ssh -i $KEY" \
  dashboard/ deploy@$HOST:/opt/excalidraw/app/dashboard/
ssh -i $KEY deploy@$HOST '
  sudo chown -R excalidraw:excalidraw /opt/excalidraw/app/dashboard
  sudo find /opt/excalidraw/app/dashboard -type f -exec chmod 644 {} +
'
```

It is deployed separately from the editor because it has no build step and
changes independently.

**What it does:** lists drawings as cards with author and relative time; creates,
renames, moves, trashes and restores them; creates collections (optionally
private to you); adds workspace members and produces invite links; shows
workspace settings including the active storage driver. Clicking a card opens
`/?scene=<uuid>`, which the editor loads from the database and autosaves back to
(debounced 1.5 s). A `view`-only grant opens the editor in view mode.

---

## 11. nginx and TLS

### 11.1 Site configuration

```bash
ssh -i $KEY deploy@$HOST '
  sudo rm -f /etc/nginx/sites-enabled/default
  sudo tee /etc/nginx/snippets/excalidraw-security.conf >/dev/null <<EOF
add_header X-Content-Type-Options nosniff always;
add_header X-Frame-Options SAMEORIGIN always;
add_header Referrer-Policy strict-origin-when-cross-origin always;
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
EOF
'
```

> nginx `add_header` **does not inherit** into any block that defines its own.
> The security snippet must be included again inside every `location` that sets
> a header of its own, or those responses silently ship without them.

```bash
ssh -i $KEY deploy@$HOST '
  sudo tee /etc/nginx/sites-available/excalidraw >/dev/null <<"NGINX"
map $http_upgrade $connection_upgrade { default upgrade; "" close; }

server {
    listen 80;
    listen [::]:80;
    server_name draw.devopsproject.dev 139.59.41.208;
    root /opt/excalidraw/app/current;
    index index.html;

    client_max_body_size 25m;
    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;
    gzip_min_length 1024;

    include snippets/excalidraw-security.conf;

    location /assets/ {
        expires 1y;
        include snippets/excalidraw-security.conf;
        add_header Cache-Control "public, immutable";
        try_files $uri =404;
    }

    location = /index.html {
        include snippets/excalidraw-security.conf;
        add_header Cache-Control "no-store";
    }

    location /dashboard/ {
        alias /opt/excalidraw/app/dashboard/;
        include snippets/excalidraw-security.conf;
        add_header Cache-Control "no-store";
        try_files $uri $uri/ /dashboard/index.html;
    }
    location = /dashboard { return 301 /dashboard/; }

    location /api/ {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }

    location /socket.io/ {
        proxy_pass http://127.0.0.1:3002;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    location / { try_files $uri $uri/ /index.html; }
}
NGINX
  sudo ln -sfn /etc/nginx/sites-available/excalidraw /etc/nginx/sites-enabled/excalidraw
  sudo nginx -t && sudo systemctl reload nginx
'
```

The WebSocket `proxy_read_timeout 3600s` is what keeps collaboration sessions
alive; anything shorter drops idle collaborators.

### 11.2 Certificate

```bash
ssh -i $KEY deploy@$HOST '
  sudo certbot --nginx -d draw.devopsproject.dev \
    --agree-tos -m you@example.com --no-eff-email --redirect --non-interactive
  systemctl is-active certbot.timer
'
```

Certbot rewrites the server block to listen on 443 and adds the HTTP redirect.
Renewal runs from `certbot.timer`.

---

## 12. First admin and passwords

```bash
ssh -i $KEY deploy@$HOST '
  sudo sed -i "s/^ALLOW_SIGNUP=.*/ALLOW_SIGNUP=true/" /etc/excalidraw-api.env
  sudo systemctl restart excalidraw-api && sleep 3

  sudo bash -c "
    PASS=\$(openssl rand -base64 30 | tr -dc A-Za-z0-9 | head -c 28)
    curl -sS -X POST http://127.0.0.1:4000/api/auth/signup \
      -H \"content-type: application/json\" \
      -d \"{\\\"email\\\":\\\"you@example.com\\\",\\\"password\\\":\\\"\$PASS\\\",\\\"name\\\":\\\"Admin\\\"}\"
    install -m 600 /dev/null /root/.excalidraw-admin-pass
    printf \"email: you@example.com\npassword: %s\n\" \"\$PASS\" > /root/.excalidraw-admin-pass
  "

  sudo sed -i "s/^ALLOW_SIGNUP=.*/ALLOW_SIGNUP=false/" /etc/excalidraw-api.env
  sudo systemctl restart excalidraw-api
  sudo -u postgres psql -d excalidraw -q -c "UPDATE users SET is_superadmin=true WHERE email='"'"'you@example.com'"'"';"
'
```

> Leaving `ALLOW_SIGNUP=true` lets anyone on the internet create an account.
> Turn it off as soon as the first admin exists; add everyone else through the
> dashboard's **Team members → Add member**, which produces an invite link.

Read the generated password, then change it to one you choose:

```bash
ssh -i $KEY deploy@$HOST 'sudo cat /root/.excalidraw-admin-pass'

ssh -t -i $KEY deploy@$HOST '
  sudo bash -c "set -a; . /etc/excalidraw-api.env; set +a; \
    cd /opt/excalidraw/api && node bin/set-password.mjs you@example.com"
'
```

`set-password.mjs` prompts for the password with echo disabled, so it never
appears in argv, shell history or logs. Sign-in accepts **either the email or the
display name** as the username.

---

## 13. Verification

```bash
# TLS, redirect, API
curl -sS -o /dev/null -w "app        %{http_code}\n" https://$APP_DOMAIN/
curl -sS -o /dev/null -w "redirect   %{http_code}\n" http://$HOST/
curl -sS   -w "  <- healthz\n"                       https://$APP_DOMAIN/api/healthz
curl -sS -o /dev/null -w "dashboard  %{http_code}\n" https://$APP_DOMAIN/dashboard/
curl -sS -o /dev/null -w "socket.io  %{http_code}\n" "https://$APP_DOMAIN/socket.io/?EIO=4&transport=polling"

# security headers must appear on the SPA shell, not only on assets
curl -sSI https://$APP_DOMAIN/ | grep -iE "strict-transport|x-content-type|x-frame|referrer"

# no secret compiled into the bundle
ssh -i $KEY deploy@$HOST 'sudo grep -rlE "AWS_SECRET|JWT_SECRET|password" /opt/excalidraw/app/current/assets | head'
```

Signed-in checks — log in through the dashboard, then confirm:

| Check | Expected |
|---|---|
| Sign in with email, and with display name | both succeed |
| Wrong password | "Wrong username or password." |
| Create a collection | appears in the sidebar with a count |
| New drawing → draw → reload | content persists |
| `/api/scenes` after two saves | `scene_version` incremented |
| Objects in storage | `scenes/<id>/<version>.json` present |
| Grant a user `view`, then have them edit | `POST …/commit` → 403 |
| Grant `edit` | same call → 200 |
| Two browsers, live collaboration | cursors sync in under a second |
| Anonymous GET of an object URL | 403 |

---

## 14. Backups

Postgres holds every pointer and permission; Spaces holds the payloads.

```bash
ssh -i $KEY deploy@$HOST '
  sudo tee /usr/local/bin/excalidraw-backup.sh >/dev/null <<"EOF"
#!/usr/bin/env bash
set -euo pipefail
source /etc/excalidraw-api.env
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="/opt/excalidraw/backups/excalidraw-${STAMP}.sql.gz"
pg_dump "$DATABASE_URL" | gzip -9 > "$OUT"
aws --endpoint-url "$S3_ENDPOINT" s3 cp "$OUT" "s3://${S3_BUCKET}/backups/postgres/"
find /opt/excalidraw/backups -name "*.sql.gz" -mtime +7 -delete
EOF
  sudo chmod 750 /usr/local/bin/excalidraw-backup.sh

  sudo tee /etc/systemd/system/excalidraw-backup.service >/dev/null <<EOF
[Unit]
Description=Excalidraw Postgres backup
[Service]
Type=oneshot
EnvironmentFile=/etc/excalidraw-api.env
ExecStart=/usr/local/bin/excalidraw-backup.sh
EOF

  sudo tee /etc/systemd/system/excalidraw-backup.timer >/dev/null <<EOF
[Unit]
Description=Nightly Excalidraw backup
[Timer]
OnCalendar=*-*-* 03:15:00
Persistent=true
[Install]
WantedBy=timers.target
EOF
  sudo systemctl daemon-reload
  sudo systemctl enable --now excalidraw-backup.timer
'
```

Requires the AWS CLI on the host (`sudo apt install awscli`) and a Spaces key in
the env file. Restore with `gunzip -c dump.sql.gz | psql "$DATABASE_URL"`, and
rehearse it on a throwaway droplet before you need it.

---

## 15. Upgrades and rollback

```bash
# frontend
git fetch origin && git rebase origin/master
yarn install && yarn test:typecheck && yarn test:update
NODE_OPTIONS=--max-old-space-size=4096 yarn build:app
# then ship as in §9.3

# collaboration server
ssh -i $KEY deploy@$HOST '
  sudo -u excalidraw git -C /opt/excalidraw/room pull
  sudo -u excalidraw env HOME=/opt/excalidraw yarn --cwd /opt/excalidraw/room install
  sudo -u excalidraw env HOME=/opt/excalidraw yarn --cwd /opt/excalidraw/room build
  sudo systemctl restart excalidraw-room
'
```

`excalidraw-app/data/firebase.ts` is the file most likely to conflict on rebase.
After every pull, re-check its six exported symbols against upstream and run
`yarn test:typecheck`.

| Failure | Rollback |
|---|---|
| Bad frontend build | `ln -sfn` the previous release, reload nginx |
| Bad API deploy | restore the previous `server.js`, `systemctl restart excalidraw-api` |
| Bad migration | restore the nightly dump into a fresh database, repoint `DATABASE_URL` |
| Bad scene write | restore the previous key from `scene_versions` |
| Host loss | restore the DigitalOcean snapshot, replay the newest dump |

---

## 16. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `/dashboard/` shows the editor | service worker navigation fallback | `navigateFallbackDenylist` (§9.2); clear the SW once in the browser |
| `InvalidAccessKeyId` | key ID truncated in the DO console | copy the full 20-character ID (§6.1) |
| Login shows "unauthenticated" | 401 handler swallowing the login response | fixed in `dashboard/app.js`; expect "Wrong username or password." |
| Blob upload 500 | body parser consumed the raw body | parsers skip `/api/blob/` (§7.3) |
| Security headers missing on `/` | `add_header` not inherited into a location | include the snippet in that location (§11.1) |
| `/api/healthz` 404 | route mounted only at `/healthz` | the service answers on both paths |
| 403 serving the SPA | `/opt/excalidraw` is `0700` | `chmod 755 /opt/excalidraw` (§4.1) |
| Collaboration never connects | WebSocket upgrade not proxied | check the `map $http_upgrade` block and `/socket.io/` |
| Build OOM-killed near 90% | no swap | §3.3, or build off-host |
| Fonts fetched from a third party | default CDN asset path | `VITE_APP_FONTS_CDN=/` (§9.1) |
| Scenes fail to save | storage driver has bad credentials | `GET /api/storage-info`; `journalctl -u excalidraw-api -f` |

```bash
journalctl -u excalidraw-api  -f
journalctl -u excalidraw-room -f
sudo tail -f /var/log/nginx/error.log
sudo -u postgres psql -d excalidraw -c "SELECT count(*) FROM scenes WHERE deleted_at IS NULL;"
```
