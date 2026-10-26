# Handoff

The shared log between whoever works here — Claude, Codex, or a person. Read it before starting. Add to it before stopping.

`DEVELOPMENT.md` says _how_ to work. This file says _what has happened_, so the next agent does not rediscover it, redo it, or undo it.

---

## Rules for this file

1. **Read it before and after work.** Before touching anything, read the Current state and open items. Check it again before stopping.
2. **Record the plan before changing code, then update it before you stop.** Write the branch and intended changes in a short log entry first. Finish that entry with what changed, checks run, and what remains.
3. **Newest entry at the top**, under Log.
4. **Record what is NOT done** as plainly as what is. A half-finished change that nobody knows is half-finished is worse than one not started.
5. **Record what was verified and how.** "Tests pass" is not evidence unless it says which tests and where they ran.
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

**Deployed right now:** commit `cca6e5fd`, installed by hand before the pipeline existed.

**Pipelines** — on branch `feature/cicd-pipeline`, pull request #1, not merged:

| File | State |
| --- | --- |
| `.github/workflows/ci.yml` | written, running on PR #1 |
| `.github/workflows/release.yml` | written, never run |
| `.github/workflows/deploy.yml` | written, never run |
| `.github/scripts/notify-discord.sh` | written, tested against an unreachable webhook |
| `server/deploy/excalidraw-deploy` | written, **not installed on the server** |
| `server/deploy/ci-deploy.sudoers` | written, **not applied** |

**GitHub configuration**

- `production` environment exists, `techiescamp` is a required reviewer
- Environment secrets set: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DISCORD_WEBHOOK`. The same four also exist at repository level.
- **No branch rulesets.** One was created and then removed at the owner's request. Do not add protection rules unless asked.

**Server** — `139.59.41.208`, Ubuntu, 2 vCPU / 4 GB

- `deploy` — human account, full sudo, three people's keys on it
- `ci-deploy` — for GitHub Actions, key installed, **no sudo yet**
- `excalidraw` — the service account
- Root SSH is disabled on purpose

**Access limits to know about**

- The `Sulaimanhameed` account has push but **not admin**, so rulesets, environments and repository settings fail with 403 or 404 from the API. The owner does those, or does them in the browser.
- An agent does not enter private keys, webhook URLs or passwords into forms or commands. Fill in the name, let the person paste the value.

---

## Open items

- [ ] Merge PR #1 into `dev`, then `dev` into `main`
- [ ] Delete `mcp` and `background-removal` after that merge (owner agreed)
- [ ] Install `excalidraw-deploy` and its sudoers rule on the server — **`deploy.yml` fails without this**
- [ ] Tag `v1.0.0` for the current production state, so there is a rollback point
- [ ] First release through `release.yml`, then a manual deploy through `deploy.yml`
- [ ] Alerts for lock waits and stuck transactions (`DEVELOPMENT.md` §7b)
- [ ] Rotate the Spaces keys, the DigitalOcean token and the first Discord webhook — all were pasted into a chat
- [ ] The API has no lint configuration of its own; it is excluded from the editor's

---

## Log

### 2026-10-26 — Claude — workspace UI cleanup, held on `dev`

**Branch:** `feature/workspace-ui-cleanup` → `dev`. CI green (5/5). **Deliberately not on `main`:** more work is coming and it ships in one release, by the owner's decision. Production stays on `v1.3.0`.

Four things, all reported from using the workspace:

- The Excalidraw+ promotion beside Share is gone. This install is self-hosted, so it advertised something nobody here can buy (`excalidraw-app/App.tsx`, `renderTopRightUI`).
- Collection icons: 16 → 64, grouped by what collections get named after, and the grid scrolls instead of stretching the dialog.
- Workspace settings and Team members are no longer sidebar rows. Both are tabs of Administration, linked at the foot of the same sidebar, so nothing became unreachable and the collection list gets the height.
- Quick search (⌘P) only ever asked `/scenes`, so a collection could not be found by name. Collections are matched in memory and listed first with their icon. The in-page "Search scenes" filter is still scenes only, on purpose — it carries a scene count.

_Verified_ on the disposable instance in a browser: sidebar rows gone, picker full and scrolling with a pick that stuck, `gpu` finds "GPU Course — Collection", `draft` still finds the scene, editor top-right at 1440px shows only Share. 1920 frontend tests, 54 server tests, typecheck, lint, prettier.

_Also this session:_ `v1.3.0` deployed and checked live 10 minutes after — dashboard, thumbnails, a drawing with images, no console errors.

---

### 2026-10-26 — Claude — recovered drafts now merge; deploy announcements rewritten

**Branches:** `fix/draft-merge`, `fix/deploy-notifications` → `dev` → `main`. **Tag:** `v1.3.0` (artifacts built). **Not deployed** — waiting on approval.

_Draft merge._ Opening a drawing that the server had moved past while a local draft sat in IndexedDB showed "Drawing changed on the server. Save your draft as a copy or reload." and left the author to reconcile by hand. The server has merged stale saves element by element since v1.2.0, so the editor now sends the draft to be merged and carries on (`excalidraw-app/data/workspaceScene.ts`, `loadWorkspaceScene`).

**The trap, worth knowing:** the draft must be sent at _its own_ version, not the server's. A save at the version the server is already on **replaces** the scene; only a save it can see is behind is merged. The first version of this fix sent the server's version and silently discarded the other person's work. It was caught in the browser, not by a check. `server/test/private-workspaces. test.js` now pins the replace-vs-merge difference.

_Verified:_ 54/54 server tests, typecheck, lint, prettier, editor build, CI green on `dev`. End-to-end in a browser against the disposable instance: a draft taken at v6 plus another person's save at v7 → all five elements kept, draft cleared from IndexedDB, no error banner.

_Deploy announcements._ The Discord messages printed the characters `\n` instead of breaking the line — a backslash escape in double quotes is not expanded by bash, and `jq --arg` passes it through. Rebuilt with `printf`, and the facts are embed fields now (version, health, who, how long, rollback, link), with a closing line picked from a few. `.github/scripts/notify-discord. sh`, timing passed from `deploy.yml`.

_Teardown race._ Server tests went red on CI while passing locally: every test passed, then dropping the test database terminated backends that had not finished closing, which became an uncaughtException and failed the whole file. Teardown now waits for them to clear, and pool errors are ignored only once teardown has started.

_New rule in `DEVELOPMENT.md` §2a.10:_ a green health check is not a verified deploy. Wait 5–10 minutes after the release goes live, then open the site, sign in, open a drawing, and exercise what changed.

**Left open:** `v1.3.0` is not deployed. Nothing deployable changed after the tag (`git diff --name-only v1.3.0 main` is CI, docs and tests only), and the deploy workflow runs from `main`, so the new announcements will be used.

---

### 2026-10-26 — Claude — a release that built, passed and did nothing

The first two releases cut through the pipeline, v1.0.0 and v1.1.0, were built without `.env.production.local`, which is not in the repository and held the editor's API address. Everything compiled, every check passed, the install succeeded, and the editor loaded as plain local Excalidraw: it ignores workspace drawings entirely, so opening one showed an empty canvas that looked like the images had gone.

It was not found by any check because every check looked at the pieces -- the API, the artifacts, the service -- and none opened a drawing. **Open the application and look, every time.**

release.yml now writes that configuration and refuses to publish a bundle without the API address in it.

Separately, handing the editor image references made a drawing with a hundred images take fourteen seconds to appear, because each request went to object storage, about half a second each. The images were already held in memory for other readers; the endpoint now uses that, and reading a scene starts loading its images in the background. The test for it uses a storage with latency, since the earlier one ran against a local directory where a read costs nothing -- which is why the cost only showed in production.

### 2026-10-26 — Codex — local Proxima Nova Extra Condensed preview

Plan: add regular and bold picker options on a separate local branch, verify them in the local editor, and keep the demo font files off GitHub and production.

Added regular and bold Proxima Nova Extra Condensed font-picker options on the local `feature/nova-proxy-font` branch. Converted the supplied Fontspring demo OTF files to WOFF2 so they render in the editor. The demo fonts are for local preview only; do not commit, push, or deploy them. Replace them with licensed webfont files before distribution.

Verified the bold picker test fails when its registration is removed, then passes with the registration restored. The font-picker tests, full frontend suite, typecheck, lint and editor build pass. Both faces render in the local browser preview.

**Not done:** no commit, GitHub push, or production deployment. The focused Prettier check passes for the font code and spec. The repository-wide `yarn test:other` still reports the pre-existing `HANDOFF.md` formatting issue. The SVG export dialog preview renders the font, but an exported file was not confirmed. A later request to push into `dev` was not carried out: Fontspring's demo-font guidance prohibits sharing or embedding demo fonts, and this repo requires changes to reach `dev` through a pull request. Licensed webfont files are needed to continue with a remote change.

### 2026-10-26 — Claude — pipelines, and what turning CI on exposed

Added `ci.yml`, `release.yml`, `deploy.yml`, the Discord notifier, the server install script and `DEVELOPMENT.md`. Created `main` from `dev`. Created the `production` environment with a required reviewer.

CI had never run on this fork's branches: the eleven inherited workflows trigger on `master` and `release`, which nobody develops on. Its first runs found five things that were already broken and invisible:

1. The inherited pull request title check knows only the editor's scopes, so every server or CI pull request would have failed before being read. Added `server`, `dashboard`, `ci`, `deploy`, `docs`.
2. Several files had been failing the formatting check for months.
3. Upstream's prettier collapses each paragraph to one line, which makes a one-word change rewrite a whole paragraph. Documentation is excluded from it; prettier still owns code and config.
4. **The server tests only passed because of undocumented local state.** The schema grants to the `excalidraw` role, which exists on a developer's machine and not on a clean one. Both harnesses now create it if absent.
5. The tests imported `jsdom` from the workspace root without declaring it, so installing the server alone failed. Declared as a dev dependency.

Also fixed a test that failed about one run in four: the three server test files ran in parallel against one PostgreSQL, each creating and force-dropping its own database. They now run one at a time.

**Not done:** nothing has been released or deployed through the pipeline. The install script is not on the server. No tag exists.

### 2026-10-23/24 — Claude — images stored once, and two outages

Images lived inside each scene as base64; one drawing with 109 of them was 27.6 MB, and saving a shared drawing re-read and rewrote all of it. They now live once per workspace under the digest of their own bytes.

Measured on production: scene objects 361.8 MB → 41 MB; a repeat save of the worst drawing 4,777 ms → 772 ms; 420 drawings converted, 216 already clean.

Two production incidents came out of this work, both only visible under load:

- A drawing would not open. Hydration used the shared cache as its carrier, so an image fetched moments earlier could be evicted before the scene was assembled. A read now holds what it needs.
- The whole dashboard hung. Images were uploaded inside the transaction that locks the drawing's row, so the lock was held for minutes and every other save queued behind it until the connection pool filled. Uploads now happen before the transaction opens, and the in-transaction path refuses to upload at all.

Neither was caught by the tests, which check correctness and not behaviour under load. That gap is still open.

### 2026-10-08 — Claude — storage, backups, exports

Storage went from 38.86 GB to 18.12 GB and from 42,282 objects to 12,777, after archiving everything first and proving a restore by deleting a real version and putting it back.

Two leaks were fixed: a thumbnail and a collaboration snapshot were written on every save and their predecessors never removed — 87 thumbnails in use had accumulated 17,459 abandoned ones.

The backup was reporting failures as success: a file it could not read was skipped while the run still finished with "backup complete". It now fails if anything is missed, checksums every object, reads each one back, and runs daily rather than on Sundays only.

A delete script of mine reported removing 9,069 objects it had never removed, because `DeleteObjects` reports per-object refusals in its response rather than raising. Auditing for that same mistake is what found the backup fault.
