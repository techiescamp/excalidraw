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

**Deployed right now:** `v5.2.0`, installed by the deploy pipeline. `v5.3.0`
is tagged and on its way through it.

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

### 2026-11-07 — `feature/exact-copy`: drawing a picture back the way it came

**Why.** The engine could draw in the house style but could not copy a picture
handed to it. Measured against the original, panel by panel, the worst piece
landed 6.8% of a panel's size from where it belonged, and the owner would not
sign it off. Each miss was a number the engine rounded, capped or re-wrapped.

**Changed** — all in `server/lib/diagram.js` unless noted.

1. **Canvas saved at 100%.** `appState` now carries `zoom: {value: 1}` and a
   scroll that puts the drawing in view. A scene saved at some other zoom
   exports at that zoom, so a picture measured to the pixel came back scaled.
2. **A fine grid for hand-placed drawings.** `FINE_GRID = 5`. `layout: "manual"`
   rounds to 5; everything else still rounds to 20. Threaded through as `place`
   so one drawing is held to one grid end to end.
3. **`plainText` no longer snaps.** It was snapping x and y to 20 a second time
   after the caller had already placed them, which both defeated the fine grid
   and pulled a card's heading down onto the line under it.
4. **XL lettering.** `TEXT_SIZES` is the editor's own four steps — 16 / 20 / 28
   / 36. `extras.size` takes `xlarge`, and `style.title_size` sets the heading.
   Headings were coming out a fifth too small.
5. **`route: "elbow"`**, and the default for a hand-placed drawing. Turns once,
   just *after* the box it leaves, and joins two boxes that line up with a plain
   straight line. The old `orthogonal` turned just before the target, so a
   fan-out ran across the row at its own height and ploughed through whatever
   sat in between; `straight` drew a diagonal.
6. **`extras` cap 40 → 200, and says when it truncates.** Forty ran out halfway
   through the first real picture and the rest vanished with no warning.
7. **A node with no label still draws its id, and now warns.** Boxes were coming
   out captioned `card3`.
8. **A hand-placed box wraps its label to its own width** instead of to a fixed
   24 letters, which had labels running out past the edge of their box. Plain
   nodes are exempt: their name sits beside the picture, not inside a box.

Schema and guide: `server/lib/mcp.js` gained `route: elbow`, `size: xlarge`,
`style.title_size`; `styleGuide()` reports `text_sizes`, both grids and the
canvas zoom; the house rules now say to measure a picture rather than judge it
by eye. `docs/specs/diagram-house-style.md` has a new section on copying.

**Checked.**
- `server/test/diagram.test.js` — 36 pass, 0 fail, including 7 new ones
  covering the fine grid, 100% zoom, the four letter sizes, elbow vs straight,
  the extras warning, the id-label warning and wrapping to the given width.
- Whole server suite: 75 pass. The one failure is
  `test/private-workspaces.test.js`, which needs `TEST_DATABASE_URL` and did
  not run; unrelated to this change.
- End to end by hand: the three-panel reference picture the owner supplied was
  measured out of its own pixels and rebuilt through the engine. Worst piece
  now lands **1.4%** of a panel's size from the original, down from 6.8%.

**Not done.**
- Not merged, not released, not deployed. The owner decides when this goes to
  production.
- Production still has `fetching_allowed: false`, so official brand logos
  cannot be pulled from an icon set; a logo the library lacks has to be cut out
  of the supplied picture. Unresolved — the owner wants official icons.
- A fan-out still draws one line per edge. The reference diagrams share a spine
  between them. Not attempted.


### 2026-11-06 — Claude — v5.4.0 released and deployed to production

`feature/diagram-blueprint` → `dev` (PR #15) → `main` (PR #16) → tag `v5.4.0` →
release artifact → production, by the pipeline, approved by the owner.

The route was the one section 2a asks for, not the shortcut: PR #15 originally
pointed at `main` and was retargeted to `dev` first. One thing had to be fixed
on the way — the semantic title check rejects the scope `mcp`, so the pull
request title was changed to `feat(server)`.

Deploy run: every step succeeded, the pipeline's own health check passed, the
"put the previous release back" step was skipped because nothing failed.

Checked by hand afterwards, all read-only:

- `/healthz` returns `{"ok":true}`, three times, around 30 ms each.
- The dashboard loads signed in. Every request on it returned 200 — no 4xx, no
  5xx — and the browser console has no errors at all.
- The new code is live and not just installed: `drawing_style_guide` on
  production now lists `manual`, `lanes` and `bands`, the `extras`, the curved
  route, `plain` nodes and the new fonts. The old deployment listed none of
  these.
- Icon search answers with ranked matches by meaning, and
  `fetching_allowed: false` — the internet is still off there, as it should be.
- A saved drawing reads back: 122 elements, 767 ms. Existing work is intact.
- `/api/me`, `/api/scenes`, `/api/workspaces/.../icons` and the collections
  endpoint all 200 in 12–110 ms.

**Two things are still unchecked, and both need the owner.**

1. **No drawing has been made on production.** Creating one is a write to a
   shared resource and was refused here, so the new drawing path has not run
   against the real icon library. Everything about it was proven locally
   instead. Either grant the permission or make one drawing by hand to close
   this.
2. **An MCP client that was connected before the deploy still holds the old
   tool list.** This session's cached `create_drawing` has no `layout: manual`,
   no `extras`, no `at`. The server has them — the style guide proves it — but
   a client has to reconnect to see them. Anyone using the drawing tools should
   reconnect before expecting the new options.

Server logs were not read: there is no shell access to the box from here. The
pipeline's health check and the endpoint checks above are what stands in for
them.

### 2026-11-06 — Claude — `feature/diagram-blueprint`: the icon path verified locally, which clears the gate's step 2

Same branch and PR #15. Not released; nothing on production has changed.

The one thing standing unverified was the icon path: the local library was
empty, so no drawing had ever come out of this engine with a real uploaded
icon in it, and the official icons existed only on production. The cut-out tool
removes that problem — icons can be made locally from a picture instead of
copied from production.

Done, on the local instance, from the reader's own picture:

1. Four icons cut out of it through the MCP. One came back `reused` because it
   was already in the library, which is the library-first rule doing its job
   without being asked. One was refused with "every piece ran off the edge of
   it", which is the error being useful rather than producing a bad icon. Two
   were cut at 0% leftover.
2. The stored icons read back out of the library and looked at: a database
   cylinder and a rocket, cleanly cut, no page behind them.
3. A drawing made asking for them by plain name — "data store", "jev brain",
   "rocket" — and all three were found in the library and placed. The exported
   scene carries them as PNGs at their own proportions, with no overlapping
   text and no rounded corners.

So the chain holds end to end locally: cut from a picture, keep, find by name,
draw with. That is section 7a step 2 satisfied and written down.

Step 3 does not apply: no migration, no schema change, no query changed. Only
`server/lib/` and tests and docs are touched.

Still outstanding before production, and they are the owner's calls:
- PR #15 targets `main` directly. Section 2a wants `feature → develop → main`,
  so this skips `develop`.
- The deploy itself is the pipeline's job with a human approving, and the
  after-deploy check in step 8 has to be done by someone who can reach the
  server.

### 2026-11-06 — Claude — `feature/diagram-blueprint`: the library first, and the logo on its own

Same branch and PR #15. Not released; nothing on production has changed.

Two rules the reader set, now built in rather than left to whoever is driving:

- **The library comes first.** A logo somebody drew and uploaded is better than
  one cut out of a screenshot of it, so cutting is a last resort. The tool now
  looks in the workspace library before it cuts anything, and when it finds a
  match it hands that icon back and says so instead of cutting a second,
  poorer copy. `force` skips the check, for when the library's one has been
  looked at and is genuinely worse. The rule is in the tool's own description
  and in the drawing rules, so it holds wherever the tool is called from.
- **The logo, and nothing else.** `keep: "main"` keeps the largest joined piece
  and drops whatever is not attached to it — a stray tick, the end of a line,
  the rays around a mark. `all` stays the default, because a logo genuinely
  made of separate parts would lose them.

On the reader's picture the brain comes out at 170x154, the mark alone, 2%
leftover, where before it came with its rays and a slice of the caption.

Checks: server suite 120 pass / 0 fail, `yarn test:typecheck` clean, `yarn fix`
run. Two new tests: a shape with a stray mark beside it comes back as the shape
alone, and asking twice for the same icon reuses the library's copy instead of
cutting again.

### 2026-11-06 — Claude — `feature/diagram-blueprint`: the cut-out was leaving the page inside the icon

Same branch and PR #15. Not released; nothing on production has changed.

The first cut-out was not good enough and the reader said so. Three faults,
all real:

- **The page was still inside the icon.** A flood fill from the edges only
  takes background joined to an edge. The page showing through a gap in the
  artwork — between a brain and the rays around it, inside the bowl of a
  letter — is walled in and survived. Those patches are now cleared as well,
  at a tighter tolerance than the fill uses: close enough to the page colour
  and it is the page, further away and it is artwork that merely resembles it.
- **The check measured the wrong thing.** It asked whether the rim was clear,
  but a tight crop is *meant* to have artwork at its rim, so it called good
  cuts bad and sent me hunting for looser crops that caught the neighbouring
  caption. It now reports `leftover`: how much of the kept icon is still the
  page colour. Zero is clean. It is measured against what the corners say the
  page is, not against the colour used for the removal — told the wrong
  colour, the removal does nothing, and a check against that same wrong colour
  would cheerfully report success.
- **The crop caught the neighbours.** `drop_edges` throws away any piece that
  runs off the edge of the rectangle: the caption above the icon, the panel
  border below it. The icon and the rays around it sit wholly inside and stay.
  Off by default, because with a tight crop the artwork touches the rim itself.

The rectangle is optional now. A picture already cropped to the icon needs no
box, which is how a person does it: crop first, then take the page off that.

Proven on the reader's own picture: the brain comes out at 251x154 with 2%
leftover, rays and all, and no caption or border with it.

Checks: server suite 119 pass / 0 fail, `yarn test:typecheck` clean, `yarn fix`
run. Two new tests: a ring with the page trapped in the middle of it comes back
with a transparent middle, and a shape with a caption crossing the crop comes
back as the shape alone.

### 2026-11-06 — Claude — `feature/diagram-blueprint`: an icon can be cut out of the picture being copied

Same branch and PR #15. Not released; nothing on production has changed.

Copying somebody's diagram needs the icons that diagram used, and they are
often not in the library. The editor already lets a person cut one out and drop
the background with a mouse; `add_icon_from_image` is the same thing for an
assistant. Give it the picture, the rectangle an icon sits in and a name: the
flat background behind it is removed, the result is trimmed to the artwork, and
it is kept in the workspace library to be used by name from then on.

The server had no image library and still does not need one. `server/lib/png.js`
reads and writes 8-bit PNG with Node's own zlib — colour types 0, 2, 3, 4 and 6,
refusing interlaced or 16-bit by name rather than producing a wrong result
quietly. `server/lib/cutout.js` does the cut: flood fill inwards from the edges
at a tolerance, which is what suits a diagram's flat page, then trim. A
photograph is a different problem and this does not pretend to solve it.

**It reports whether it worked**, which is the point. The answer carries the
background colour it found, how much of the rectangle was background, how much
of what is left is artwork, and how much of the rim is still solid. A rim above
a few per cent means the background did not come away and the caller is told to
look and cut again rather than draw with it. Proven on the reader's own
picture: the first three rectangles tried came back at 19%, 17% and 11% solid
and the fourth at 2%, and the pictures matched those numbers.

The tool is write-only — a read-only key is not even offered it.

Known limit: PNG in, PNG out. A picture sent as WEBP or JPEG has to be
converted first; the tool says so rather than guessing.

Checks: server suite 117 pass / 0 fail, `yarn test:typecheck` clean, `yarn fix`
run. Nine tests over the PNG reader and the cutter, and an end-to-end one
through the MCP: the icon is cut, kept, listed, then drawn with by name; an
empty rectangle is refused; a read-only key cannot see the tool.

### 2026-11-06 — Claude — `feature/diagram-blueprint`: corners everywhere, and icons come from the library, not the internet

Same branch and PR #15. Not released; nothing on production has changed.

Three faults, all found by a reader looking at a drawing beside their own:

- **Curves were still being drawn.** Tiles and boundaries took corners, but the
  name pill, the note, the panel, the terminal window, the title block and the
  page frame were all still rounded. Every rectangle now takes corners and a
  test asserts that none of them is rounded unless `corners: "round"` asks.
- **The lettering was half-size.** The picture being copied was placed at twice
  its own coordinates while the text stayed at its own size, which left small
  words sitting in big empty boxes. Placed at the reference's own scale, a note
  comes out 280x40 around 20px words instead of 560x80 around the same words.
- **Icons were being pulled off the internet.** Fetching is off by default and
  the workspace library comes first; it had been switched on in the local
  fixture, so every box got whatever the icon source offered. Switched off. The
  drawing now says plainly which icons it could not find instead of reaching
  for a poor substitute.

Production's own library was read (listing and per-icon GETs, nothing opened or
changed) and holds 300 curated icons under categories such as People,
Networking, Containers and GPU & Hardware — `Developer at Laptop`,
`Server Rack`, `Network` among them. Those are the ones a drawing should use.

Left undone, and it needs a decision: the local fixture's icon library is
empty, so a drawing checked locally has no icons in it. The official icons
exist only as uploads on production. Either they are copied into the local
instance, or drawings are made on production where they already are — and
production is read-only by the owner's instruction, so this is their call.

Checks: server suite 107 pass / 0 fail, `yarn test:typecheck` clean, `yarn fix`
run.

### 2026-11-06 — Claude — `feature/diagram-blueprint`: a straight line between two boxes is level, not sloped

Same branch and PR #15. Not released; nothing on production has changed.

Copying a reader's tcpdump picture showed it: every arrow in it runs level or
plumb, and every one this engine drew ran at a slope, because a straight route
joined the two boxes' middles. Two boxes that share a band of height are now
joined by a level line across that band, and two that share a band of width by
a plumb line down it; only boxes that share neither fall back to a slope
between their middles.

A note, a panel or any other piece can also be given an exact `fill` and
`stroke` now, the way a node can. A reference picture's cream is not one of the
editor's nine colour names, and matching it is the whole job.

Checks: server suite 106 pass / 0 fail, `yarn test:typecheck` clean, `yarn fix`
run. One new test asserts the level line and the plumb one, and which edges
they leave and land on.

Drawn on the local instance from the reader's picture: Proxima Nova as asked, a
grey canvas as asked, three icons found online, cream notes at an exact colour,
all five arrows level or plumb, no overlapping text.

### 2026-11-06 — Claude — `feature/diagram-blueprint`: a local instance to look at, and the last of the overlapping text

Same branch and PR #15. Not released; nothing on production has changed.

A panel's heading sat on top of its first row, the same fault as the note's
heading last round and from the same cause: the next line's position was worked
out and then snapped to the grid separately, which pulled it back above where
the line before it had actually landed. Every stacked piece of writing now
advances from the snapped position of the line above it. A test asserts that no
two pieces of writing in a drawing overlap at all, which is the invariant
rather than the instance.

The disposable instance from DEVELOPMENT.md section 4a is running on port
55500 with all five sample drawings in it, so they can be opened and looked at
directly rather than through a screenshot. It is disposable: its database is
created fresh on each run and goes when the process stops.

Checks: server suite 105 pass / 0 fail, `yarn test:typecheck` clean, `yarn fix`
run. All five drawings read back from their exported scenes with no overlapping
text and nothing outside the page border.

### 2026-11-06 — Claude — `feature/diagram-blueprint`: defaults measured off the production drawings, plus the callout curve and the chip grid

Same branch and PR #15. Not released; nothing on production has changed.

**Production was read, and only read.** The owner asked for the drawings on
`draw.devopsproject.dev` to be studied and set a read-only rule. The browser was
already signed in, so no credentials were entered. No scene was opened in the
editor — the editor joins a room and saves, which would be a write — so the
listing and the per-scene `export` endpoint were used instead, both plain GETs.
Nothing was created, changed or deleted.

Twenty published drawings were read and their elements counted. The defaults
here were guesses from exported pictures; now they are measurements, written up
in `docs/specs/diagram-house-style.md`:

- **Body text is 20, not 16.** This is the one that mattered: everything this
  engine drew came out small beside the real set. Small is 16, titles 28 — the
  editor's own steps.
- **The default font is Comic Shanns**, which is what the drawings use most
  (283 against Virgil's 177 and Excalifont's 168). Virgil, Shantell Sans,
  Patrick Hand and Proxima Nova were added to the font list as well.
- **The outermost boundary is `#ced4da`**, the single most used fill in the
  published set.
- Confirmed already correct: solid triangle arrowheads (266 against 24), sharp
  corners (385 against 72), line weight 1 with 4 for emphasis, roughness 0, a
  white canvas.

The two pieces left undone last round are in:

- **`route: "curved"`** on an edge sweeps a callout line from a note to the
  thing it is talking about — three points with the middle one pushed off the
  run, drawn with the editor's curve.
- **`extras` kind `grid`** lays small coloured chips out in a box, in however
  many columns are asked for, with a heading over them. That is how a
  comparison lists what belongs to each side.

Also fixed: a note's heading and its words overlapped by a few pixels, because
each line's position was worked out and snapped separately instead of being
measured from where the line above actually landed.

Checks: server suite 104 pass / 0 fail, `yarn test:typecheck` clean, `yarn fix`
run. One new test covers the curve's three points and the chip grid's rows and
columns.

### 2026-11-06 — Claude — `feature/diagram-blueprint`: the pieces that are not boxes, for the workflow and explainer pictures

Same branch and PR #15. Not released; nothing on production has changed.

The owner asked for a full pass over their folder, since not all of it is
architecture. Ten more were read — complex_workflows, SDLC vs MDLC, pod_starts,
Pod Graceful Shutdown, Canary vs Shadow, Image Signing, Argo DAG, Helm Chart
Structure, User Namespaces, GPU Training — and the finding is in
`docs/specs/diagram-house-style.md`: the workflows and explainers are built from
the same boxes and arrows plus a small set of pieces that are not boxes.

All of them are now in the tool, as `extras`, each carrying its own `at`:

- **code** — a dark window with the three lights, an optional title inside, and
  `highlight` to band one line in amber.
- **note** — a card with a heading and words, optionally dashed, optionally
  with a tick or a cross on it. Give it an `id` and an arrow can point at it.
- **panel** — a key down the side: a heading and rows of coloured chip plus
  words.
- **band** — a strip across the foot of the page.
- **divider** — a plain rule between two halves being compared.
- **measure** — a span with a head at each end and its size written above.
- **text** — loose words in a colour.

An edge also takes `width` from 1 to 4, for the one path a workflow is about.

A card given a width now wraps its words to that width; wrapping to a fixed
count is how a wide note came out as a narrow column inside a wide box.

Checks: server suite 103 pass / 0 fail, `yarn test:typecheck` clean, `yarn fix`
run. One new test covers every piece, the arrow pointed at a note by its id,
the banded line in the code window, and the wrapping.

By hand on the local fixture: the Argo Workflows DAG redrawn with the new
pieces and put beside the published one.

Left undone: the curved hand-drawn callout arrow (these are straight or
right-angled), and the chip grid inside a box that SDLC vs MDLC uses.

### 2026-11-06 — Claude — `feature/diagram-blueprint`: icons keep the shape they were drawn at

Same branch and PR #15. Not released; nothing on production has changed.

The owner said the icons looked stretched, and they were. Every picture was
drawn at whatever size its slot happened to be, so a wordmark three times as
wide as it is tall — Terraform, Nexus, SonarQube, the AWS mark — was squashed
into a square, and a square logo dropped into a tall slot was pulled out of
shape.

An icon's own proportions now travel with it: `aspectOf` reads the ratio from
an SVG's viewBox (or its width and height attributes) and from a PNG's IHDR
chunk, and the drawing fits the picture inside its slot at that shape, centred,
instead of filling the slot. An icon whose header cannot be read is drawn as it
was, so nothing regresses. This applies to tile icons, plain nodes and a
boundary's corner badge alike.

Checks: server suite 102 pass / 0 fail, `yarn test:typecheck` clean, `yarn fix`
run. Five new tests: the ratio read from a viewBox, from width and height
attributes, from a PNG header, nothing returned for anything unreadable, and a
three-to-one wordmark placed in a square slot coming out at its own shape and
centred.

Confirmed by eye on the local fixture against the reference picture.

### 2026-11-06 — Claude — `feature/diagram-blueprint`: square corners, solid arrowheads, and lines that go straight

Same branch and PR #15. Not released; nothing on production has changed.

Three defaults were the editor's rather than this workspace's, and all three
were wrong in every drawing the engine has produced so far. Checked against the
reference set again before changing them.

- **Boxes have square corners.** The rounded rectangle is the editor's default.
  `style.corners: "round"` brings it back for anyone who wants it.
- **Arrows end in a solid filled triangle**, not the open V, and turn at square
  corners rather than rounded ones.
- **A line goes straight.** In a hand-placed drawing nothing is dodged at all —
  whoever set the coordinates already decided what goes where, and a line taking
  the long way round to avoid a box is what stopped the copy looking like the
  original. Everywhere, two boxes within one grid square of being in line are
  treated as in line instead of being joined with a wiggle, and repeated points
  in a path are dropped.
- A boundary named in plain words is lettered in its own colour, the way the
  reference set letters a region's name.

Checks: server suite 96 pass / 0 fail, `yarn test:typecheck` clean, `yarn fix`
run. Two new engine tests: the corners and the arrowhead with the round opt-out,
and a near-aligned pair joined by one straight run with no sideways step.

### 2026-11-06 — Claude — `feature/diagram-blueprint`: a picture can now be copied exactly, because the engine can be told to stop deciding

Same branch and PR #15. Not released; nothing on production has changed.

The owner sent a reference architecture and said the drawing that came back was
not it. They were right, and the reason was structural rather than cosmetic: a
reference picture is not the output of a layout algorithm, so an engine that
only ever lays out can get close to one and never reach it.

- **`layout: "manual"`.** Every node and boundary carries `at: {x, y, w, h}` in
  pixels, snapped to the grid. Nothing is placed for the caller, so what is
  sent is what is drawn. A node or boundary left unplaced is drawn at the
  origin or left out, and the drawing says which.
- **`label_at` on a node** puts its name left, right, above, below or inside
  the picture, and an arrow then lands on the picture rather than on the words.
- **An empty label draws nothing**, for nodes and for boundaries. Most product
  logos carry their own wordmark and repeating it underneath is exactly what
  made the first attempt look wrong.
- **`label_style: "plain"` on a boundary** centres its name in words over the
  region instead of putting it in a pill, and **`badge`** puts a provider's
  mark on its corner.
- **An arrow can join two boundaries.** The line from a build account to a
  production one leaves the region itself, not a box inside it.
- **`route: "straight"` on an edge** draws a direct line instead of elbows,
  which is what a fan-out from one box to a row of them looks like.

Checks: server suite 94 pass / 0 fail. `yarn test:typecheck` clean. `yarn fix`
run. Three new engine tests: a hand-placed drawing landing on its coordinates
at the sizes it was given with the empty labels drawn as nothing and the badge
on the corner, an arrow between two regions leaving and landing on their edges,
and the warnings for anything left unplaced.

By hand on the local fixture: the owner's reference architecture redrawn as a
copy and read back from the exported scene — every element inside the page
frame, no two pieces of text overlapping, no picture overlapping another, and
no text sitting on a picture.

Left undone: the first auto-laid-out attempt at that picture is what the owner
rejected, and nothing here makes the automatic layouts reproduce a reference —
copying one is now a separate mode, chosen deliberately.

### 2026-11-06 — Claude — `feature/diagram-blueprint`: the engine draws in this workspace's own house style

Same branch and PR #15. Not released; nothing on production has changed.

The owner pointed at about a hundred finished Excalidraw diagrams in their own
folder — the ones published under the DevOpsCube name — and asked for the
structure and the corner styles to be taken from there. Ten of them were read
and what they have in common is written down in
`docs/specs/diagram-house-style.md`; that document is now the reference for
every default in the engine.

What changed in the engine and in the drawing tools:

- **A boundary is named by a pill straddling its top edge**, not by text
  dropped in its corner. `label_at` picks the corner. This is the signature of
  the style and the thing the engine was missing.
- **Boundaries take a `color` and a `style`** — solid, dashed or dotted. The
  colour tints the boundary and its pill together.
- **Two new structures.** `layout: "lanes"` sets full-height columns side by
  side, one per tier, every one the height of the tallest, with a lane's own
  nodes in a column; `layout: "bands"` stacks full-width rows down the page,
  each with its own flow and a `caption` under it.
- **`shape: "plain"`** draws a node as a large icon with its name underneath
  and no box, lettered in the colour of what the thing is. More of the
  diagrams in the set are drawn this way than with tiles.
- **Four title treatments**, underlined by default, which is the commonest.
- **A hairline frame around the whole page**, on unless turned off. Every
  finished diagram in the set has one.
- **Step badges are amber**, not solid black.
- **`theme: "dark"`** gives a dark page with the tiles drawn as outlines in
  their own colour, which is what the dark diagrams actually do.

Checks: server suite 91 pass / 0 fail. `yarn test:typecheck` clean. `yarn fix`
run. Six new engine tests cover the new geometry.

Three existing tests were rewritten rather than worked around, because the
behaviour they pinned has deliberately changed: a boundary's name is now in a
pill above the edge, and the page frame is an extra rectangle in every scene.

By hand on the local fixture: the GitLab architecture redrawn as lanes and put
beside the published diagram, and the reference architecture from the round
below redrawn in the house style. Both read back from the exported scene —
every element inside the page frame, no two pieces of text overlapping, every
icon placed, and the font the one that was asked for.

Left undone, and listed in the spec: the isometric illustrations (the engine
places icons, not artwork), the dark code panel with the traffic-light dots,
free-floating hand-drawn callouts, and a drawing whose two halves read in
different directions.

### 2026-11-06 — Claude — `feature/diagram-blueprint`: icons fetched when the library has none, and boundaries laid out in the flow

Same branch and PR #15 as the entry below. Not released; nothing on production
has changed.

Drawn against a reference image a reader sent, which is what turned up all three
faults below.

- **An icon the library does not have is fetched and kept.** A library match
  only wins outright when the icon is actually named after everything that was
  asked for. Short of that it is a stand-in, and the icon source is asked for
  something named after more of it; what comes back is stored in the workspace
  library and used, so the next drawing needs no network. Without that rule a
  box labelled Terraform wore Ansible's badge, because the two mean the same
  thing, and every AWS box wore Route 53's, because they all begin with "aws".
  Unchanged: one host only, SVG only, 256 KB ceiling, scripting rejected, and
  only when an administrator has turned fetching on — it is off by default. The
  drawing's warnings name every icon that arrived this way.
- **`ICON_SOURCE_URL`** overrides the icon host. It exists so a test can point
  at a stub; nothing a request carries can change where it points.
- **Boundaries are laid out in the flow.** A boundary now stands in for
  everything inside it when its parent is laid out, instead of being stacked
  after the parent's loose nodes. Before this, a database that only an app
  inside a cluster writes to sat at the top of the diagram with the cluster
  below it.
- **Lines are the editor's own thin weight**, except the primary data path at
  one step up. They were all a step heavier, which made the boxes compete with
  what connects them.

Checks: server suite 85 pass / 0 fail, run twice (the stub icon source listens
on an ephemeral port; a fixed one failed intermittently against a port the last
run had not released). `yarn test:typecheck` clean. `yarn fix` run.

Red before green: the fetch test fails without the fallback (2 subtests), and
the whole thing was found by eye on the local fixture before any of it was
written.

By hand on the local fixture, drawing a reader's reference architecture through
the MCP: nineteen icons, every one asked for in plain words, every one fetched
from the source and kept; checked in the editor and against the exported scene —
all text in the font that was asked for, every stroke thin except the primary
path, no arrow segment crossing a tile it does not belong to, every boundary
inside its parent.

Left undone: the engine still has one flow direction for the whole drawing, so a
diagram whose two halves read in different directions (left to right between
clouds, top to bottom inside one) can only have one of them.

### 2026-11-06 — Claude — `feature/diagram-blueprint`: the MCP draws blueprints, and finds its own icons

Branch off `main`, PR #15. Not released; nothing on production has changed.

- **The drawing engine draws reference architectures, not flowcharts.** Grid of
  20px, boundaries nested four levels with their own fill and padding, colour
  decided by a node's *role* rather than named per box, right-angled arrows,
  numbered step badges, a legend, a title banner, a brand mark, and the icon
  inset on the left of a tile with the label beside it.
- **Arrows go around boxes they do not belong to.** The router tries straight,
  then one turn in the gap, then a turn anywhere else along the run, and failing
  all of those takes the line out into a clear lane and back in. Before this, a
  long arrow cut straight through whatever tile happened to be in the way, which
  is what the first drawing on the local instance showed.
- **Step badges move until they are clear.** A badge is offered every place
  along its own line and takes the first that covers no tile and no boundary
  name.
- **Icons are found by meaning.** A node asks for "database", "message queue",
  "load balancer", "k8s" and the closest icon in the workspace library is used.
  Words that mean the same thing are grouped; a shared set or category is *not*
  enough to substitute, so unrelated words leave the box plain instead of
  reaching for whatever is nearest. The box's own label settles a tie, so a tile
  labelled Prometheus asking for "metrics" does not come back with Grafana.
  `list_icons` searches the same way, and every substitution is reported back in
  the drawing's warnings.
- **`diagram_rules` prompt** carries the house rules, including how to turn a
  picture somebody sends into a description this server can draw, and how to
  pass a font, background or brand when the asker wants a particular look.

Checked: `server` suite 85 pass / 0 fail with `TEST_DATABASE_URL` set
(`excalidraw-ghostfix/server`, `npm test`), `yarn test:typecheck`, `yarn fix`.
Red-before-green proved for the meaning matching (the sibling-word bonus
disabled → 4 subtests fail) and for the router (obstacles withheld → the
crossing test fails). Then by hand on the local fixture instance: a twelve-box
Kubernetes request path drawn through the MCP with **every icon asked for in
plain words**, all twelve resolved, and the result read in the editor — nested
boundaries, no arrow through a tile, no badge on a tile.

Left: `create_drawing` still cannot show the assistant what it drew, so it
cannot judge its own work. That is the next step and it is not started.

### 2026-10-30/31 — Claude — v5.1.0, v5.2.0, v5.3.0: snap, icon scrolling, icon delete

Three small releases, each one file of behaviour, all built and deployed through
the pipeline. Production ran `v5.1.0`, then `v5.2.0`; `v5.3.0` carries the
delete fix below.

- **v5.1.0** — **Snap to objects** now starts off for a drawing nobody has
  toggled it on for, and the choice is remembered per drawing. Checked by
  forcing the remembered value on and confirming the context menu still shows it
  off. *Arrow binding* and *Snap to midpoints* are separate settings and still
  default on; nobody has said whether they should change.
- **v5.2.0** — the icon library could not be scrolled to its last icon. The
  sidebar is a column of flex items and every one of them defaulted to
  `min-height: auto`, so the grid grew past the panel instead of scrolling and
  the overflow was clipped away; search was the only way to reach an icon past
  the fold. The tabs root and panel may now shrink and the grid is the part that
  scrolls. One file, `excalidraw-app/components/AppSidebar.scss`.
- **v5.3.0** — **Delete from library** asked for confirmation and then did
  nothing. The API refuses a non-GET request without the `X-Excalidraw-Request`
  header as cross-site (403 "Invalid request origin."), and this delete was the
  single write in the app that did not send it. PR #13.

**How the delete fault was proved**, before changing anything: the same `DELETE`
against a disposable local instance answered 403 without the header and 200 with
it. After the fix, deleting an icon in the browser removed it from the panel and
it stayed gone across a reload.

**Guard against the same class of fault:** `excalidraw-app/tests/apiRequestHeader.test.ts`
walks the app's sources and fails on any `fetch` that writes to our own API
without the header. It fails on the old delete call.

**Checks:** typecheck, lint, and the full front-end suite (133 files, 1,959
tests) locally; all ten CI checks on PR #13.

**Still open from this stretch**

- The server's CSP (`script-src 'self'`) blocks the editor's inline scripts in
  the built `index.html`. Pre-existing, cosmetic, same on production today.
- One server test — "two administrators deleting each other always leave one
  administrator" — failed once with 400 where it expects 200 or 409, and passed
  on two full re-runs. Flake, not a regression; it predates these releases.

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
### 2026-10-28 — Claude — the drawing that was "here, then there" was the view, not the data

**Branch:** `feature/icon-drag`, committed locally. Not pushed. Production
stays on `v1.3.0`.

The owner reported it again after the earlier re-check passed: draw something,
move back and forth, and it is here, then there; sometimes gone until you
scroll. The earlier check was looking for lost elements and there were none —
the elements were always saved and always on the canvas. What moved was where
the canvas was looking.

**Two faults, both about the width the editor divides by.**

1. The workspace sidebar narrows the editor by shrinking `#root`. The window
   never changes size, and the editor only re-measures on a window resize, so
   it kept believing it was as wide as the window — 1024 where the canvas was
   752. Everything it computed from that was 272px out. `notifyEditorResized`
   in `workspaceScene.ts` now tells it, **synchronously**: the first attempt
   used `requestAnimationFrame`, and animation frames and ResizeObservers are
   both suspended in a background tab, so the correction arrived sometimes and
   not others. That inconsistency is exactly what "here, then there" was.
2. `scrollToContent` — what opened a workspace drawing — stops centring the
   drawing the moment the work is wider than the viewport and centres the
   single nearest element instead. Removed. `excalidraw-app/data/
   fitSavedDrawing.ts` fits the whole drawing instead, once the editor's own
   measurement agrees with the box it is drawn in **and** has held still;
   either test alone is not enough, as a stale width sits perfectly still and
   a matching one can be mid-change.

**How it was found, since guessing cost most of the time here:** a temporary
probe pushed `getAppState().width` against `container.clientWidth` every 50ms
into `window.__fitProbe`. It showed the editor stuck at 1024 for 2.2s while
the DOM read 752 throughout. Nothing short of that settled it — four theories
before it were all wrong. The probe was removed before committing.

_Verified in the editor_, on a drawing whose work sits at x2400,y1800: it used
to open blank, or with one shape half off the right edge, differently each
time. It now opens at 55% with all five shapes inside the canvas, landing on
the same pixels on every open (ink box 65,158→686,668 twice over).

Checks: typecheck clean, `yarn fix` clean, frontend 1,953 passed (132 files),
server 60/62 — the same
`two administrators deleting each other always leave one administrator` flake
as this morning, which passes alone and is unrelated to this change.

**Worth knowing:** opening a drawing now always frames the whole drawing. It
does not remember where you were last looking. That is a deliberate trade and
nobody has asked for the alternative yet.

### 2026-10-28 — Claude — anything can be an icon, and the vanishing drawing re-checked

**Branch:** `feature/icon-drag`, committed locally. Not pushed, not released.
Production stays on `v1.3.0`.

**Icons from any selection.** The library only ever accepted one stored
picture, so a shape somebody drew could not become an icon — the obvious thing
to want from a drawing tool. Any selection now offers it: a shape, a group, a
label, a whole board. A single stored picture still passes through untouched
at its own quality; anything else is rendered to PNG at up to 512px on its
longest side, which stays sharp inside the 256px box an icon is placed in.

PNG and not SVG, deliberately. Excalidraw's SVG carries its fonts and any
placed picture inline as `url(data:…)`, and `server/lib/icons.js` refuses an
SVG that reaches outside itself — that rule is what stops a hostile icon
reading the page it lands in. Do not "improve" this to SVG without changing
that rule first, and think hard before changing that rule.

New: `excalidraw-app/data/selectionIcon.ts` (+5 unit tests). The save still
refuses if the canvas moved under the dialog, now checking every element that
was selected rather than one image's file.

**The vanishing drawing, re-checked end to end.** The owner is nervous about
this release, so it was driven through the real editor rather than the API:

| What was done | Result |
|---|---|
| 6 × draw a shape → dashboard → back | 6 shapes, never fewer; ink on canvas 1,081 → 6,187px, only ever rising |
| a second person (bibin) writes while it is open, then reopen | his red shape is on screen (468 red pixels) and stored — the bug from yesterday |
| 6 rapid trips out and back, drawing nothing | ink 6,187 and 468 red pixels, identical to the pixel; 7 elements stored |

Evidence left in the local test bed: drawing "Back and forth probe", icon
"Hand drawn oval".

Also run: the 26-check production-shaped pass (26/26), frontend 1,953 passed
(132 files), server 62/62, typecheck and `yarn fix` clean.

**Noticed, not fixed:** opening a drawing writes a new version even when
nothing is edited — the probe went from version 16 to 24 over eight opens.
Harmless today, but it inflates version history.

### 2026-10-28 — Claude — snapping is now a per-person, per-drawing choice

**Branch:** `feature/icon-drag`, committed locally. Not pushed, not released.
Production stays on `v1.3.0`.

The report was "Alt+S does nothing, right-click works". Alt+S was never broken.
Proved it in the running editor: press Alt+S, open the context menu, the
"Snap to objects" row comes back ticked. What was missing was any sign that it
had happened — the canvas looks identical until something is dragged, and the
only place the state shows is a menu you have to open to see.

Two changes:

- Toggling snapping now says so, as a toast ("Snap to objects on" / "off").
- The answer is remembered against `user:workspace:scene` — the same key the
  draft store already uses — so it belongs to one person on one drawing. It is
  **not** saved into the scene, which would have carried one person's working
  preference onto everybody else's canvas and onto their other drawings.

New: `excalidraw-app/data/snapPreference.ts`, `getWorkspaceSceneKey()` in
`workspaceScene.ts`, applied in `initializeScene` and persisted in `onChange`.
Every storage access is guarded — a private window or a full store falls back
to the editor's default rather than throwing mid-drag.

_Verified in the running editor_ on the local test bed: toggled with Alt+S,
reloaded the drawing and the tick was still there; opened a different drawing
in the same window and it was unticked. Plus 7 unit tests covering both
separations and both storage-failure paths.

Checks: typecheck clean, `yarn fix` clean, frontend 1,948 passed (131 files),
server 62/62.

**Worth knowing:** the server suite failed once on
`two administrators deleting each other always leave one administrator`, then
passed on a rerun and passed alone. That test is flaky under the shared
database. Nobody has looked at why.

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
