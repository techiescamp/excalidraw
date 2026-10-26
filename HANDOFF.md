# Handoff

The shared log between whoever works here — Claude, Codex, or a person. Read it
before starting. Add to it before stopping.

`DEVELOPMENT.md` says *how* to work. This file says *what has happened*, so the
next agent does not rediscover it, redo it, or undo it.

---

## Rules for this file

1. **Read it before and after work.** Before touching anything, read the Current
   state and open items. Check it again before stopping.
2. **Record the plan before changing code, then update it before you stop.**
   Write the branch and intended changes in a short log entry first. Finish
   that entry with what changed, checks run, and what remains.
3. **Newest entry at the top**, under Log.
4. **Record what is NOT done** as plainly as what is. A half-finished change
   that nobody knows is half-finished is worse than one not started.
5. **Record what was verified and how.** "Tests pass" is not evidence unless it
   says which tests and where they ran.
6. **Never record a secret.** Names of secrets, never values.
7. Keep an entry short. What changed, why, how it was checked, what is left.

---

## Current state

**Branches**

```
master    upstream Excalidraw only, never deployed from
main      production code
dev       integration; features merge here first
mcp       duplicate of dev, to be deleted
background-removal  merged 8 October, to be deleted
```

**Deployed right now:** commit `cca6e5fd`, installed by hand before the
pipeline existed.

**Pipelines** — on branch `feature/cicd-pipeline`, pull request #1, not merged:

| File | State |
|---|---|
| `.github/workflows/ci.yml` | written, running on PR #1 |
| `.github/workflows/release.yml` | written, never run |
| `.github/workflows/deploy.yml` | written, never run |
| `.github/scripts/notify-discord.sh` | written, tested against an unreachable webhook |
| `server/deploy/excalidraw-deploy` | written, **not installed on the server** |
| `server/deploy/ci-deploy.sudoers` | written, **not applied** |

**GitHub configuration**

- `production` environment exists, `techiescamp` is a required reviewer
- Environment secrets set: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`,
  `DISCORD_WEBHOOK`. The same four also exist at repository level.
- **No branch rulesets.** One was created and then removed at the owner's
  request. Do not add protection rules unless asked.

**Server** — `139.59.41.208`, Ubuntu, 2 vCPU / 4 GB

- `deploy` — human account, full sudo, three people's keys on it
- `ci-deploy` — for GitHub Actions, key installed, **no sudo yet**
- `excalidraw` — the service account
- Root SSH is disabled on purpose

**Access limits to know about**

- The `Sulaimanhameed` account has push but **not admin**, so rulesets,
  environments and repository settings fail with 403 or 404 from the API. The
  owner does those, or does them in the browser.
- An agent does not enter private keys, webhook URLs or passwords into forms or
  commands. Fill in the name, let the person paste the value.

---

## Open items

- [ ] Merge PR #1 into `dev`, then `dev` into `main`
- [ ] Delete `mcp` and `background-removal` after that merge (owner agreed)
- [ ] Install `excalidraw-deploy` and its sudoers rule on the server —
      **`deploy.yml` fails without this**
- [ ] Tag `v1.0.0` for the current production state, so there is a rollback point
- [ ] First release through `release.yml`, then a manual deploy through
      `deploy.yml`
- [ ] Alerts for lock waits and stuck transactions (`DEVELOPMENT.md` §7b)
- [ ] Rotate the Spaces keys, the DigitalOcean token and the first Discord
      webhook — all were pasted into a chat
- [ ] The API has no lint configuration of its own; it is excluded from the
      editor's

---

## Log

### 2026-10-26 — Codex — local Proxima Nova Extra Condensed preview

Plan: add regular and bold picker options on a separate local branch, verify
them in the local editor, and keep the demo font files off GitHub and production.

Added regular and bold Proxima Nova Extra Condensed font-picker options on the
local `feature/nova-proxy-font` branch. Converted the supplied Fontspring demo
OTF files to WOFF2 so they render in the editor. The demo fonts are for local
preview only; do not commit, push, or deploy them. Replace them with licensed
webfont files before distribution.

Verified the bold picker test fails when its registration is removed, then
passes with the registration restored. The font-picker tests, full frontend
suite, typecheck, lint and editor build pass. Both faces render in the local
browser preview.

**Not done:** no commit, GitHub push, or production deployment. The focused
Prettier check passes for the font code and spec. The repository-wide
`yarn test:other` still reports the pre-existing `HANDOFF.md` formatting issue.
The SVG export dialog preview renders the font, but an exported file was not
confirmed. A later request to push into `dev` was not carried out: Fontspring's
demo-font guidance prohibits sharing or embedding demo fonts, and this repo
requires changes to reach `dev` through a pull request. Licensed webfont files
are needed to continue with a remote change.

### 2026-10-26 — Claude — pipelines, and what turning CI on exposed

Added `ci.yml`, `release.yml`, `deploy.yml`, the Discord notifier, the server
install script and `DEVELOPMENT.md`. Created `main` from `dev`. Created the
`production` environment with a required reviewer.

CI had never run on this fork's branches: the eleven inherited workflows trigger
on `master` and `release`, which nobody develops on. Its first runs found five
things that were already broken and invisible:

1. The inherited pull request title check knows only the editor's scopes, so
   every server or CI pull request would have failed before being read. Added
   `server`, `dashboard`, `ci`, `deploy`, `docs`.
2. Several files had been failing the formatting check for months.
3. Upstream's prettier collapses each paragraph to one line, which makes a
   one-word change rewrite a whole paragraph. Documentation is excluded from it;
   prettier still owns code and config.
4. **The server tests only passed because of undocumented local state.** The
   schema grants to the `excalidraw` role, which exists on a developer's machine
   and not on a clean one. Both harnesses now create it if absent.
5. The tests imported `jsdom` from the workspace root without declaring it, so
   installing the server alone failed. Declared as a dev dependency.

Also fixed a test that failed about one run in four: the three server test files
ran in parallel against one PostgreSQL, each creating and force-dropping its own
database. They now run one at a time.

**Not done:** nothing has been released or deployed through the pipeline. The
install script is not on the server. No tag exists.

### 2026-10-23/24 — Claude — images stored once, and two outages

Images lived inside each scene as base64; one drawing with 109 of them was
27.6 MB, and saving a shared drawing re-read and rewrote all of it. They now
live once per workspace under the digest of their own bytes.

Measured on production: scene objects 361.8 MB → 41 MB; a repeat save of the
worst drawing 4,777 ms → 772 ms; 420 drawings converted, 216 already clean.

Two production incidents came out of this work, both only visible under load:

- A drawing would not open. Hydration used the shared cache as its carrier, so
  an image fetched moments earlier could be evicted before the scene was
  assembled. A read now holds what it needs.
- The whole dashboard hung. Images were uploaded inside the transaction that
  locks the drawing's row, so the lock was held for minutes and every other save
  queued behind it until the connection pool filled. Uploads now happen before
  the transaction opens, and the in-transaction path refuses to upload at all.

Neither was caught by the tests, which check correctness and not behaviour under
load. That gap is still open.

### 2026-10-08 — Claude — storage, backups, exports

Storage went from 38.86 GB to 18.12 GB and from 42,282 objects to 12,777, after
archiving everything first and proving a restore by deleting a real version and
putting it back.

Two leaks were fixed: a thumbnail and a collaboration snapshot were written on
every save and their predecessors never removed — 87 thumbnails in use had
accumulated 17,459 abandoned ones.

The backup was reporting failures as success: a file it could not read was
skipped while the run still finished with "backup complete". It now fails if
anything is missed, checksums every object, reads each one back, and runs daily
rather than on Sundays only.

A delete script of mine reported removing 9,069 objects it had never removed,
because `DeleteObjects` reports per-object refusals in its response rather than
raising. Auditing for that same mistake is what found the backup fault.
