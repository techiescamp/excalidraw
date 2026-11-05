# Blueprint diagrams from an assistant

## Why

An assistant can already ask this workspace to draw: it sends nodes and edges, and the server lays them out. What comes back is a flowchart. What people actually want is the diagram that anchors a blog post or a design document — nested boundaries, aligned tiles, right-angled arrows, numbered steps, a legend, and the product's own icon on each box.

The gap is not the assistant's wording. It is that the layout engine has no vocabulary for any of that, so no amount of prompting can produce it.

## What this adds

A richer drawing spec, and an engine that honours it:

- **A 20px grid.** Every coordinate the engine emits is a multiple of 20.
- **Zones.** Named boundaries that contain nodes and other zones, up to four levels deep, each level with its own fill, opacity and stroke, 40px of padding inside, 60px between siblings.
- **Roles instead of colours.** A node says what it _is_ — control plane, data plane, storage, external, gateway, error, observability, neutral — and the engine picks the fill and stroke. One role always looks the same.
- **Right-angled arrows.** Connections leave a box on one side and enter the next on the facing side, turning at right angles. No diagonals.
- **Numbered steps.** An edge may carry a step number; the engine draws the badge at the arrow's start.
- **A legend**, drawn when the diagram uses five or more roles or when it is asked for, listing each role once.
- **A title banner** and an optional brand mark in the corner.
- **Icons on the left of a tile**, not above the label, so a tile reads as a product the way a reference architecture does.
- **Warnings.** Every create or redraw answers with what the engine had to correct or could not do — an unknown icon, a seventh colour, a label that had to wrap — in words the assistant can act on.

## What this does not do

- It does not read images. An assistant that is given a picture describes it in the spec; the server draws it. The server never sees the picture.
- It does not lay out freehand art. This is for structured diagrams.
- It does not replace the existing simple path: a spec with only nodes and edges keeps working exactly as before.

## Data

No migration. Icons are read from the workspace library that already exists. Nothing new is stored; the drawing that comes out is an ordinary scene.

## How it is verified

- Unit tests over the engine: grid alignment, zone nesting and padding, role colours, right-angled routing, badge placement, legend contents, warnings.
- The existing server suite, unchanged, proving the simple path still works.
- By hand on the local instance: ask the assistant for a real architecture diagram, open it in the editor, and look at it.

## Rollback

The engine is one file. The spec fields are optional; a spec that does not use them is laid out as before, so reverting the file reverts the feature.
