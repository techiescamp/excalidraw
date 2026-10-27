# Self-hosted Excalidraw backend

Deployed to `/opt/excalidraw/api` on the server. See [../deploy.md](../deploy.md) §7.

| File | Purpose |
|---|---|
| `server.js` | the API service — accounts, workspaces, collections, scenes, storage |
| `package.json` | runtime dependencies |
| `schema.sql` | base schema (§5.3) |
| `migration-002-collections.sql` | collections, `scenes.collection_id`, `scenes.last_opened_at` |
| `migration-015-icon-postgres-data.sql` | PostgreSQL storage for legacy icon SVG bytes, with object-storage fallback |
| `migration-016-icon-categories.sql` | icon categories and optional display names |
| `migration-017-icon-image-data.sql` | generic icon image bytes for raster and SVG assets |
| `spaces-setup.mjs` | verifies Spaces credentials, then applies CORS + lifecycle |
| `bin/set-password.mjs` | sets a user's password from a terminal prompt |

The service chooses its storage backend at startup: DigitalOcean Spaces when
`AWS_ACCESS_KEY_ID` holds a real value, local disk under `LOCAL_STORAGE_ROOT`
otherwise. Both expose presigned PUT/GET so the browser upload path is identical.
