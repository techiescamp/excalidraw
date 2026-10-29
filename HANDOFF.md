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

### 2026-10-29 — Claude — v1.4.1 is on production; the dev droplet is gone

**Released.** `fix/canvas-overwrite` → `dev` (#5) → `main` (#7) → tag `v1.4.1`
→ `deploy.yml` with `v1.4.1`. Deploy run 40860594559, success. Production
answers 200 on `/`, 401 on `/api/me`, and the dashboard loads in a browser
with thumbnails rendering.

Production is https, so it still sends `upgrade-insecure-requests` and HSTS —
checked after the deploy, because the server change only drops those for an
instance served over http.

**The dev droplet was destroyed** at the owner's request: droplet 613811155
and the `excalidraw-dev` firewall are gone, the `excalidraw-server` snapshot
and the production droplet are untouched. The scripts stay on
`feature/dev-environment` (#6, still open) and are now proven against a real
droplet.

**What the droplet found before it was destroyed** — four faults that passed
every local check:

1. `upgrade-insecure-requests` made the application unusable on any host
   served over plain http. Every API call was rewritten to https, nothing
   listened on 443, and the dashboard hung on "Loading workspace…". **curl
   does not honour CSP**, so every health check had passed against a site no
   browser could use. Fixed and released in v1.4.1.
2. `prepare` rotates `JWT_SECRET`, which is what the 113 rows in
   `scene_room_keys` were encrypted under. Opening any of those drawings threw
   while reading its room key and answered 500 with nothing in any log. Now
   cleared along with `scenes.room_id`.
3. `prepare`'s health check slept three seconds; the real API took nearer ten,
   so it called a working box broken.
4. The firewall check compared the firewall's droplet ids to the dev
   droplet's. The firewall attaches by **tag**, so that list is always empty
   and the check compared two empty strings. It could never fail.

**Still true, and the reason the droplet could not finish its job:** a
drawing's contents are objects in Spaces, not rows in the database. With no
bucket configured the box has the index and none of the contents, and every
drawing answers 503. The snapshot's own Spaces key no longer works — rotated
after 26 October — and creating a replacement is the owner's to do:

    doctl spaces keys create dev-readonly --grants 'bucket=excalidraw-data;permission=read'
    DEV_S3_BUCKET=excalidraw-data DEV_S3_KEY_ID=… DEV_S3_SECRET=… dev-env.sh storage

`prepare` now says this out loud instead of leaving it to be discovered.

**Open, and not mine to close:** the production droplet is attached to a
firewall named `test-firewall` that admits all TCP, including port 22, from
`0.0.0.0/0`.

### 2026-10-29 — Claude — the "ghost": work vanishing, and the canvas stuttering

**Branch:** `fix/canvas-overwrite`, off `dev` at `c5282acd`. Four commits, local
only, **not pushed, not deployed**. Production stays on `v1.3.0` and still has
both faults. Spec: `docs/specs/save-without-interference.md`.

**Reported as** a screen recording of production: an icon dropped on the canvas
at ~5s, gone by ~6.5s, back at ~19.8s, "Saving…" throughout — and the editor
generally not smooth to draw on.

**Two faults, one shared origin.** The editor gives every drawing a
collaboration room the moment it is opened (`GET /scenes/:id/data` creates one
and returns the keys; a solo session's URL gains `#room=…`). The server then
read `room_id` as "people are collaborating" and merged *every* save — which
meant reading the whole stored drawing back with every image inline, and
sending it back to the caller.

1. **Work disappearing.** The editor applied that answer by assignment:
   `updateScene({ elements: scene.elements })`. The answer describes the
   drawing as it was when the request left, so anything drawn during the round
   trip was wiped, returning only when a later save carried it.
2. **The stutter.** `saveWorkspaceScene` ran on every `onChange`, which while
   dragging is every frame, and did the whole job each time: serialise the
   drawing with every image as base64, compare, deep-copy, write to IndexedDB,
   rebuild the status bar. The dashboard preview (`exportToBlob`, a full render
   to PNG) ran after every save.

**What changed**

| file | change |
|---|---|
| `excalidraw-app/App.tsx` | the applier reconciles against the live canvas instead of assigning over it, and adds files the merge brought in |
| `excalidraw-app/data/workspaceScene.ts` | `materialize` does the expensive half once a pause; the preview waits for stillness; the status bar is not rebuilt per frame |
| `server/lib/drawings.js` | a save is merged because it is **behind**, not because it named a room |
| `server/test/private-workspaces.test.js` | the merge test now covers the in-a-room, up-to-date save |

**Verified**

- `server`: `TEST_DATABASE_URL=… npm test` → 60 pass, 0 fail. Reverting the
  server change makes the new assertions fail (checked, then restored).
- `npx vitest run` → 128 files, 1927 pass, 47 skipped. `tsc --noEmit` clean.
  `yarn test:code` and `yarn test:other` clean.
- **By hand, in a browser, old build against new**, two local instances
  (`:55460` on `feature/icon-drag`, `:55470` on this branch), same test:
  the save's answer held back 2.5s, a change made out of band so the save comes
  back merged, then rectangle A drawn, and rectangle B drawn one second later
  while the save was still in the air.
  - old build: **B was gone.** Status read "Saved".
  - this branch: A, B and the out-of-band element all present, on the canvas
    and on the server.
- **Cost of four seconds of dragging** a drawing of 192 elements and 12 images,
  measured by wrapping the calls in the page:

  | | old | this branch |
  |---|---|---|
  | IndexedDB writes of the whole drawing | 224 | 10 |
  | `JSON.parse` of the whole drawing | 223 | 5 |
  | `JSON.stringify` | 917 | 42 |
  | preview renders | 1 | 0 |

**Reviewed line by line afterwards, and three things came out of it**

1. The editor reports a change for a selection, a scroll and a zoom as well as
   an edit. Holding the scene and starting the timer on every one of those
   made the bar read "Saving…" when nothing was being saved, and made the
   unload prompt claim unsaved work for 800 ms after merely clicking a shape.
   Now a hash of the elements' nonces answers "has anything stored changed?"
   first. Measured in the browser: panning, zooming and clicking make **no**
   save, where each used to queue one.
2. Materialising straight after a merged answer was applied could serialise
   the canvas as it was *before* the apply and briefly store a scene without
   the elements the merge had brought in. The captured scene is now dropped
   when the apply happens.
3. `saveScene` kept a `roomId` parameter it no longer reads. Removed; the
   route records that `room_id` is still accepted in the body because older
   editors send it.

**Checked in two browser tabs on one drawing, live collaboration on**
(`VITE_APP_WS_SERVER_URL` pointed at the local server, so the socket was
really connected — cursors and shapes crossed between tabs):

| | result |
|---|---|
| both tabs drawing at the same time | all four shapes on both canvases and on the server |
| delete in one tab | gone in the other, tombstone kept |
| **delete in one tab while the other tab's save was held back 2.5 s** | deletion stood, and the shape drawn during that save survived |
| pan, zoom, click | 0 saves, status stays "Saved" |
| text, undo, redo | all three survive a round trip |
| images: move one | position saved, all three blob references and the export intact |
| rename | server, status bar and tab title all follow |
| reload | scene restored, opens in view |
| leaving for the dashboard | preview rendered on the way out and current |
| five saves while drawing | **one** preview rendered, not five |

**Not done, and worth knowing**

- A drawing is still given a room the moment it is opened. It should probably
  only get one when somebody shares it; that is a separate change.
- Frame timing in the browser pane was too noisy to trust — rAF gaps of 200ms+
  appeared with no long task recorded, and came and went with the pane rather
  than the build. The call counts above are the honest measurement; treat any
  "frames per second" claim from that pane as unproven.
- `POST /api/scenes/:id/room` still fails with `duplicate key value violates
  unique constraint "scenes_room_id_key"` on the local instance, on scene open.
- The local test bed's bundle at `:55460` has production's websocket and
  shareable-link addresses compiled into it (`draw.devopsproject.dev`, from the
  untracked root `.env.production.local`). The main API is same-origin, so
  drawings are safe, but live collaboration and shareable-link export from a
  local build point at the live site. This branch's own build has none of
  those addresses.
- The disposable fixture password on the `:55460` instance was reset to the one
  in `server/test/dev-instance.mjs` so it could be signed into. Disposable
  database; nothing else touched.

### 2026-10-27 — Codex — publish icon work to dev

Committed the icon-library and gallery changes as `c27cf9a3` on `Icons`,
then merged fetched `origin/dev` through `c2f75454`, preserving the newer smart-
guides history and all icon migrations.

Checks passed on the merged source in a disposable copy: `yarn test:typecheck`,
`yarn test:code`, `yarn test:other`, `yarn test:app --watch=false` (128 files;
1927 passed, 47 skipped, 1 todo), the PostgreSQL server suite (59 passed), and
`VITE_APP_API_URL=/api NODE_OPTIONS=--max-old-space-size=4096 yarn build:app`.

Pushed the icon feature merge to GitHub `dev` (`178b0c2e`), then pushed the
final handoff-only status update. No production change.

### 2026-10-27 — Claude — smart guides, and a default that was set in the wrong place

**Branch:** `feature/smart-guides` → `dev`. CI green (5/5). Not on `main`: the owner is batching this release. Production stays on `v1.3.0`.

Aligning two images was guesswork. Research first: `packages/excalidraw/ snapping.ts` already has edge/centre snapping **and** equal-gap detection, and `renderer/renderSnaps.ts` already draws the guides. Nothing needed rebuilding. What was missing was that it ships **off**, behind a menu item nobody opens, and that the guides never said what the distance was — no `fillText` anywhere in that file.

So: snapping defaults on, and the gap guides carry the number.

**The mistake worth remembering.** The default was first set while building the scene from local storage. A drawing opened from the dashboard never reaches that code — `initializeScene` returns as soon as the workspace scene loads — so it worked only on a blank scratch canvas, which nobody uses. Typecheck passed. 1,926 tests passed. It did nothing. It is now applied at the single point every load path goes through.

**Two things that cost time, written down so they do not again:**

- A shape with no fill can only be grabbed by its **outline** in Excalidraw. Dragging from the middle of a hollow rectangle does nothing, which looked for a while like snapping being broken.
- Synthetic `PointerEvent`s do not reach the canvas; neither Excalidraw nor Canva accepts them. Driving the editor needs real input events.

_Verified in the running editor, not only in tests:_ dropped a shape ~4px short of even spacing → it snapped to `gapAB 120, gapBC 120` exactly, and the canvas painted `"120"` twice at 14.52px under 76% zoom (11px on screen). Captured by recording every `fillText` during the drag. Before the fix the same drag left the shape 0.72px out with no snap. Plus 6 new unit tests in `renderer/renderSnaps.test.ts`.

**Waiting on `dev` for the next release:** smart guides (2), Excalidraw+ button removed, 64 collection icons, sidebar cleanup, ⌘P finds collections.

### 2026-10-27 — Codex — align and center the icon gallery

On local branch `Icons`, improved the icon sidebar's edge spacing and visual
balance. Added consistent panel padding, centered the responsive gallery, made
the cards larger, wrapped long names, and styled categories as compact labels.
Search, category filtering, selection, and canvas insertion remain in place.

Verified in the browser at `http://127.0.0.1:55445`: the full gallery shows a
centered two-column layout; filtering to Programming shows two centered cards
with full names; selecting the saved Python demo icon enables **Add to canvas**.
The scene remained **Saved**. The browser uses a disposable copy under
`/private/tmp/excalidraw-icons-style-preview` and the local test database.

The editor build passed from that disposable copy. `prettier --check
excalidraw-app/components/AppSidebar.scss` and `git diff --check` passed. No
tests were added or run for this CSS-only refinement. Existing non-fatal build
warnings remain. No commit, push, merge, or production change.

### 2026-10-27 — Codex — local icon workflow walkthrough

No source changes in this turn. Reopened the disposable local editor at
`http://127.0.0.1:55445` and showed the flow in the browser: right-click a
canvas image, choose **Add image to icon library**, enter a name/category, then
open the **Icons** tab, filter to **Programming**, select the saved Python icon,
and choose **Add to canvas**. The canvas showed the added icon and **Saved**;
the browser is left on the selected gallery item. The example is in the local
test workspace/scene listed below. No commit, push, merge, or production change.

### 2026-10-26 — Codex — add canvas images to workspace icons

Plan and implementation on local branch `Icons`: remove icon management from
Dashboard Administration. Add an **Add image to icon library** action to an
image's editor context menu, collect a name and category, and save it in the
workspace PostgreSQL icon library. Improve the editor gallery, category filter,
and canvas insertion. Keep all work local; do not commit, push, merge, or deploy.

Implemented the updated flow, image validation/storage and migration `017`,
legacy `svg_data`/object-storage reads, workspace permission checks, and an
audit event. Added/kept migrations `015` and `016` for prior PostgreSQL icon
storage and category metadata. Removed the Icons admin tab and its management
UI. Added tests for admin removal, image import/permissions, and context-menu
integration. Updated `docs/specs/icons.md` to match the requested UX.

Verified in the disposable local browser app at `http://127.0.0.1:55445`:
right-clicked the canvas Python image, saved it as “Python demo icon” with the
“Programming” category, filtered the gallery to Programming, selected it, and
inserted it on the canvas. The browser showed the new icon in the gallery and
on the canvas with the scene in **Saved** state. The local-only disposable
workspace/scene are `572e1911-3516-4ef5-a763-04bdd754d766` and
`aca8ac10-25b4-41cd-bd72-b7604a52d852`.

Checks passed: `yarn test:typecheck`, `yarn test:code`, `yarn test:other`,
`yarn test:app --watch=false` (127 files; 1921 passed, 47 skipped, 1 todo),
full PostgreSQL server suite (59 passed, 0 failed), editor production build,
focused icon-category/admin tests, and `git diff --check`. The app test runner
reported 5 obsolete snapshots; the generated snapshot diff was reverted.
Existing non-fatal parser/build warnings remain.

**Not done:** no commit, push, merge, or production change. The preview and
demo icon/drawing are local only.

### 2026-10-26 — Codex — workspace icon gallery

Plan on local branch `Icons`: add a searchable editor sidebar gallery for
icons already available in a workspace, insert a selected SVG onto the open
canvas, and store newly imported SVG bytes in PostgreSQL. Preserve reads of
legacy object-storage icons. Write the feature spec before code, test workspace
access and insertion, verify the local editor, and do not push or deploy.

Added `docs/specs/icons.md` before implementation. The editor now has an
**Icons** sidebar tab for searching the active workspace library; selecting an
icon inserts its SVG onto the canvas, and the library is available to workspace
members with drawing access. Admin-imported SVG bytes are stored in PostgreSQL
through migration `015`; reads of legacy object-storage icons remain supported.
The gallery shows icons curated into that workspace through Dashboard → Icons,
not the full Iconify catalog.

Verified locally:

- Red-before-green integration test: the new endpoint test failed before its
  route existed; after implementation the full PostgreSQL server suite passed
  (**55 passed, 0 failed**) against a disposable local PostgreSQL instance.
- `yarn test:typecheck`, `yarn test:code`, `yarn test:other`, and
  `yarn test:app --watch=false` passed (**127 files; 1920 passed, 47 skipped,
  1 todo**).
- `VITE_APP_API_URL=/api NODE_OPTIONS=--max-old-space-size=4096 yarn build:app`
  passed.
- `git diff --check` passed.
- Local browser preview on `http://127.0.0.1:55443/index.html?scene=07c89f6e-a4d2-456d-ba8c-2d6758e4a0fe&returnTo=%2Fdashboard`:
  searched and inserted the test `spark` icon, saw it saved after reload, and
  confirmed Undo removed the latest insertion. The dev instance serves the
  editor through `/index.html`; its `/editor` path returned 404 in this local
  setup.

**Not done:** no commit, push, merge, or production deploy. Only a disposable
`local/spark` icon is in the preview database; admins need to import the icons
they want in each workspace.

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

The first two releases cut through the pipeline, v1.0.0 and v1.1.0, were built
without `.env.production.local`, which is not in the repository and held the
editor's API address. Everything compiled, every check passed, the install
succeeded, and the editor loaded as plain local Excalidraw: it ignores
workspace drawings entirely, so opening one showed an empty canvas that looked
like the images had gone.

It was not found by any check because every check looked at the pieces -- the
API, the artifacts, the service -- and none opened a drawing. **Open the
application and look, every time.**

release.yml now writes that configuration and refuses to publish a bundle
without the API address in it.

Separately, handing the editor image references made a drawing with a hundred
images take fourteen seconds to appear, because each request went to object
storage, about half a second each. The images were already held in memory for
other readers; the endpoint now uses that, and reading a scene starts loading
its images in the background. The test for it uses a storage with latency,
since the earlier one ran against a local directory where a read costs nothing
-- which is why the cost only showed in production.


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
