# Proxima Nova Extra Condensed

Add Proxima Nova Extra Condensed as a selectable text font in the editor.

## Scope

- Register one stable font-family ID and show the family in the existing font picker.
- Provide regular and bold faces as separate selectable font families, matching the editor's current font-family model.
- Preserve the chosen font ID in scene data and embed the needed glyphs in exported SVGs, following the existing bundled-font path.
- Add no database changes or changes to default UI typography.

## Font files and license

Only webfont files licensed for embedding and redistribution with this app may be committed. The supplied archive contains Fontspring demo OTF files; they may be used for local preview, but not included in a distributed app. Replace them with licensed webfont files before committing or opening a PR.

## Verification

- Font-picker tests confirm that both options appear.
- Run typecheck, lint, formatting, frontend tests, and the editor build.
- In the local editor, create text, select the font, reload the scene, and verify the text renders and exports with the font available.

## Rollback

Remove the registration and font assets. There is no migration. Keep the font ID reserved so existing scenes can fall back consistently if the feature is reverted.
