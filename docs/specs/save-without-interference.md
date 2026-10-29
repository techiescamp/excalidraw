# Saving without interfering with the drawing

A drawing on this instance saves itself. This is about the two ways that got in
the way of the person drawing: work disappearing from the canvas, and the
canvas stuttering.

## What it does

- A save whose answer comes back merged is **reconciled** into the canvas
  rather than assigned over it, so work drawn while the save was in flight is
  kept.
- The whole drawing is turned into a payload **once a pause**, not on every
  change the editor reports.
- The dashboard preview is rendered **once the drawing sits still**, not after
  every save.
- The server merges a save because it is **behind**, not because the drawing
  has a collaboration room.

## What it does not do

- It does not change what a merge means. Elements still converge by version and
  versionNonce, in the editor and on the server alike.
- It does not change how often a save is sent: still 800 ms after the last
  change, as before.
- It does not touch live collaboration over the socket.
- It does not stop a drawing being given a room when it is opened. That is
  worth revisiting — a room ought to exist because somebody shared the drawing
  — but it is a separate change with its own risk.
- It does not make saving a large drawing fast. It makes it quiet.

## The fault it fixes

The editor calls `onChange` on every change, which while something is being
dragged is every frame. Each call serialised the entire drawing — with every
image as base64 — compared it, deep-copied it, and wrote it into IndexedDB. On
a drawing with a dozen icons that was 224 writes of 850 KB in four seconds of
dragging.

Separately, the server treated a save as collaborative whenever the caller
named the drawing's room. Because a drawing is given a room the moment it is
opened, that was *every* save, by one person alone: each read the whole stored
drawing back, put every image into it inline, and — when the caller was behind
— sent the lot back. The editor then assigned that answer straight onto the
canvas:

```js
excalidrawAPI.updateScene({ elements: scene.elements, ... })
```

Anything drawn between the request leaving and the answer arriving was not in
that answer, so it was wiped. It came back only when a later save happened to
carry it, which is why a shape could vanish and reappear seconds later.

## Data touched

No migration. No change to what is stored. The only change to a stored scene is
that an ordinary save now replaces it instead of merging it with itself.

| | before | after |
|---|---|---|
| save at the current version, in a room | merged, whole scene returned | stored as sent, version returned |
| save behind the server | merged, whole scene returned | unchanged |
| save ahead of the server | 409 | unchanged |

## How it is verified

- `server`: `TEST_DATABASE_URL=… npm test`. `a save made against an older
  version is merged, not refused` now also covers a save that is up to date and
  names the drawing's own room: it must not be merged and must not get the
  drawing back. Reverting the server change fails it.
- `yarn test:app --watch=false` for the editor, and `yarn test:typecheck`.
- By hand, in a browser, against a local instance with a drawing of 192
  elements and 12 images:
  - with the save's answer held back 2.5 s, a rectangle drawn during the save
    survives. Before, it disappeared.
  - four seconds of dragging the whole drawing: 2 IndexedDB writes, down from
    224.

## Rollback

Revert the commit. There is nothing to undo in the database, and an editor on
either version talks to a server on either version: the older editor sends the
same request and reads the same answer, and the older server answers a save
that is behind exactly as the newer one does.
