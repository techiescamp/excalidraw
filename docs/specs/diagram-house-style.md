# The house style, read off the diagrams that already exist

## Why

The blueprint engine draws a correct diagram. It does not yet draw *this*
workspace's diagram. There are about a hundred finished Excalidraw diagrams in
the owner's own folder — the ones published under the DevOpsCube name — and
they share a style that is consistent enough to be written down and built in.

This document is what ten of them have in common. It is the reference for every
default in the drawing engine, so the engine's output needs no hand-editing to
sit beside the existing set.

Read from: ArgoCD Architecture, Istio Architecture Explained, HPA Scaling on
Custom Metrics, Anatomy of a Terraform project, k8s Dynamic Admission
Controllers, GitLab Architecture, CRI vs CNI vs CSI vs CDI, Kubernetes Service
Anatomy, k8s Gateway API for Mesh Management, Kubeflow Pipelines, Kubernetes Pod
Anatomy.

## The page

- Portrait more often than landscape; square happens. Near-white canvas
  (`#f8f9fa`), or near-black for the dark ones.
- **A thin rounded frame around the whole page**, a few pixels in from the edge,
  grey and hairline. Every single diagram has it. It is what makes the image
  read as a finished card rather than a screenshot of a canvas.
- The brand mark is the DevOpsCube logo, top-right or bottom-centre.

## The title

Always at the top, large, and never inside a pastel banner. Four treatments:

| Treatment | Where it was seen |
|---|---|
| **Underlined** — a hand-drawn rule under the words | ArgoCD, Istio, CRI/CNI, Terraform |
| **Highlighted** — one phrase sitting in a filled yellow box | k8s Dynamic Admission Controllers |
| **Barred** — a short thick coloured bar to the left of the words | GitLab Architecture |
| **Plain** | Gateway API, Pod Anatomy |

Underlined is the most common, so it is the default.

## Boundaries, and their corners

This is the signature of the style, and the thing the engine was missing.

A boundary is a thin rectangle with a pale tint. **Its name is not plain text in
the corner — it is a small filled pill that straddles the boundary's top edge**,
tucked into the left or right corner, or centred:

- ArgoCD: "Management k8s Cluster" — cyan pill, centred on the top edge.
- Istio: "node 01" / "node 02" — pink pills in the top-left and top-right corners.
- Kubeflow: "Kubernetes" — green pill in the top-right corner.
- Gateway API: "v1" / "v2" — tiny pills on the top-left corners of two small boundaries.
- GitLab: a pill per lane, centred above each.

The pill is filled in a tint of the boundary's own colour, outlined in the
boundary's stroke, and its text is the same weight as the boundary's.

Boundary strokes are solid, dashed, or dotted, and the choice carries meaning:
dashed for something logical rather than physical (a Deployment, a namespace
scope), solid for something real (a cluster, a node, an account).

## Three structures

Nearly every diagram is one of three shapes:

1. **Flow.** Boxes connected by arrows, laid out along the flow. Already built.
2. **Lanes.** Full-height tinted columns side by side, one per stage or tier,
   each with its pill label at the top, arrows crossing between them.
   (GitLab Architecture: External | Gateway | Application | Processing | Data.)
3. **Bands.** Full-width tinted rows stacked down the page, one per topic, each
   with its own small flow inside and a one-line caption under it.
   (CRI vs CNI vs CSI vs CDI.)

## Nodes

Two kinds, and the one that was missing matters more:

- **Tile** — a filled rounded box, icon at the left, label beside it. Built.
- **Plain** — *no box at all*: a large icon with its label underneath, often in
  violet when it names a product. This is the more common of the two in these
  diagrams. Terraform project, Istio, ArgoCD, HPA and Pod Anatomy are drawn
  almost entirely from plain nodes.

## Arrows

- Hairline, black, right angles with rounded corners, a plain arrowhead.
- Dashed grey or black for a watch or a background flow.
- Dashed orange for a trigger or a webhook.
- A coloured solid line for the one path the diagram is about.
- Labels are plain text beside the line, never in a box — unless the label is
  the point, and then it gets a thin box in the line's own colour.

## Step numbers

A filled circle with the numeral, and the step's words beside it. **Amber fill,
darker amber outline, dark numeral** — not the solid black of an AWS reference
diagram. (Admission Controllers numbers 1–6; Service Anatomy numbers its three
sections the same way.)

## The legend

A box with a filled header strip and one row per entry. Rows are a colour
swatch and a name, a tick and `Name -> Role`, or a short line in the line's own
style and what that style means.

## What was built from this

All of it, in the engine and in the drawing tools:

1. **Boundary names as corner pills**, `label_at` choosing top-left, top-centre
   or top-right. The pill straddles the top edge and is tinted with the
   boundary.
2. **Boundary `style`** — solid, dashed or dotted — and **`color`**, which tints
   the boundary and its pill together so the two never drift apart.
3. **`layout: "lanes"` and `layout: "bands"`.** Lanes stand side by side in the
   order they were written, every one the height of the tallest, and a lane's
   own nodes come out as a column. Bands stack down the page at one width,
   each with its flow inside and a `caption` under it.
4. **`shape: "plain"`** — a large icon with its name underneath and no box, and
   the name lettered in the colour of what the thing is.
5. **The four title treatments**, `underline` by default.
6. **The page frame**, on unless `style.frame` is false.
7. **Amber step badges.**
8. **`theme: "dark"`** — dark page, light lettering, tiles drawn as outlines in
   their own colour.

## Placing a copy by hand

A reference picture is not the output of a layout algorithm, and an engine
asked to guess its way back to one never arrives at the picture. So the engine
can be told to stop deciding:

- `layout: "manual"` — every node and boundary carries `at: {x, y, w, h}` in
  pixels, read straight off the reference, snapped to the grid. Nothing is
  moved.
- A node's name goes on any side with `label_at`: left, right, above, below or
  inside. A reference diagram names Route 53 and the load balancer to their
  left and the data stores below them.
- **An empty label draws nothing.** Most product logos carry their own
  wordmark; repeating it underneath is what makes a copy look wrong.
- A boundary's name can be set `label_style: "plain"` — centred words over the
  region instead of a pill — and it can carry a `badge`, a provider's mark
  straddling its corner.
- An arrow can join two boundaries, not just two boxes: the line from a build
  account to a production one leaves the region itself.
- `route: "straight"` on an edge draws a direct line. A fan-out from one box to
  a row of them is straight in every reference diagram there is, and forcing
  those into elbows is what makes a copy look nothing like the original.

## What is not being built

- The isometric 3D illustrations. Those are drawn by hand, or are stock art;
  the engine places icons, not artwork.
- The code panel with the three traffic-light dots. Worth doing, not yet.
- Free-floating hand-drawn callout arrows.
- Mixed reading directions in one drawing — a diagram that reads left to right
  between two clouds and top to bottom inside one of them. The engine has one
  direction per drawing.

## How it is verified

Unit tests over each new piece of geometry: lanes side by side at one height
with a lane's nodes in a column, bands stacked at one width with their
captions, a plain node's picture above its name and lettered in its role's
colour, each title treatment, a dark page drawn as outlines, and a boundary
named in the corner that was asked for with its pill straddling the top edge
and tinted to match.

By hand on the local instance: the GitLab architecture redrawn as lanes and put
beside the published one, and the reference architecture from the last round
redrawn in the house style. Both checked against the exported scene — every
element inside the page frame, no two pieces of text overlapping, every icon
placed.
