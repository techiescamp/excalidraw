# Blueprint diagrams from an assistant

## Why

An assistant can already ask this workspace to draw: it sends nodes and edges, and the server lays them out. What comes back is a flowchart. What people actually want is the diagram that anchors a blog post or a design document — nested boundaries, aligned tiles, right-angled arrows, numbered steps, a legend, and the product's own icon on each box.

The gap is not the assistant's wording. It is that the layout engine has no vocabulary for any of that, so no amount of prompting can produce it.

## What this adds

A richer drawing spec, and an engine that honours it:

- **A 20px grid.** Every coordinate the engine emits is a multiple of 20.
- **Zones.** Named boundaries that contain nodes and other zones, up to four levels deep, each level with its own fill, opacity and stroke, 40px of padding inside, 60px between siblings.
- **Roles instead of colours.** A node says what it _is_ — control plane, data plane, storage, external, gateway, error, observability, neutral — and the engine picks the fill and stroke. One role always looks the same.
- **Right-angled arrows that go around things.** Connections leave a box on one side and enter the next on the facing side, turning at right angles, and never crossing a box they do not belong to: the engine tries the clean shapes in order — straight, one turn in the gap, a turn anywhere else along the run — and failing all of those takes the line out into a clear lane and back in. A line through an unrelated tile reads as a mistake even when the structure behind it is right.
- **Numbered steps.** An edge may carry a step number. The badge goes beside the start of its line, and if that place is taken it moves along the same line until it finds somewhere clear of every tile and every boundary name.
- **A legend**, drawn when the diagram uses five or more roles or when it is asked for, listing each role once.
- **A title banner** and an optional brand mark in the corner.
- **Icons on the left of a tile**, not above the label, so a tile reads as a product the way a reference architecture does.
- **Icons found by meaning, not by name.** A node asks for "database", "message queue" or "load balancer" and the closest icon in the workspace library is used — postgresql, kafka, nginx — because an assistant describing a system knows what a box is, not what this library happens to call the picture. Words that mean the same thing are grouped; a set or a category in common is not enough to stand in for what was asked, so an unrelated request leaves the box plain rather than reaching for whatever is nearest. The name on the box settles a tie, so a tile labelled Prometheus asking for "metrics" does not come back with Grafana. The same search backs `list_icons`, and every substitution is reported in the warnings.
- **A prompt, `diagram_rules`**, carrying the house rules an assistant should follow, including how to turn a picture somebody sends it into a description this server can draw. A tool description has to be short; this does not.
- **Warnings.** Every create or redraw answers with what the engine had to correct or could not do — an unknown icon, a seventh colour, a label that had to wrap — in words the assistant can act on.

## What this does not do

- It does not read images. An assistant that is given a picture describes it in the spec; the server draws it. The server never sees the picture.
- It does not lay out freehand art. This is for structured diagrams.
- It does not replace the existing simple path: a spec with only nodes and edges keeps working exactly as before.

## Data

No migration. Icons are read from the workspace library that already exists. Nothing new is stored; the drawing that comes out is an ordinary scene.

## How it is verified

- Unit tests over the engine: grid alignment, zone nesting and padding, role colours, right-angled routing, arrows clear of unrelated boxes, badge placement, legend contents, warnings.
- Unit tests over icon matching, with no database: the product found from what it is, from another of its names, an upload found by the name a person gave it, a tie settled by the box's label, and nothing offered for words the library has no answer to.
- The existing server suite, unchanged, proving the simple path still works.
- By hand on the local instance: ask the assistant for a real architecture diagram, open it in the editor, and look at it.

## Rollback

The engine is one file. The spec fields are optional; a spec that does not use them is laid out as before, so reverting the file reverts the feature.
