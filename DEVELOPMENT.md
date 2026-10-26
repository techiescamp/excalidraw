# Development process

How work gets into production in this repository. It is written to be followed
by an AI agent — Claude Code, Codex, or any other — and by a person reading the
same page. Where it says "the agent", a person doing the work by hand follows
the same rule.

`AGENTS.md` and `CLAUDE.md` both point here. This file is the source of truth;
if they disagree with it, this file wins.

This file says **how** to work. [HANDOFF.md](HANDOFF.md) says **what has
happened** — read that before starting, and add to it before stopping, so the
next agent does not rediscover, redo or undo your work.

---

## 1. What this repository holds

A fork of Excalidraw with three separately deployable pieces:

| Piece | Path | Deployed as | Needs a build |
|---|---|---|---|
| Editor | `excalidraw-app/`, `packages/` | versioned release directory + `current` symlink | yes, Vite |
| API | `server/` | files under `/opt/excalidraw/api` | no |
| Dashboard | `dashboard/` | files under `/opt/excalidraw/dashboard` | no |

The API owns the database and object storage. The dashboard is static files the
API serves. The editor is a compiled bundle nginx serves.

Deployment detail lives in `deploy.md` and is not repeated here.

---

## 2. Branches

```
master    upstream Excalidraw only. Never deploy from it. Merge upstream in, never out.
main      production. Protected. Every tagged release is cut from here.
develop   integration. Features land here first.
feature/* one unit of work. Short-lived. Deleted after merge.
fix/*     same, for corrections.
hotfix/*  branched from main when production is broken. Merged to main AND develop.
```

**Today this does not hold.** `dev` and `mcp` point at the same commit and both
have been pushed to directly. Section 10 says how to get from here to there.

Rules:

- One branch per feature or fix. Name it for the change: `feature/image-dedupe`,
  `fix/export-download`.
- Never commit directly to `main` or `develop`. Every change arrives by pull
  request.
- Delete the branch once merged. A merged branch left behind is noise —
  `background-removal` has been sitting merged since 8 October.
- Rebase or merge `develop` into your branch to resolve conflicts. Never force
  push to a shared branch.

---

## 2a. The life of one feature

The whole path, start to finish. "Icons" is used as the example.

### 1. Write its spec first

Before any code, a spec file for that one feature:

```
docs/specs/icons.md
```

It states: what the feature does, what it does **not** do, the data it touches
(tables, migrations, stored objects), how it is verified locally, and how it is
rolled back. One page is enough. The point is that the thing being built is
decided before it is built, not discovered while building.

The spec file is the first commit on the branch. It is reviewed with the code,
and updated if the design changes on the way.

### 2. Branch

```bash
git checkout develop && git pull
git checkout -b feature/icons
```

### 3. Build it

Code plus tests, following section 3. Commit as you go.

### 4. Verify locally

Section 4a. There is no staging server, so this is the only place it runs
before production. Write down what you observed.

### 5. Pull request into `develop`

Open it against `develop`. CI must be green and a human reviews it. The
description says what changed, how it was verified, and what was not tested.

### 6. Merge to `develop`, then let it settle

Merge once approved. Delete the branch. Do not continue straight to production
in the same motion.

### 7. Pull request from `develop` into `main`

A separate pull request. This one is the production decision, so it is reviewed
as such, not as a formality.

### 8. Tag and build the artifact

Merged to `main`, cut the tag. The pipeline builds the release artifacts from
**`main`** — never from a laptop, never from `develop`.

### 9. Deploy that artifact

The pipeline installs the artifact from the release. Section 7a is the gate and
section 7b is what gets announced.

```
feature/icons → develop → main → tag → artifact → production
```

Each arrow is a pull request or a pipeline. No arrow is a person typing rsync.

---

## 3. What the agent must do, every time

This is the part that is non-negotiable. Two production outages in one week
came from skipping it.

### Before writing code

1. Read the existing code in the area you are changing. Do not assume.
2. State what you are about to change and why, in one or two sentences.
3. Create a branch. Never start work on `main` or `develop`.

### While writing code

4. Match the style already in the file — naming, comment density, error
   handling. The repository has a voice; do not introduce a second one.
5. Write a test for the behaviour you are adding or the bug you are fixing.
   **A bug fix without a test that fails before the fix is not finished.**
   Prove the test catches it: break the fix, watch the test fail, restore it.

### Before opening a pull request

6. Run every check in section 4 locally. All of them. Not a selection.
7. If a check fails, fix it. Do not open the pull request and hope CI disagrees.

### In the pull request

8. Say what changed, why, and how you verified it. Include the measurement if
   the change is about speed or size.
9. Say what you did **not** test. An agent that lists its blind spots is more
   useful than one that claims completeness.

### After merge

10. Delete the branch.

### Never

- Never push straight to `main` or `develop`.
- Never deploy by hand from a laptop. Deployment is section 7.
- Never deploy anything that has not run on the local instance first. There is
  no staging server; section 4a is the substitute and section 7a is the gate.
- Never report success you did not verify. Read the result back from the system
  that was supposed to change — a tool's own success message is not evidence.
  A script once reported deleting 9,069 objects it had not deleted, because
  nothing checked the response.
- Never silently drop user data to make an operation succeed. Fail loudly
  instead. A read that cannot resolve an image must error, not return a drawing
  with the image missing, because the caller will save that back.

---

## 4. Checks that must pass

Run from the repository root unless stated.

```bash
yarn install                       # once, or after dependency changes
yarn test:typecheck                # tsc, must report zero errors
yarn test:code                     # eslint, --max-warnings=0
yarn test:other                    # prettier formatting
yarn test:app --watch=false        # frontend tests (vitest)
```

Server tests need a PostgreSQL instance the suite is allowed to own: it creates
and drops its own databases, and creates the `excalidraw` role the schema grants
to if that role is absent. Connecting as a superuser on a local instance covers
both.

```bash
cd server
TEST_DATABASE_URL="postgres://<user>@localhost:5432/postgres" npm test
```

If the change touches the editor or `packages/`, the build must also succeed:

```bash
NODE_OPTIONS=--max-old-space-size=4096 yarn build:app
```

A change is ready when all of these pass. "It works on my machine" is not a
check.

### A note on the test suite

Tests here verify correctness, not behaviour under load. Both outages this week
— a cache evicting an image mid-read, and a row lock held across an upload —
only appear when many drawings are open and several people are saving. Passing
tests do not mean the change is safe under load. Section 9 covers that gap.

---

## 4a. Local verification — this project's staging

There is **no staging server**. Local is the only place a change can be tried
before production, so local verification is not optional and is not "I ran the
tests". Production is the next environment after a laptop, which is exactly why
the gate in section 7a exists.

### The disposable instance

`server/test/dev-instance.mjs` starts a complete, throwaway copy of the
application: its own database, every migration applied, a seeded admin and
workspace, the local filesystem standing in for object storage, and the real
server listening.

```bash
cd server
TEST_DATABASE_URL="postgres://<user>@localhost:5432/postgres" \
  node test/dev-instance.mjs
```

| | |
|---|---|
| URL | `http://127.0.0.1:55442` (override with `BROWSER_PORT`) |
| Sign in | `browser-admin` / `Local browser verification password 2026!` |
| Database | `excalidraw_browser_<pid>`, created fresh each run |
| Storage | a temporary directory, not DigitalOcean Spaces |

It refuses to start against anything but `localhost`, so it cannot touch
production data. Each run leaves its database behind; drop old
`excalidraw_browser_*` databases when they accumulate.

For editor work, run the dev server instead:

```bash
yarn --cwd ./excalidraw-app start        # http://localhost:3001
```

### What must actually be exercised

Opening the page is not verification. Before a change may be deployed, the
agent exercises **the path it changed** against the local instance and reports
what it saw:

- A save path → save, reload, confirm the data came back. Then save again from
  a second browser tab and confirm neither overwrote the other.
- A read path → open a drawing that uses the feature, confirm the content is
  whole. Not "status 200" — the actual elements and images.
- A migration → run it against a fresh instance **and** against a copy of a
  production dump, so it is tested against real shapes, not just empty tables.
- Anything touching images or storage → use a drawing with many images. The
  bugs in section 9 only appeared with a hundred of them.
- A UI change → look at it. Screenshot it.

### Faults that local alone will not find

Be honest about this rather than assuming a green local run means safe:

- **Concurrency.** One person clicking is not several people saving. Both
  October outages needed load.
- **Scale.** A local database with three drawings behaves unlike one with 636.
  Restore a production dump locally when the change touches queries or
  migrations.
- **Real object storage.** The local instance writes to a directory. Latency,
  partial failures and permission errors from Spaces do not appear.
- **Data the fixture does not have.** Old drawings in formats the seed never
  creates. Section 7a's dump restore is what covers this.

When a change cannot be verified locally, say so explicitly in the pull
request and name what is unverified. Do not let it pass silently.

---

## 5. Commits

One commit per logical change. The message explains **why**, in prose, wrapped
at 72 characters:

```
fix: do not upload images while holding the drawing's row

Saving split the images out inside the transaction that locks the scene
row, so the lock was held for as long as the uploads took. On a drawing
with a hundred images that is seconds to minutes, and every other save
of it queued behind.

Uploading now happens before the transaction opens.
```

Prefixes: `feat:` `fix:` `docs:` `refactor:` `test:` `chore:` `perf:`.
A `feat:` or `fix:` that changes behaviour decides the next version number —
see section 6.

Do not describe the diff. The diff is already in the commit.

---

## 6. Versions, tags and releases

Semantic versioning: `vMAJOR.MINOR.PATCH`.

| Change | Bump |
|---|---|
| Breaking change, or a migration that cannot be rolled back | MAJOR |
| New feature | MINOR |
| Fix only | PATCH |

A release is cut from `main`:

```bash
git checkout main && git pull
git tag -a v1.4.0 -m "v1.4.0"
git push origin v1.4.0
```

Pushing the tag starts the release pipeline (section 7), which produces:

```
excalidraw-editor-v1.4.0.tar.gz     built editor bundle
excalidraw-server-v1.4.0.tar.gz     server/ and dashboard/, no node_modules
checksums.txt                       sha256 of each artifact
```

All three attach to a GitHub Release whose notes come from the commits since
the previous tag. **A deploy installs a release artifact. It never copies from
a working directory.** That is what makes a rollback possible: reinstall the
previous artifact.

The repository has **no tags today**. `v1.0.0` is the current production state.

---

## 7. Pipelines

### 7.1 `ci.yml` — on every pull request, and on push to `develop` and `main`

```yaml
on:
  pull_request:
  push:
    branches: [develop, main]
```

Jobs, all required to pass before merge:

| Job | What it runs |
|---|---|
| `lint` | `yarn test:code`, `yarn test:other` |
| `typecheck` | `yarn test:typecheck` |
| `frontend` | `yarn test:app --watch=false` |
| `server` | `npm test` in `server/`, with a `postgres:16` service container |
| `build` | `yarn build:app`, proving it compiles |

The `server` job is the important one. **No workflow in this repository
currently runs the server tests at all** — the 11 inherited workflows trigger
on `master` and `release`, which this fork does not develop on. 51 server tests
exist and have never run automatically.

### 7a. The gate before production

**Nothing reaches production that has not passed locally first.** In order, and
no step may be skipped because the change "looks small":

1. Every check in section 4 passes.
2. The change is exercised on the local instance as section 4a describes, and
   what was observed is written down.
3. If the change touches the database, storage or a query: restore the most
   recent production dump into a local database and run the change against it.
   A migration that works on an empty table and fails on 636 drawings is worse
   than no migration.
4. It is merged to `develop` through a pull request with CI green.
5. `develop` is left to settle. Nothing is deployed in the same motion as the
   merge.
6. A tag is cut from `main` and the release artifact is built (section 6).
7. Production is deployed from that artifact, by the pipeline, with a human
   approving the step.
8. After deploying: check the health endpoint, read the service log for errors,
   and check the database for sessions waiting on locks. Say what you saw. The
   alerts in section 7b watch the same things continuously; they do not replace
   looking once, by hand, straight after a deploy.

If any step fails, the deploy stops. It does not continue "to see if the rest
works".

**A production deploy is never the first time a change runs.** Every production
incident in this repository so far has come from breaking that rule — code
written, deployed by hand, and tried for the first time by real users.

### 7b. Notifications and alerts

Everything below posts to Discord through a webhook. The URL is a secret —
`DISCORD_WEBHOOK` in GitHub Actions for deploy messages, and in the server's
environment file for alerts. **A person with admin adds these; an agent cannot
and must not.** Two channels, because they are read differently: deploys are
news, alerts are someone's evening interrupted.

#### Deployment messages

**Before** the deploy starts:

```
Deploying v1.4.0 to production
  from   v1.3.0
  by     sulaiman
  changes
    feat: icon library search
    fix: export download
  database dump taken: pre-v1.4.0-20261026T1830Z.sql.gz
```

**After** it finishes:

```
v1.4.0 is live
  took          47s
  health check  200
  errors since  0
  rollback      install v1.3.0
```

**If it fails**, the message says so, names the step, and states what was done
about it:

```
v1.4.0 FAILED and was rolled back
  step     health check after restart
  cause    api returned 502 for 30s
  action   reinstalled v1.3.0, service healthy
```

The rollback line is in every message, including the successful one, so nobody
has to look it up while the site is down.

#### Alerts from the running system

These fire on their own. The thresholds come from real failures, not guesses —
section 9 is what each one would have caught.

| Alert | Fires when | What it would have caught |
|---|---|---|
| **Lock wait** | any query waiting on a lock > 5s | 24 Oct: the dashboard hung for everyone |
| **Idle in transaction** | a transaction open and idle > 30s | the same outage, earlier |
| **Connection pool** | in-use connections > 80% of the pool | the moment before the site stopped |
| **Slow save** | a scene save taking > 10s | image-heavy drawings degrading |
| **Error rate** | 5xx responses > 5 in 5 minutes | anything broken by a deploy |
| **Health check** | `/api/health` failing twice in a row | the service down or wedged |
| **Disk** | droplet disk > 85% used | storage growth before it bites |
| **Backup** | the nightly backup fails or is skipped | a backup that silently stopped |

An alert names the problem, the number that crossed the line, and where to
look:

```
ALERT  lock wait
  5 queries waiting, longest 9m38s
  blocking pid 360799, idle in transaction
  blocked: UPDATE scenes SET collab_s3_key ...
  check: SELECT * FROM pg_stat_activity WHERE wait_event_type = 'Lock'
```

Each alert repeats at most once every 15 minutes, and posts a recovery message
when the condition clears, so a bad hour is a few messages rather than
hundreds.

#### Where this lives

A small module in the server reads these from `pg_stat_activity` and its own
counters on a timer, and posts when a threshold is crossed. It is deliberately
simple: no monitoring service to run, no agent to install, one webhook. If the
system grows past that, replace it with real monitoring rather than extending
this.

### 7.2 `release.yml` — on a pushed tag `v*`

Builds the editor, packages server and dashboard, writes checksums, creates the
GitHub Release, uploads all three files.

### 7.3 `deploy.yml` — manual, choosing an environment and a tag

```
download the release artifact and verify its checksum
dump the database
run migrations
install the files
restart the service
health check
if the health check fails, reinstall the previous release and restart
```

There is no staging server, so `develop` has no environment to deploy to;
section 4a's local instance plays that role. Production requires a human
approval step in the GitHub environment, and the pipeline is the only thing
that touches production.

Secrets needed: `DEPLOY_SSH_KEY`, `DEPLOY_HOST`, `DEPLOY_USER`,
`DISCORD_WEBHOOK`. A person with repository admin adds these; an agent cannot
and must not.

---

## 8. Database migrations

- One numbered file per change: `server/migration-0NN-name.sql`.
- Register it in **three** places or it will not run: `server/bin/migrate.mjs`,
  `server/test/private-workspaces.test.js`, `server/test/dev-instance.mjs`.
  This duplication is a known wart; until it is fixed, check all three.
- Migrations run before the new code starts, never after.
- A migration must be safe to run while the old code is still serving. Add
  columns and tables; do not remove or rename in the same release that stops
  using them.

---

## 9. Operational rules learned the hard way

These exist because each one caused a real failure.

**Never hold a database transaction across network or storage I/O.** Uploading
inside a transaction held the drawing's row for minutes, every other save
queued behind it, the connection pool filled, and the whole site stopped
loading. Do the slow work first, then open the transaction for the fast writes.
`scene-blobs.js` now refuses to upload when told it is inside one.

**A cache may not be the only place a value lives.** A read that fetched images
into a shared cache and read them back from it failed when the cache evicted
them mid-request. Hold what the request needs for as long as it needs it; treat
the cache purely as a way to avoid fetching again.

**Check what an API actually returned.** `DeleteObjects` reports per-object
refusals in its response body rather than raising. Counting batches and
announcing success deleted nothing while claiming otherwise.

**Fail loudly rather than returning partial data.** A missing image must error.
Returning the drawing without it invites the client to save that version back
and lose the image permanently.

**A deploy is not finished until someone has opened the application and
looked.** A release was published whose editor had no API address, because the
configuration compiled into it lived in a file that is not in the repository.
It built, it passed, it installed, it served pages, and it answered every check
made against the API -- and it silently ignored every workspace drawing. The
fault appeared only on screen, as an empty canvas that read as missing images.
Check the thing the person uses, not the pieces underneath it.

**A build that depends on configuration must prove it has it.** The release now
refuses to publish an editor that does not contain the API address. A check
that fails loudly at build time is worth more than one that waits for a user to
open a drawing.

**Back up before anything irreversible, and verify the backup by reading it
back.** Not "the command exited zero" — read a sample and parse it.

---

## 10. Getting from today to this

In order. Each step is independently useful.

1. **Create `main` from the current `dev`.** Protect `main` and `develop`:
   require a pull request, require the CI checks, no force push. *Needs repo
   admin — a person does this.*
2. **Rename `dev` to `develop`. Retire `mcp`** — it duplicates `dev`. Delete
   `background-removal`, merged on 8 October.
3. **Add `ci.yml`.** Until the server job is green, nothing else matters.
4. **Tag the current production state `v1.0.0`** so there is a known-good point
   to roll back to.
5. **Add `release.yml`** and cut `v1.1.0` through it, to prove the artifacts
   build.
6. **Add `deploy.yml`.** With no staging server, prove it by deploying one
   release to production during a quiet hour, with the previous artifact ready
   to reinstall.
7. **Add the alerts in section 7b**, starting with the lock wait and idle
   transaction ones. The 24 October outage would have been a Discord message
   instead of you finding a frozen site.
8. **Add a load check** — many drawings open, concurrent saves. This is the
   gap the current tests do not cover.

Steps 1 and 2 need repository admin. An agent prepares everything else and says
clearly which parts it cannot do.
