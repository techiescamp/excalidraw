# A development environment on DigitalOcean

Until now this repository had one environment: production. DEVELOPMENT.md §4a
says so plainly — "there is no staging server, so this is the only place it
runs before production" — and every incident so far came from code meeting real
data for the first time on the live site.

This adds the missing environment: a droplet restored from a production
snapshot, reachable by IP, that a branch can be deployed to and clicked
through before anything is tagged for production.

## What it does

1. `scripts/dev-env/dev-env.sh up` creates a droplet from the newest
   production snapshot, behind a firewall that admits only the operator's own
   address.
2. `scripts/dev-env/dev-env.sh prepare` runs `unproduction.sh` on it, with
   `configure.mjs` for the two file rewrites: the clone
   stops being a second production and becomes a development box — served over
   HTTP on its IP, with its own signing secret, its own object storage, no
   backup job, no production credentials it can still read, and no usable
   password for any real account.
3. `.github/workflows/deploy-dev.yml` builds the branch and installs it on that
   droplet, using the same `excalidraw-deploy install` script production uses.
   It runs on every push to `dev`, and on demand for any ref.

The order matters. A snapshot that has not been through step 2 is production
with a different IP, and the editor inside it still talks to the production
API. Step 2 is what breaks those links, and it refuses to run on a host that
the production domain resolves to.

## What it does not do

- **It is not a staging environment.** Staging means a replica that receives
  the same release artifact production will receive. This box receives a build
  made for its own address, because the editor bundle has the API URL compiled
  into it (see "The editor is built per host" below). What runs on dev differs
  from what runs on production by those URLs. Nothing else.
- **It does not replace local verification.** DEVELOPMENT.md §4a stands. Local
  is still where a change is first exercised; the dev droplet is where it meets
  real data.
- **It does not create or hold TLS.** The box answers on port 80 by IP.
- **It does not sync fresh production data on its own.** The data is as old as
  the snapshot. Taking a newer snapshot and recreating the droplet is the
  refresh mechanism; there is no in-place sync.
- **It is not monitored.** No Discord messages, no alerts, no backups. If the
  dev box breaks, it gets destroyed and made again.

## The editor is built per host

`.github/workflows/release.yml` writes `VITE_APP_BACKEND_V2_GET_URL`,
`VITE_APP_WS_SERVER_URL` and friends into `.env.production.local` before
building, and Vite compiles those strings into the bundle. The release workflow
then refuses to publish a bundle that does not contain
`draw.devopsproject.dev/api`, because a bundle without an API address loads as
plain upstream Excalidraw and silently ignores every workspace drawing.

A consequence that is easy to miss: **a production bundle served from the dev
droplet sends its writes to production.** The browser loads the page from the
dev IP and then posts scenes, images and icons to `https://draw.devopsproject.dev`.
Two defences:

- `unproduction.sh` replaces the editor directory it inherited with a
  placeholder page, so the clone cannot serve the production bundle at all
  until a dev build is installed over it.
- `deploy-dev.yml` builds with the dev host's URLs and fails if the bundle it
  just built still mentions `draw.devopsproject.dev`.

`VITE_APP_API_URL` already falls back to a relative `/api`. If the other three
were given the same same-origin defaults, one artifact would run on any host
and dev would test the exact bytes production gets. That is a change to how
production builds, so it is not part of this; it is written down in
DEVELOPMENT.md §4b as the next step.

## Data this touches

### On the droplet, by `unproduction.sh`

| Thing | What happens | Why |
|---|---|---|
| `/etc/excalidraw-api.env` | `APP_ORIGIN` → `http://<ip>`, `COOKIE_SECURE=false`, a fresh `JWT_SECRET`, S3 variables replaced or emptied | the box answers on an IP over HTTP, and must not sign tokens production would accept |
| `app_settings` row `storage` | deleted | it holds the production Spaces key, encrypted under the old `JWT_SECRET`; deleting it makes the environment's storage config the one that applies |
| `users.password_hash` | every row replaced with an unusable value; one named account gets a fresh random password, written to `/root/dev-admin-password` | the box serves plain HTTP, so a password typed into it travels in clear text. No real account's password may work there |
| `refresh_tokens`, `oauth_codes`, `oauth_tokens` | emptied | sessions and grants minted by production must not continue on a box with a different secret |
| `oauth_clients`, `mcp_keys` | deleted | they are credentials pointing at production integrations |
| `excalidraw-backup.timer` | disabled | otherwise the clone uploads its own dumps into the production backup prefix in Spaces |
| nginx site | a dev site generated from the production one: port 80, `server_name _`, no TLS block, no HTTPS redirect | certbot's redirect sends `http://<ip>` to `https://<ip>`, where the production certificate does not match |
| `/opt/excalidraw/app/current` | replaced with a placeholder page | see "The editor is built per host" |
| `/etc/excalidraw-dev` | created, holding the date and the snapshot it came from | so anything later can tell what this host is |

The scene, drawing, workspace and icon tables are **not** touched. Real
drawings at real scale are the whole point of the exercise.

### Object storage

Blob bytes live in Spaces; `workspace_blobs.s3_key` points at them. Three ways
to run the dev box, chosen by what is passed to `prepare`:

| `DEV_S3_*` | Driver | Images from production | New uploads |
|---|---|---|---|
| unset (default) | local disk | **missing** | work, on the droplet's disk |
| a read-only key for the production bucket | Spaces | visible | fail |
| a key for a copied dev bucket | Spaces | visible | work |

The default is local disk because it is the only one that cannot reach
production storage at all. A copied bucket is the realistic choice;
`dev-env.sh sync-bucket` copies one, and takes the keys from the operator's
environment.

## How it is verified

Local first, because that is the rule. The two file rewrites — the service
environment and the nginx site — live in `scripts/dev-env/configure.mjs` rather
than inside the shell script precisely so they can be tested without a
droplet:

```bash
yarn test:app --watch=false scripts/dev-env   # 15 tests
bash -n scripts/dev-env/*.sh                  # also a CI job
```

The tests assert what matters rather than the shape of the output: that the
rewritten environment has no object-storage value left in it, that the
generated nginx site carries no certificate, no HTTPS redirect and no host
name, that it still contains the proxy, the upgrade map and the security
headers, that its braces balance, and that an unrecognised file is refused
rather than turned into a broken site.

**Not verified locally:** the generated site has never been through a real
`nginx -t` here, because nginx is not installed on the development machine. The
script runs `nginx -t` on the droplet before reloading and puts the production
site back if it fails, which is the backstop. The first `prepare` on a real
droplet is where that gets confirmed.

Then on the droplet itself, the first time it is created, and recorded in
HANDOFF.md:

1. `curl -sI http://<ip>/api/me` answers 401 — the API is up and nobody is
   signed in.
2. `http://<ip>/editor` serves the placeholder before a dev deploy, and the
   editor after one.
3. The built bundle on the droplet contains the dev IP and not
   `draw.devopsproject.dev`:
   `grep -rl "draw.devopsproject.dev" /opt/excalidraw/app/current/assets/` is empty.
4. Signing in as a real production account fails with that account's real
   password; the dev admin password from `/root/dev-admin-password` works.
5. A production drawing opens with its shapes. With the default local-disk
   driver its images are missing, and that is expected and stated.
6. `systemctl is-enabled excalidraw-backup.timer` reports disabled.
7. The production site is still answering 200 and nothing new appeared in the
   production bucket during the exercise.

## Rollback

Nothing on production changes, so there is nothing to roll back there. The dev
droplet is disposable: `dev-env.sh down` destroys it, and the snapshot it came
from is untouched. A bad dev deploy is corrected by `excalidraw-deploy rollback`
on the droplet, exactly as on production, or by destroying the droplet.

The one irreversible act in this spec is `down`, which destroys the droplet and
everything written on it. It asks before doing it.

## Cost

A `s-2vcpu-4gb` droplet is about $24 a month, roughly 3.5 cents an hour.
Created for an afternoon's verification and destroyed afterwards, a release
cycle costs cents. Left running, it costs the same as a second production
server, which is why `up` and `down` exist rather than one permanent box.
