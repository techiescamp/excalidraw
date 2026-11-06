# Workspace icon library

## What it does

There is no Icons section in Dashboard Administration. A user adds a picture to
a drawing, right-clicks that image, and chooses **Add to icon library**. A small
form asks for a name and category, then saves the image to the active
workspace's icon library. Any workspace member with drawing edit permission can
add an icon this way.

The editor's **Icons** sidebar tab searches the active workspace library. It
filters by category and gives a clear **Add to canvas** action. Right-clicking
a saved icon offers the same action. The gallery uses larger, readable tiles
and a useful empty state that explains how to save an image as an icon.

The saved image keeps its supported image format (SVG, PNG, JPEG, GIF, WebP,
BMP, ICO, AVIF, or JFIF) and is stored with its name and category in the
workspace. Existing SVG icons stored in PostgreSQL or object storage continue
to load. Adding an icon does not change the original image in the drawing.

## Boundaries

- Only an image element can be saved from the canvas; other element types do
  not show the action.
- The add endpoint requires `drawing.edit` in that same workspace. Gallery
  list and content endpoints continue to require `drawing.read`.
- Categories are workspace labels; a new label can be typed in the add form.
  Unclassified legacy icons use `General`.
- No image is sent to a third party when it is added to the icon library.
- The change is local only. Do not commit, push, merge, or deploy.

## Data and API

- Store image bytes in a generic PostgreSQL `icon_data bytea` column; keep the
  existing `svg_data` and nullable `s3_key` as read fallbacks for old records.
- Add an authenticated `POST /api/workspaces/:workspace/icons` that checks
  `drawing.edit`, validates supported image MIME type, size, name, category,
  and data URL, then stores the bytes and audit entry.
- Serve saved bytes with their validated MIME type, `nosniff`, and a restrictive
  content security policy.
- Keep workspace-scoped icon list and content endpoints, with category
  filtering. No admin-page import or category management UI.
- Add **Add to icon library** to Excalidraw's image context menu through its
  custom context-menu action API.

## Local verification

- Test the context menu item is visible for one selected image, hidden for
  other/multiple element selections, and opens the name/category form.
- Test workspace writes, category list/filter, MIME validation, and rejection
  without `drawing.edit`; prove the new server behavior with a red-before-green
  test.
- Run the checks in `DEVELOPMENT.md` §4, including server tests and the editor
  build. Use the disposable local instance to add a canvas image as an icon,
  filter it in the editor gallery, and insert it into a drawing.
- Record what was observed in `HANDOFF.md`.

## Rollback

Roll back the API/editor code while retaining additive columns. Existing code
continues to read `svg_data` and object-storage `s3_key`; do not delete icon
bytes or drop columns during rollback.

## Deleting an icon (fix)

**Delete from library** in the icon panel's context menu asked for confirmation
and then did nothing. The API refuses any non-GET request that arrives without
the `X-Excalidraw-Request: 1` header, answering 403 "Invalid request origin.";
the panel's `DELETE` was the one request in the app that did not send it, so
every delete was rejected before it reached the icon.

- Send the header with the delete request, as every other write in the app does.
- Guard the class of fault, not just this one call: a test walks the app's
  sources, finds each `fetch` that writes to our own API, and fails if one of
  them leaves the header out.

### Local verification

- Prove the cause first: the same `DELETE` without the header answers 403 and
  with it answers 200 on the disposable local instance.
- Then delete an icon from the panel in the browser and confirm it disappears
  from the library and does not come back on reload.
