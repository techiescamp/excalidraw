# Workspace export and import

Implemented against the signed-in Excalidraw Plus settings/export and settings/import pages inspected on 14 September 2026 and the supplied screenshots. The self-hosted pages retain username/password authentication and show download readiness in the app instead of sending email.

## Access and storage

- Both features require a global administrator, with password reauthentication for mutations. Ordinary workspace admins/editors/viewers cannot use these administration endpoints.
- Accessible exports use the existing scene access checks. All-scene and selected-member exports explicitly include private drawings; these privileged operations are audited. Downloads require the requesting administrator's active session.
- ZIPs use the configured storage driver. With Spaces enabled they live at `workspace-exports/<workspace-id>/<export-id>.zip`; local mode uses the same relative path below the configured local storage root. No bucket credentials are sent to the browser.
- Export history and import retry records live in PostgreSQL. Drawings retain the existing PostgreSQL metadata / object-storage payload model.
- One request per administrator per workspace per hour. Download availability expires seven days after the request. A worker removes expired ZIPs while the API is running, retaining the history row.
- The PostgreSQL-backed queue resumes interrupted exports after restart and uses an advisory lock to allow one exporter across API processes.

## Archive behavior and limits

- Current saved scene JSON includes embedded image data. Historical versions, thumbnails, users, passwords, and access-control configuration are not part of a drawing export.
- `manifest.json` preserves original names, collection membership, and private status. A scene in multiple collections is stored once; the manifest restores its multiple memberships. Filenames include IDs to avoid name collisions.
- Imports create new drawings. They do not overwrite existing scenes. Existing collections are matched by normalized name. A collection in Trash must be restored first.
- Private drawings import into the importing administrator's Private area; other users' ownership is not reassigned. Loose files default to Private or an explicitly chosen collection. Nested source folder paths become collection names; the app's collection model is flat.
- Uploads and expanded ZIP contents are capped at 100 MB, with 25 MB per drawing and 1,000 ZIP entries. Exports allow 999 drawings plus the manifest, up to 100 MB of content. Larger exports fail visibly rather than returning a partial ZIP.
- ZIP work runs in a bounded worker thread. Unsafe paths, duplicate archive paths, corrupt archives, and excessive expansion are rejected. Imports run sequentially. Retry uses the same request ID and skips already committed files.
- Empty folders are not imported, because the file upload workflow imports drawings and creates collections for those drawings.

## Validation

`TEST_DATABASE_URL=postgresql:///postgres npm test --prefix server`

31 tests passed, including ZIP/image round-trip, collection reuse, private scopes, permissions, cooldown, expired download refusal, upload-handler integration, and malformed/oversized ZIP rejection. The actual browser export form was verified through password confirmation, Exporting status, Download status, and cooldown. Import page rendering and picker buttons were inspected; native file-picker automation was unavailable. The import form's change/upload/summary flow was separately tested with the real backend using JSDOM.

Archive library reference: [fflate documentation](https://github.com/101arrowz/fflate).

## Deployment

Deployed to `https://draw.devopsproject.dev` on 14 September 2026. Migration 009 applied; API runs with the S3 storage driver and bucket `excalidraw-data`. Both settings pages and the new dashboard module return HTTP 200; unauthenticated transfer access returns HTTP 401. Production logs show successful startup. Full authenticated ZIP round-trip was verified locally, not against production data.

Rollback backup: `/opt/excalidraw/backups/workspace-transfer-20260914/` (database dump, prior API/dashboard code, nginx configuration). The database dump was checked with `pg_restore --list`.

Deployment procedure:

1. Back up the production PostgreSQL database.
2. Install server dependencies from the updated lockfile (`npm ci` in `server`).
3. Run the existing migration runner (`npm run migrate`), including migration 009.
4. Deploy the updated API and dashboard files together and restart the API.
5. Apply the import-specific 100 MB nginx location in `deploy.md`; ordinary scene requests remain capped at 25 MB. Run `nginx -t` before reload.
6. Verify a small export/import in the configured production Spaces bucket and check the Audit log.

Changes are committed and pushed to the existing `dev` branch as requested.
