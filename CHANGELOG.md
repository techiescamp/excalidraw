# Changelog

Changes to this self-hosted deployment. Upstream Excalidraw changes are not
listed here; see `packages/excalidraw/CHANGELOG.md` for the editor library.

## 2026-10-08

### Added

- **Remove image background.** Selecting a single image on the canvas offers
  background removal and icon recoloring. Both run in the browser: a flood fill
  from the image edges clears only background-colored pixels that reach an edge,
  so the inside of a logo is left alone, and recoloring repaints visible pixels
  while preserving transparency. The dialog previews the result before anything
  is applied, and the element keeps its position, size, rotation, crop, grouping
  and bindings. Animated PNG and WebP are detected and refused rather than
  silently flattened to one frame. This handles flat backgrounds; it is not a
  subject-detection model and will not cut a person out of a photograph.
- **Icon library.** Icons an assistant can place in drawings are stored in the
  workspace instead of fetched at draw time, searchable and importable from the
  administration area, and optionally fetched once on first use and kept.
- **Workspace archive and recovery tooling.** `bin/archive-versions.mjs` copies
  every object a drawing is made of, including the version history the nightly
  backup skips, and verifies the result by reading a sample back and parsing it.
  `bin/restore-versions.mjs` puts an archive back, one drawing or all of it.
  `bin/prune-versions.mjs` and `bin/gc-orphans.mjs` report what could be removed
  and act only when given a count matching a fresh report.

### Fixed

- **Download did nothing.** The dashboard routed every same-origin link through
  the page, so a link to an API path was cancelled and turned into a client-side
  navigation. Downloads, API paths and links opening elsewhere are now left to
  the browser, and responses carry a length so a large export shows progress and
  a truncated transfer is detectable.
- **An export could not be imported again.** Exports allowed 512 MB while
  imports refused anything over 100 MB, so a full export could be downloaded but
  never uploaded back. Both directions now read the same figures, as does the
  upload body limit. The ceiling reflects what the host can hold: an upload is
  buffered whole, copied into the worker, expanded and copied back.
- **Thumbnails and collaboration snapshots were never cleaned up.** Each save
  wrote a new object and left its predecessor behind, so 87 thumbnails in use
  had accumulated 17,459 abandoned ones. Both now drop what they replace.
- **Backups reported failures as success.** A file that could not be read was
  logged and skipped while the run still finished with "backup complete", so a
  lapsed key would produce an archive missing half the workspace with nothing to
  say so. The run now fails if any file is missed or the count does not match,
  checksums every object and part as it uploads, reads each one back to compare,
  and writes a `.sha256` beside the archive. Drawings are archived on every run
  rather than Sundays only.
- **Deletions that never happened were reported as done.** `DeleteObjects` in
  quiet mode reports per-object refusals in its response rather than throwing,
  so a run against a bucket the credentials could not write counted its batches
  and announced success while deleting nothing. The archive and cleanup scripts
  now read that response and fail.
- Limits appeared as literal numbers inside the messages reporting them and had
  already gone stale; they are derived from the values in force.
- Administration pages for MCP keys and icons returned "Cannot GET" because
  their paths were missing from the list the server answers with the app shell.

### Changed

- Per-export and per-import limits are 256 MB in total and 64 MB per drawing,
  with up to 2,000 files in an archive.
- Packing a workspace export is allowed minutes rather than seconds.
