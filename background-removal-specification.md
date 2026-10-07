# Background removal and icon recoloring: implementation specification

Prepared: 6 October 2026  
Target branch: `background-removal`  
Status: local icon-processing prototype implemented; portrait and general-foreground AI removal remain proposed. Nothing has been pushed or tested on production.

## 1. Outcome and scope

Let a user select an image already on the Excalidraw canvas, remove its background, preview the result, and apply a transparent PNG. Also provide the icon color-changing workflow discussed alongside background removal.

The first release has two separate actions:

- **Remove background**: isolate the foreground of a supported image.
- **Recolor icon**: turn the visible pixels of a monochrome/transparent icon into a chosen color while preserving transparency.

Users can run Remove background followed by Recolor icon. Recoloring an opaque photograph is not equivalent to changing the color of a selected object. Explain this in the preview when the input has no transparent background.

Start with one selected image per operation. Preserve the selected element's identity, position, dimensions, rotation, flip, crop, opacity, frame, group, links, and bindings. Only the selected image's asset reference changes when Apply succeeds.

Out of scope for version one: batch processing, video, generative editing, manual segmentation brushes, identifying individual objects for recoloring, automatic background replacement, and editing individual SVG paths. Native Excalidraw shapes continue to use their existing stroke/background controls.

## 2. Research findings and model decision

Prefer local browser processing with self-hosted, version-pinned model/runtime assets. No paid background-removal API is required. Users' devices perform inference; the host still pays for model downloads and normal drawing storage.

| Candidate | Evidence | Proposed use |
| --- | --- | --- |
| Transformers.js + MODNet | Transformers.js supports a background-removal pipeline; MODNet is explicitly a portrait-matting model. Upstream MODNet code and models are Apache-2.0. | First portrait prototype; do not advertise it as reliable general-purpose icon/product removal. |
| IMG.LY background removal | Browser-oriented implementation, AGPL-3.0 library, configurable model/runtime asset hosting. | Alternative only after explicitly deciding whether its license terms fit this distribution. It is not automatically prohibited merely because Excalidraw is permissively licensed. |
| Self-hosted rembg | MIT library with local HTTP/Python/Docker use and multiple model choices. Model weights have independent licenses. | Optional server provider if browser quality or device limits fail the acceptance gate. Requires separate operational work. |
| Deterministic flat-background removal | Border-connected color matching can remove a solid background without an ML model. | Proposed icon-specific mode, benchmarked separately; never silently remove all white pixels throughout an icon. |

The earlier MODNet recommendation needs this qualification: portrait suitability does not establish suitability for arbitrary icons, logos, products, or diagrams. Do not finalize a universal model on the basis of a documentation example.

Before choosing the shipping background-removal model:

1. Assemble a licensed/public test set covering portraits, fine hair, product photos, logos, flat icons, low-contrast edges, transparent inputs, and multiple subjects.
2. Compare the portrait prototype and at least one general-foreground candidate with verified weight provenance and license terms.
3. Measure cold model download bytes/time, warm processing time, peak memory, browser support, and edge quality on the intended devices.
4. Pin the exact library version, model revision, dtype, asset checksums, license files, preprocessing, and output contract.
5. If only the portrait candidate passes, ship a clearly labeled portrait mode; do not call general image removal complete. Flat-icon removal/recoloring can ship independently.

Research sources, consulted in the preceding research turn:

- [Transformers.js repository and license](https://github.com/huggingface/transformers.js)
- [BackgroundRemovalPipeline documentation](https://huggingface.co/docs/transformers.js/api/pipelines)
- [Xenova/MODNet model card and usage](https://huggingface.co/Xenova/modnet)
- [MODNet upstream purpose and model license](https://github.com/ZHKKKe/MODNet)
- [IMG.LY background-removal library](https://github.com/imgly/background-removal-js)
- [rembg and model-specific license guidance](https://github.com/danielgatis/rembg)
- [ONNX Runtime Web](https://onnxruntime.ai/docs/get-started/with-javascript/web.html)

These sources establish available approaches, not measured performance in this application. No model benchmark was run for this specification. Recheck exact versions and model licenses when implementing.

## 3. User experience

### Entry points

Add image actions beside existing crop/image actions in the selection properties panel, including its compact and mobile variants. Add matching context-menu and command-palette entries where those surfaces support the same predicate.

An action is available only when:

- Exactly one non-deleted, initialized image is selected.
- Its binary asset has loaded successfully.
- The element is unlocked and the canvas allows editing.
- The current workspace grants `drawing.edit` when workspace permissions apply.
- No other processing job owns that image.

Use descriptive disabled explanations for a loading image, read-only drawing, or unsupported input. Server authorization remains authoritative for saving; hiding controls is not an authorization boundary.

### Background-removal flow

1. Select image → **Remove background**.
2. Open an accessible preview dialog without changing the canvas.
3. Explain that processing happens on this device. On first use, show the model download size from the pinned asset manifest.
4. Choose an explicitly supported mode if necessary: Portrait, General foreground, or Flat icon background. Show only implemented modes.
5. Show download progress where the runtime provides it; otherwise show an indeterminate preparation indicator. Do not invent inference percentages.
6. Render Before/After previews over a checkerboard with optional light/dark backgrounds for inspecting edges.
7. Offer **Apply**, **Cancel**, and **Retry** on a recoverable error. Apply stays disabled until a valid result exists.
8. On Apply, validate the target again and commit one undoable change. Normal drawing autosave then persists it.

### Icon recoloring flow

1. Select image → **Recolor icon**.
2. Open a preview with the existing application color picker and a labeled hexadecimal input.
3. Recolor all visible pixels to the selected RGB color while retaining each pixel's alpha.
4. Warn in the dialog that multicolor artwork becomes a single-color silhouette. For an opaque image, suggest removing the background first.
5. Apply/Cancel follow the same non-destructive commit rules as background removal.

For a native SVG imported as a raster image asset, operate on a safely rasterized representation and produce a PNG. Do not claim editable SVG paths or lossless vector recoloring in this release.

### Job states

`idle → validating → loading-model → processing → preview-ready → applying → complete`

Any active stage may lead to `cancelled` or `failed`. Recoloring skips model loading. Cancellation never applies a late result. “Applied” and “Saved” are separate states: the existing save indicator confirms persistence only after the server acknowledges it.

The dialog traps focus, supports Escape, restores focus to its trigger, announces progress/errors, and works with touch and small screens. A color swatch must have a text label/value.

## 4. Integration with this repository

The branch contains an upstream-style Excalidraw fork with a React editor and a self-hosted workspace application. Reuse its action system, binary-file model, history, and persistence.

| Existing area | Integration responsibility |
| --- | --- |
| `packages/excalidraw/components/Actions.tsx` | Full/compact/mobile image-action placement. |
| `packages/excalidraw/components/shapeActionPredicates.ts` | Shared eligibility predicate for image selection controls. |
| `packages/excalidraw/actions/types.ts` and action registration | A consistent action entry point and result/history handling. |
| `packages/excalidraw/types.ts` | Existing `BinaryFileData`, `getFiles`, `addFiles`, and scene APIs. |
| `packages/element/src/mutateElement.ts` | Existing element-update helpers and version bookkeeping. |
| `excalidraw-app/App.tsx` | Host provider, workspace permissions, and editor integration. |
| `excalidraw-app/data/workspaceScene.ts` | Existing scene/files save queue, draft recovery, and thumbnails. |
| `excalidraw-app/data/FileManager.ts` and collaboration code | Existing binary upload and remote image loading. |

Proposed new modules, with names adaptable to repository conventions:

- `packages/excalidraw/actions/actionImageProcessing.tsx`: editor action definitions.
- `packages/excalidraw/components/ImageProcessingDialog.tsx`: shared preview/apply UI.
- `excalidraw-app/image-processing/provider.ts`: orchestration and lazy provider loading.
- `excalidraw-app/image-processing/backgroundRemoval.worker.ts`: inference lifecycle.
- `excalidraw-app/image-processing/recolor.ts`: deterministic RGBA operation.
- `excalidraw-app/image-processing/types.ts`: typed job/input/result contracts.
- An asset manifest and provisioning script for pinned model/WASM files; do not commit large model blobs as ordinary source files.

Keep the reusable editor independent of a mandatory ML dependency. Prefer an optional host-supplied image-processing provider; enable the actions only when that provider is present. Resolve the precise prop/action integration after inspecting current action, dialog, and history patterns.

Follow `AGENTS.md`: use `app.ownerDocument` / `app.ownerWindow`, or the mounted node's owner document/window. Use `Merge<Base, Overrides>` for existing-type overrides. Worker code uses its worker scope rather than assuming a DOM window.

## 5. Processing architecture

The sequence is:

`selected element → original binary asset → processing worker → temporary PNG preview → Apply → new fileId → image element update → normal scene save`

### Provider contract

The provider takes a request ID, operation, image bytes and MIME type, validated options, cancellation signal, and progress callback. It returns PNG bytes plus output dimensions and provider/model metadata. The editor manages preview and commit; the worker must not mutate scene state.

Initialize the model lazily on first use and reuse one session for sequential jobs. Limit version one to one active inference job per editor instance. WebGPU is preferred only when the exact model/backend combination passes a capability probe; use a tested WASM fallback. WebGPU availability alone does not establish model compatibility.

Abort downloads where supported. If inference cannot be interrupted, terminate/recreate the dedicated worker or discard the completed response using the request ID. Release tensors, canvases, bitmaps, object URLs, and worker/session resources on completion or cancellation according to runtime requirements.

### Image handling

- Initial raster support: static PNG, JPEG, and WebP decoded by the browser.
- Reject animated/unsupported inputs with an explanation; do not silently discard animation frames.
- Rasterize SVG only using a reviewed safe path that rejects external resources and active content; otherwise mark it unsupported for this operation.
- Normalize orientation before inference and keep the output coordinate system aligned with the source used by the editor.
- Validate both compressed bytes and decoded pixel count before large allocations.
- Proposed starting limits: 10 MiB compressed input and 16 megapixels decoded input, further constrained by existing upload/save limits. Confirm these limits through memory tests; never silently lower output resolution.
- Model input may use a smaller resolution. Resize its predicted alpha mask back onto the normalized source pixel dimensions rather than resizing the actual canvas element.
- Preserve existing transparency: `outputAlpha = originalAlpha × predictedAlpha / 255`, with appropriate rounding.
- Avoid hard binary thresholds for photographic matting; retain soft edges. Guard against invalid, empty, or all-transparent results and let the user inspect questionable results before Apply.
- Emit PNG with alpha. JPEG is not an acceptable processed output format.

### Recolor implementation

For each pixel, preserve its original alpha and replace RGB with the selected RGB value. Perform the operation on straight-alpha image data, preserving antialiased edges and avoiding premultiplication halos. The output pixel dimensions remain unchanged.

For a flat-background mode, require a chosen/sampled background color and use a border-connected tolerance algorithm. Preserve enclosed light-colored artwork unless the user explicitly requests its removal. Give this mode its own preview and tests; it is not a substitute for photo segmentation.

## 6. Apply, asset identity, and undo

At job start, capture the drawing ID, element ID, original file ID, relevant element version, source asset version/hash, and user/workspace context.

At Apply:

1. Confirm the editor is still mounted, the same drawing/context is active, editing is allowed, and the job is current.
2. Re-read the target from the latest scene. If it was deleted, locked, edited, or had its asset changed during processing, mark the preview stale and ask the user to retry. Do not recreate a deleted element or overwrite another user's change.
3. Generate a new file ID using the repository's asset ID conventions. Never replace the bytes stored under the original file ID: other elements may share it.
4. Register the new `BinaryFileData` with `mimeType: image/png`, its data URL, creation time, and appropriate asset version.
5. Update only the target's file reference and required image status/version fields through the existing action/element helpers. Preserve geometry and other properties.
6. Commit exactly one undoable scene action. Confirm whether the existing action-result files path or `addFiles` plus a scene update gives the correct atomic history behavior before choosing the implementation.
7. Mark the new asset pending until existing persistence confirms it. Applying locally is not a successful server save.

Processing and changing preview colors must not create undo entries. Undo restores the old file reference; Redo restores the processed one. Retain the necessary assets for the editor's undo/redo lifetime. Do not promise undo history survives reload unless the existing application actually persists it.

An explicit “Restore original” feature after reload would require persisted provenance and original-asset retention. It is optional follow-up work, not implied by ordinary Undo.

## 7. Persistence, collaboration, and permissions

Reuse the existing `elements + appState + files` save flow. Do not create a second background-removal scene store or save a browser object URL as a durable asset.

- Register image bytes before updating the element reference so autosave never observes an unresolved new image.
- Verify refresh, scene duplication, `.excalidraw` export/import, and PNG/SVG exports retain the processed result and transparency.
- Check output size against existing server and collaboration asset limits before Apply. A transparent PNG can be much larger than the source JPEG.
- Reuse current save conflict/offline draft handling. Never label a failed save as Saved.
- A collaborator receives the resulting PNG through the existing asset flow; they should not run the model themselves.
- The originating client assigns the new file ID and broadcasts the normal element update. Asset loading failures must remain recoverable.
- On logout, scene switch, permission revocation, or unmount, cancel/discard pending work and clear its previews and references.
- Use existing `drawing.edit` authorization for applying an image edit. Read-only users cannot persist processed assets through a crafted request.

“Processed locally” describes the background-removal step. When the user applies the result in a server-backed or collaborative drawing, normal drawing synchronization uploads the resulting image. Explain this distinction accurately.

## 8. Hosting, privacy, and deployment

Host model, processor configuration, and WASM assets on the application's controlled origin under versioned paths. Pin dependencies and model revisions; retain their license notices and verify asset checksums during provisioning.

- Fetch model assets only when the feature is first used.
- Cache versioned model assets separately from private image data; do not put user images in a shared service-worker response cache.
- Provide progress and a retry action for failed or interrupted model downloads.
- Offline processing is available only after all required runtime/model files are cached and the browser supports the selected backend.
- Reuse the current CSP where possible and add only the worker/WASM allowances proven necessary for the pinned runtime.
- Some WASM threading configurations require cross-origin isolation. Do not add COOP/COEP headers globally without checking OAuth popups, embeds, fonts, collaboration, and other cross-origin resources. Prefer a supported single-thread fallback when isolation is unavailable.
- Do not log original images, generated images, data URLs, or temporary preview URLs. Performance metrics, if any, should contain only non-image timing/error categories.

If a server provider is later approved, put it behind the existing authenticated API with workspace checks, bounded jobs, timeouts, input limits, and private networking. Keep rembg's generic URL-fetch endpoint inaccessible to public clients. Bake or provision pinned model weights and reuse inference sessions. Explicitly inform users that this mode uploads images for processing.

## 9. Implementation order

1. **Inspect and baseline:** verify applicable instructions, branch state, image selection surfaces, history semantics, browser targets, storage limits, and existing tests. Keep unrelated work out of feature changes.
2. **Model/quality spike:** benchmark permitted candidates and record the model decision and limitations. Do not build a universal UI around an unverified portrait model.
3. **Provider and worker:** implement typed jobs, lazy loading, cancellation, capability detection, memory limits, error handling, and versioned asset provisioning.
4. **Recolor core:** implement deterministic recoloring and alpha-preservation tests; it must work without loading an ML model.
5. **Preview UI:** add full/compact/mobile actions, an accessible dialog, color picker, before/after views, progress, and retry/cancel states.
6. **Atomic Apply:** new immutable file IDs, latest-scene checks, correct element version/status updates, one history entry, and safe undo/redo.
7. **Persistence and collaboration:** verify real saved images, offline recovery, remote asset delivery, and authorization failure handling.
8. **Packaging and release validation:** build, typecheck, lint, targeted tests, actual browser/device tests, asset checksum/license inventory, and deployment instructions.

Do not install dependencies, download model weights, or implement the feature as part of delivering this specification. Those are steps for the implementation task.

## 10. Acceptance criteria

1. An eligible image exposes the actions consistently in supported desktop/mobile selection layouts.
2. Locked, read-only, unloaded, deleted, and unsupported images cannot start or apply an invalid operation.
3. Recoloring changes RGB while preserving alpha and source dimensions, without any model download.
4. Cancel, inference failure, failed model download, and closing the dialog leave the scene unchanged.
5. Only Apply changes the drawing, creating one undo entry; Undo and Redo show the correct assets.
6. Two elements sharing the same original file remain independent when processing only one.
7. Crop, flip, rotation, opacity, geometry, frame membership, links, and bindings remain visually correct.
8. Deleting/changing the target, switching drawings, or revoking permissions while processing cannot apply a stale result.
9. Preview and export transparency look correct against light, dark, and checkerboard backgrounds without introduced edge halos.
10. Save/reload, duplicate, `.excalidraw` round-trip, and image export preserve the processed asset.
11. Failed/offline saves retain the processed draft and display truthful save status.
12. Collaborators receive the new asset/reference; no collaborator needs to rerun background removal.
13. A network trace shows no user image sent to a third-party inference service in browser mode. Normal workspace uploads happen only through existing persistence.
14. The initial editor load does not download the model. Repeated operations reuse the loaded runtime/model where safe.
15. Oversized/malformed inputs fail gracefully without freezing the editor or applying partial data.
16. Keyboard focus, Escape, screen-reader announcements, touch controls, and small-screen layout pass actual UI verification.
17. Both the chosen WebGPU path and supported WASM fallback pass real-device testing. Document unsupported combinations honestly.
18. Publish measured cold/warm timings, asset sizes, device/browser details, and known image-quality limitations. Do not substitute mocked model tests for quality evaluation.

## 11. Test and delivery record

Unit tests should cover pixel/alpha math, input validation, eligibility, cancellation IDs, stale-target checks, shared-source isolation, and geometry preservation. Editor tests should cover history, files registration, scene switching, and permission changes. Integration tests should cover actual image persistence/export and collaboration asset delivery.

Keep a small, permission-cleared image fixture set and record visual before/after comparisons for the selected model. Use deterministic provider stubs for failure/race tests and real model runs for quality and browser compatibility.

Deliver the feature code, pinned lockfile, asset provisioning/checksum manifest, license notices, targeted tests, measured benchmark notes, and self-hosting instructions. Report which checks actually ran and any remaining limitations. Deploying the feature is a separate step from writing this specification.

## 12. Local implementation and validation record

The `background-removal` branch currently provides **Remove flat background** and **Recolor icon** for one selected PNG, JPEG, or WebP image. A selection exposes the controls on desktop and mobile through the host editor's top-right UI. The dialog previews locally; Apply creates a new PNG asset ID, validates that the source element and drawing have not changed, and updates only that element in one undoable scene update. The 4 MiB output cap follows the existing collaboration upload limit. The current decoded-image cap is 4 megapixels to bound synchronous canvas work.

This is an icon/solid-background feature, **not photo or portrait segmentation**. The flat mode removes only color-matching pixels connected to an image edge. Complex photographic backgrounds, hair matting, antialiased edge refinement, animated files, and SVG rasterization remain unsupported. The portrait/general-model comparison, pinned runtime/model assets, worker execution, and cross-device benchmarks in sections 2 and 9 are still required before claiming general background removal.

Local checks completed on 6 October 2026: TypeScript typecheck, targeted ESLint, Vite build, three pixel-operation tests, and an isolated localhost browser flow. In that flow, a synthetic black-on-white icon became transparent, survived browser-storage reload, was recolored red without losing transparency, and survived another reload. Undo and Redo each advanced through one recolor history step. No workspace server, collaboration session, production environment, mobile device, or model-quality benchmark was exercised. Release acceptance criteria involving those environments remain open.
