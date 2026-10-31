# Application blueprint

What this software is, what it does, and how its parts fit together. Written in plain English for someone who has never opened this repository before.

Last updated: 31 October 2026, for release `v5.3.0`.

---

## 1. In one paragraph

This is a self-hosted drawing tool. It is the open-source Excalidraw editor with a private workspace built around it: real user accounts, a dashboard of saved drawings, folders, who-can-see-what permissions, live collaboration, a shared icon library, and all data kept on our own server and our own object storage. It runs at **https://draw.devopsproject.dev**. Nothing is stored on excalidraw.com.

---

## 2. The three pieces

| Piece | Where the code is | What it is | Built? |
| --- | --- | --- | --- |
| **Editor** | `excalidraw-app/`, `packages/` | The drawing canvas the user draws on. React + TypeScript, compiled by Vite into static files | Yes |
| **API** | `server/` | Node.js + Express. Owns the database, the files, the login, the permissions, the live collaboration | No, runs from source |
| **Dashboard** | `dashboard/` | Plain HTML and JavaScript. The login page, the list of drawings, the admin screens | No |

The API is the centre. The dashboard is served _by_ the API. The editor is served by nginx and talks to the API over HTTP and a websocket.

```
   ┌────────────┐   draws on     ┌─────────────┐
   │  the user  │ ─────────────▶ │   editor    │  (static files)
   └────────────┘                └──────┬──────┘
         │  signs in,                   │ saves, loads, collaborates
         │  browses drawings            ▼
         │                       ┌─────────────┐
         └─────────────────────▶ │     API     │ ── PostgreSQL (who, what, where)
                                 │  (port 4000)│ ── Object storage (the heavy bytes)
                                 └─────────────┘
```

---

## 3. Who uses it

There is **no public sign-up**. The first administrator is created on the server itself; everyone else is invited from the admin screen and sets their own password through a one-time link.

| Role | Can do |
| --- | --- |
| **Superadmin** | Everything, including creating workspaces and other admins |
| **Workspace owner / admin** | Manage members, teams, collections, and all drawings in that workspace |
| **Editor** | Open, create and change drawings in the workspace |
| **Viewer** | Open and read drawings, cannot change them |

On top of the role, a single drawing can be granted to one person as view-only or edit. The server checks two capabilities on every action: `drawing.read` and `drawing.edit`. A viewer who tries to change a drawing — through the API or through live collaboration — is refused by the server, not just by the screen.

---

## 4. What we added on top of plain Excalidraw

Upstream Excalidraw is a canvas that saves to the browser. Everything below is ours.

**Accounts and access**

- Username and password login, Argon2id hashes, sessions in a cookie.
- Invite-only user creation, one-time setup links, password reset requests.
- Workspaces, members, roles, teams, and per-drawing grants.
- Private workspaces; a drawing can be moved between workspaces; a workspace can be exported and imported as an archive.
- An audit log of who did what.

**Saving work**

- Drawings live in PostgreSQL; images and large canvases live in object storage.
- Version history per drawing, with pruning and restore.
- A trash: deleted drawings and collections can be restored before they are purged.
- Thumbnails for the dashboard list.
- Recovery of unsaved drafts: if a drawing was open when the browser died, the draft is merged back in instead of asking the person to pick a side.

**Working together**

- Live collaboration over socket.io, inside the same API process — cursors and edits sync in under a second.
- Room keys are stored encrypted, so a reload rejoins the same room.
- Saves do not fight each other: a save from one tab no longer overwrites what another tab is drawing.

**Pictures and icons**

- A shared icon library per workspace. Add any image on the canvas to the library, search it, drag it back onto a canvas, delete it when it is no longer wanted.
- Images are stored once per workspace, under the digest of their own bytes, so the same logo in fifty drawings is one object, not fifty copies.
- Background removal and other image tidying before an image is placed.

**For other programs**

- An MCP endpoint, so an AI assistant can create and edit drawings with a key.
- OAuth 2.1 with PKCE for those clients, each token tied to the person who approved it.

**Operations**

- A build-and-release pipeline, a deploy pipeline with rollback, nightly database backups, and Discord messages for deploys.

---

## 5. How a request flows

### Signing in

```
browser  ──POST /api/auth/login──▶  API  ──▶ users table (Argon2id check)
                                     │
         ◀── session cookie ─────────┘      sessions table
```

The cookie is `HttpOnly` and `Secure`. Every change (POST, PUT, PATCH, DELETE) must also carry the header `X-Excalidraw-Request: 1` and an `Origin` that matches the site. A request without both is refused with 403. This stops another website from acting as the logged-in user. (The icon delete button was broken for exactly this reason until `v5.3.0`: it was the one request in the app that forgot the header.)

### Opening a drawing

```
/editor?scene=<id>
   │
   ├─ GET /api/scenes/:id/data      → the drawing, without the images inside it
   ├─ GET /api/workspaces/:id/blobs/:sha256 → each image, by its digest
   └─ socket.io connect             → join the room for this drawing
```

### Saving a drawing

Images are uploaded **before** the database transaction opens, never during it. This is a rule with a scar behind it: uploading inside the transaction held the drawing's row for minutes and froze the whole site.

```
editor ──▶ upload any new images  ──▶ object storage
       ──▶ PUT /api/scenes/:id/data ──▶ one short transaction:
                                          scenes row + scene_blob_refs + version
```

### The icon library

```
right-click an image → Add to icon library → POST /api/workspaces/:id/icons
sidebar → GET /api/workspaces/:id/icons → thumbnails
drag onto canvas     → GET  …/icons/:set/:name → image bytes
context menu Delete  → DELETE …/icons/:set/:name
```

Icons are stored as image bytes in PostgreSQL (`icons`, `icon_blobs`), not as raw SVG files, on purpose: an SVG can reach outside itself and pull in anything.

---

## 6. The data

PostgreSQL database `excalidraw`. The tables, grouped by what they are for:

| Group | Tables |
| --- | --- |
| People and sessions | `users`, `sessions`, `refresh_tokens`, `password_tokens`, `password_reset_requests`, `creation_requests`, `auth_rate_limits` |
| Workspaces | `workspaces`, `workspace_members`, `workspace_invites`, `workspace_activity`, `workspace_teams`, `workspace_team_members`, `workspace_team_collections` |
| Drawings | `scenes`, `scene_versions`, `scene_visits`, `scene_files`, `scene_permissions`, `scene_room_keys`, `share_links`, `shared_scenes`, `legacy_scene_visibility`, `permission_overrides` |
| Folders | `collections`, `collection_drawings` |
| Images and icons | `workspace_blobs`, `scene_blob_refs`, `icons`, `icon_blobs` |
| Moving and cleaning | `workspace_exports`, `workspace_import_files`, `workspace_cleanup_objects` |
| Machines | `mcp_keys`, `oauth_clients`, `oauth_codes`, `oauth_tokens` |
| Everything else | `app_settings`, `audit_log` |

Schema: `server/schema.sql`. Each later change is a numbered file, `server/migration-0NN-*.sql`, currently up to 019. A new migration must be registered in **three** places or it will not run: `server/bin/migrate.mjs`, `server/test/private-workspaces.test.js`, `server/test/dev-instance.mjs`.

Object storage holds the payloads: image bytes, collaboration snapshots, thumbnails, workspace archives, and the nightly database dumps.

---

## 7. The API, by area

| Area | Routes |
| --- | --- |
| Login | `POST /api/auth/login`, `/api/auth/logout`, `/api/auth/reset-password`, `POST /api/me/password`, `GET /api/me` |
| Drawings | `GET/POST /api/scenes`, `GET/PUT /api/scenes/:id/data`, `PATCH/DELETE /api/scenes/:id`, `/duplicate`, `/move`, `/restore`, `/export`, `/versions`, `/thumbnail`, `/room` |
| Folders | `GET/POST /api/workspaces/:id/collections`, `PATCH/DELETE /api/collections/:id`, `/restore`, `PUT /api/collections/:id/drawings` |
| Workspaces | `GET /api/workspaces`, `/activity`, `/trashed-collections`, `GET /api/permissions` |
| Files and images | `POST /api/files/upload-url`, `GET/PUT /api/files/:scope/:id/:fileId`, `GET /api/workspaces/:id/blobs/:sha256` |
| Icons | `GET/POST /api/workspaces/:id/icons`, `GET/DELETE …/icons/:set/:name`, admin import, preview and search |
| Collaboration | `GET/PUT /api/rooms/:roomId/scene`, plus the socket.io channel |
| Administration | `/api/admin/users`, `/api/admin/workspaces`, `/api/admin/workspaces/:id/teams`, `/api/admin/audit-log`, `/api/admin/storage`, `/api/admin/reset-requests`, `/api/admin/mcp-keys`, `/api/admin/icons/*` |
| Machines | `/oauth/register`, `/oauth/authorize`, `/oauth/token`, `/oauth/revoke`, `/oauth/sign-in` |
| Health | `GET /healthz` |

The code behind them is one module per area in `server/lib/`: `auth.js`, `drawings.js`, `collaboration.js`, `icons.js`, `teams.js`, `oauth.js`, `mcp.js`, `scene-blobs.js`, `workspace-transfer.js`, `workspace-deletion.js`, and so on. `server/server.js` wires them together.

---

## 8. The editor side

| File | What it holds |
| --- | --- |
| `excalidraw-app/App.tsx` | The application shell: which drawing is open, saving, the context menu additions |
| `excalidraw-app/data/workspaceScene.ts` | All talk to our API about the open drawing |
| `excalidraw-app/components/AppSidebar.tsx` | The workspace sidebar and the icon library |
| `excalidraw-app/components/AddIconDialog.tsx` | "Add image to icon library" |
| `excalidraw-app/data/snapPreference.ts` | Remembers snap-to-objects per drawing |
| `excalidraw-app/data/mergeOnOpen.ts` | Merges a recovered draft back into the saved drawing |
| `excalidraw-app/image-processing/` | Background removal and image tidying |
| `packages/*` | The upstream editor itself: canvas, elements, maths. Changed as little as possible |

`VITE_APP_API_URL` decides whether the editor runs in workspace mode at all. It is compiled into the bundle at build time. A build without it produced a release that served pages and answered health checks while silently ignoring every saved drawing — the release pipeline now refuses to publish a bundle without it.

---

## 9. Releases

Version numbers are `vMAJOR.MINOR.PATCH`. A fix bumps the last number, a feature the middle one.

| Version | What it brought |
| --- | --- |
| `v1.0.0` | The state production was already in when the pipeline was built |
| `v1.1.0` – `v1.2.0` | First releases cut through the pipeline |
| `v1.3.0` | Recovered drafts merge instead of asking the author to choose |
| `v1.4.0` | Smart guides, workspace interface cleanup, shared icon library |
| `v1.4.1` | Saving stopped interfering with the drawing |
| `v5.1.0` | Snap to objects starts off, and the choice is remembered per drawing |
| `v5.2.0` | The icon library scrolls to its last icon |
| `v5.3.0` | Deleting an icon from the library works |

The jump from 1.4 to 5.1 is not a mistake: the owner asked for the "5.x" numbering from that point on.

---

## 10. Running it on your own machine

```bash
yarn install                       # once

# the whole application, throwaway: its own database, its own storage
cd server
TEST_DATABASE_URL="postgres://<user>@localhost:5432/postgres" node test/dev-instance.mjs

# or just the editor, against whatever API you point it at
yarn --cwd ./excalidraw-app start        # http://localhost:3001
```

The disposable instance prints its own address and sign-in. It refuses to start against anything but `localhost`, so it cannot touch production. It creates a database called `excalidraw_browser_<pid>` each run; drop the old ones when they pile up.

There is **no staging server**. This local instance is the only place a change runs before production, which is why `DEVELOPMENT.md` §4a insists on exercising the exact path you changed, not just opening the page.

## 11. Checks before anything ships

```bash
yarn test:typecheck                 # TypeScript
yarn test:code                      # eslint, zero warnings allowed
yarn test:other                     # formatting
yarn test:app --watch=false         # editor tests (133 files, ~1,959 tests)
cd server && TEST_DATABASE_URL=... npm test   # API tests, needs PostgreSQL
NODE_OPTIONS=--max-old-space-size=4096 yarn build:app   # it must compile
```

CI runs the same set on every pull request. A bug fix is not finished until a test fails without the fix.

---

## 12. What is known to be unfinished

- The tests check correctness, not behaviour under load. Both October outages only appeared with many drawings open and several people saving.
- The server's content security policy blocks the editor's inline scripts in the built page. Cosmetic, and the same on production today.
- One API test — "two administrators deleting each other always leave one administrator" — fails occasionally and passes on a re-run. A flake, not a regression, and older than the 5.x releases.
- Migrations must be registered in three files by hand.
- The alerts described in `DEVELOPMENT.md` §7b are designed but not all built.

Open operational items are listed at the end of [02-server.md](02-server.md).
