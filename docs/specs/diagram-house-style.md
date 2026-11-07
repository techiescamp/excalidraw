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

## Boxes

Square corners, everywhere and without exception — tiles, boundaries, name
pills, notes, panels, the terminal window, the title block and the page frame.
A curve appears only when `corners: "round"` asks for one. The rounded rectangle is the editor's default and it is not
what these diagrams use, so the engine draws corners unless asked for
`corners: "round"`.

## Nodes

Two kinds, and the one that was missing matters more:

- **Tile** — a filled rounded box, icon at the left, label beside it. Built.
- **Plain** — *no box at all*: a large icon with its label underneath, often in
  violet when it names a product. This is the more common of the two in these
  diagrams. Terraform project, Istio, ArgoCD, HPA and Pod Anatomy are drawn
  almost entirely from plain nodes.

## Arrows

- Hairline, black, right angles with **square** corners, and a **solid filled
  triangle** head. The rounded elbow and the open V are the editor's defaults,
  not this house's; no diagram in the set uses either.
- A line goes **straight from one box to the other**. It does not take a detour
  around something in the way, and two boxes a few pixels out of line are
  treated as in line rather than joined with a wiggle.
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

## The other kinds of picture in the folder

Read from a second pass over the folder: `complex_workflows`, `SDLC vs MDLC`,
`pod_starts`, `Kubernetes Pod Graceful Shutdown`, `Canary vs Shadow
Deployment`, `Image Signing and Attestations`, `Argo Workflows (DAG)`,
`Helm Chart Structure`, `Secure Kubernetes With User Namespaces`, `From CPU to
Distributed GPU Training`.

Not all of these are architecture. They are workflows, comparisons and
explainers, and what they have that an architecture diagram does not is a small
set of pieces that are not boxes:

| Piece | Where it was seen |
|---|---|
| **A code window** — dark, three lights, one line picked out in amber | complex_workflows, pod_starts, User Namespaces, Gateway API, HPA |
| **A note** — a card saying what one part is, hung off a dashed or curved line, sometimes with a tick or a cross | complex_workflows, Canary vs Shadow, Argo DAG, User Namespaces |
| **A panel** — a key down the side: a heading and rows of coloured chip plus words | Argo DAG (twice), Istio, Service Anatomy |
| **A strip across the foot** of the page, carrying the one line to leave with | Graceful Shutdown |
| **A rule** between two halves being compared, with no boxes around them | Canary vs Shadow |
| **A measured span** — a line with a head at each end and its size above | Graceful Shutdown |
| **Loose coloured words** pointing at something | Image Signing, GPU Training, User Namespaces |
| **A thick line for the one path** the picture is about | Argo DAG |

All of these are now in the drawing tool as `extras`, each with its own
`at: {x, y}`, and one given an `id` can have an arrow pointed at it. An edge
takes a `width` from 1 to 4 for the main path.

## Measured, not guessed

Everything above was read off exported pictures. The defaults below were
measured instead, from twenty of this workspace's own published drawings on the
production site, read through its API without opening or changing any of them.

| Setting | What the drawings use | What the engine now does |
|---|---|---|
| Arrowhead | solid triangle 266, open V 24 | triangle |
| Box corners | sharp 385, rounded 72 | sharp |
| Line weight | 1 → 1111, 2 → 450, 4 → 76 | 1, with `width` up to 4 |
| Roughness | 0 in 85% of elements | 0 |
| Canvas | `#ffffff` in 17 of 20 | `#ffffff` |
| Body text size | 20 (190), then 16 (183) | **20**, which is the editor's M |
| Title size | 28 | 28 |
| Font | Comic Shanns 283, Virgil 177, Excalifont 168 | **Comic Shanns** by default |
| Most used fill | `#ced4da`, a mid grey | the outermost boundary's fill |

The body size is the one that mattered most: this engine was drawing at 16 and
everything it produced came out small beside the real set.

## What is not being built

- The isometric 3D illustrations. Those are drawn by hand, or are stock art;
  the engine places icons, not artwork.
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

## Copying a picture to the pixel

Everything above is about drawing in this house's style. This section is about
the other job: being handed a picture and giving it back.

The engine was close and kept missing, and each miss had the same shape — a
number the engine rounded, capped or re-wrapped on the way through.

| What went wrong | Why | What it does now |
|---|---|---|
| Every small piece up to 10px out | One 20px grid for everything | A hand-placed drawing sits on a 5px grid; a laid-out one still sits on 20 |
| Headings a fifth too small | Text stopped at L (28) | XL (36) exists, and `style.title_size` picks it |
| Half a drawing silently missing | `extras` capped at 40, no warning | The cap is 200 and going over it is reported |
| Boxes captioned `card3` | A node with no label drew its id | It still does, and now says so |
| A label out past the edge of its own box | Labels wrapped at a fixed 24 letters | A hand-placed box wraps to the width it was given |
| A heading sitting on the line under it | Loose text was snapped twice, once by the caller and again on the way out | Snapped once, by the caller, on the drawing's own grid |
| Exports came back at the wrong size | The scene was saved at whatever zoom | Every scene is saved at 100% |
| Lines ploughing through the box in between | `straight` drew a diagonal; the router turned just before the target | `elbow` turns just after the box it leaves, and two boxes in line are joined straight |

**Measure, do not judge by eye.** Read the picture's pixels and take the real
box of every piece: each panel, pill, bubble, icon, box, bar and line of text.
Placing from a glance is what put a pill 20px low and a document 40px tall.

Measured against the picture it was copied from, panel by panel, the worst
piece now lands 1.4% of a panel's size from where it sits in the original.
