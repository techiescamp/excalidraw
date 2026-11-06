import crypto from "node:crypto";
import { fail } from "./core.js";

// Turns a described diagram into real Excalidraw elements. The description says
// what connects to what; everything about position and size is decided here,
// because language models place boxes badly and arrows worse.

// Font ids come from packages/common/src/constants.ts and must match the editor.
export const FONTS = {
  "hand-drawn": 5,
  excalifont: 5,
  inter: 15,
  roboto: 16,
  "ibm plex sans": 17,
  "source sans 3": 18,
  manrope: 19,
  "dm sans": 20,
  "plus jakarta sans": 21,
  "nunito sans": 22,
  nunito: 6,
  "playpen sans": 23,
  "lilita one": 7,
  "comic shanns": 8,
  helvetica: 2,
  cascadia: 3,
  monospace: 3,
};
// Excalidraw's own palette, so generated drawings match hand-drawn ones.
export const COLORS = {
  black: { stroke: "#1e1e1e", fill: "transparent" },
  grey: { stroke: "#343a40", fill: "#e9ecef" },
  blue: { stroke: "#1971c2", fill: "#a5d8ff" },
  green: { stroke: "#2f9e44", fill: "#b2f2bb" },
  red: { stroke: "#e03131", fill: "#ffc9c9" },
  orange: { stroke: "#f08c00", fill: "#ffec99" },
  violet: { stroke: "#6741d9", fill: "#d0bfff" },
  teal: { stroke: "#0c8599", fill: "#99e9f2" },
  pink: { stroke: "#c2255c", fill: "#fcc2d7" },
  yellow: { stroke: "#f08c00", fill: "#ffec99" },
};
const SHAPES = ["rectangle", "ellipse", "diamond"];
const FONT_SIZE = 16;
const LINE_HEIGHT = 1.25;
const PADDING = 24;
const MIN_WIDTH = 160;
const MIN_HEIGHT = 80;
const GAP_ACROSS = 140;
const GAP_DOWN = 70;
const MAX_NODES = 120;
const MAX_LABEL = 160;
const ICON = 40;
const ICON_GAP = 20;
// A node drawn without a box: a large picture with its name underneath. More of
// the diagrams in the house set are drawn this way than with tiles.
const ICON_PLAIN = 64;
const PLAIN_GAP = 8;

// Everything below exists to make a drawing read as a blueprint rather than a
// flowchart: one grid, one colour per role, boundaries that nest, and arrows
// that turn at right angles. docs/specs/diagram-blueprint.md says why.

// One grid, and every coordinate on it. This single rule does most of the work
// of making a diagram look deliberate rather than placed by hand.
const GRID = 20;
const snap = (value) => Math.round(value / GRID) * GRID;

const ZONE_PADDING = 40; // between a boundary and anything inside it
const SIBLING_GAP = 40; // between tiles in the same boundary
const ZONE_GAP = 60; // between boundaries
const BADGE = 36; // numbered step
const TITLE_SIZE = 30;
const ZONE_LABEL_SIZE = 16;
const SMALL_SIZE = 14; // arrow labels, legend rows, the brand mark
const LEGEND_WIDTH = 280;
const LEGEND_ROW = 32;
const MAX_FILLS = 6; // more than this and two roles are really one role

// Colour means role, never decoration. A reader learns "violet is the control
// plane" once and carries it through the whole diagram.
export const ROLES = {
  "control-plane": {
    fill: "#e5dbff",
    stroke: "#8b5cf6",
    name: "Control plane",
  },
  "data-plane": { fill: "#a5d8ff", stroke: "#4a9eed", name: "Data plane" },
  storage: { fill: "#c3fae8", stroke: "#0d9488", name: "Storage" },
  external: { fill: "#ffd8a8", stroke: "#f59e0b", name: "External system" },
  gateway: { fill: "#b2f2bb", stroke: "#22c55e", name: "Gateway" },
  error: { fill: "#ffc9c9", stroke: "#ef4444", name: "Failure path" },
  observability: { fill: "#eebefa", stroke: "#c026d3", name: "Observability" },
  neutral: { fill: "#f1f3f5", stroke: "#757575", name: "Other" },
};

// Each nesting level is drawn differently so the eye can separate them. Four
// levels is the practical ceiling; past that a diagram reads as one blob.
const LEVELS = [
  {
    fill: "transparent",
    opacity: 100,
    stroke: "#757575",
    strokeWidth: 1,
    tag: "#f1f3f5",
  },
  {
    fill: "#dbe4ff",
    opacity: 25,
    stroke: "#4a9eed",
    strokeWidth: 1,
    tag: "#d0ebff",
  },
  {
    fill: "#fff3bf",
    opacity: 40,
    stroke: "#f59e0b",
    strokeWidth: 1,
    tag: "#ffec99",
  },
  {
    fill: "#e5dbff",
    opacity: 45,
    stroke: "#8b5cf6",
    strokeWidth: 1,
    strokeStyle: "dashed",
    tag: "#e5dbff",
  },
];
// A boundary is named by a small filled pill straddling its top edge rather
// than by text dropped inside its corner. Every finished diagram in the set
// this style is read from does it this way, and it is what makes a boundary
// read as a labelled region instead of a rectangle with a caption in it.
const TAG_HEIGHT = 32;
const TAG_PADDING = 14;
const TAG_INSET = 20; // from the corner it is tucked into
const TAG_PLACES = ["top-left", "top-center", "top-right"];
const TITLE_STYLES = ["underline", "plain", "highlight", "bar", "banner"];
// A provider's mark on the corner of its own region.
const BADGE_ART = 56;
const LABEL_PLACES = ["inside", "left", "right", "above", "below"];
const LABEL_GAP = 12;

// An edge says what kind of connection it is; the drawing follows from that.
// Every weight here is the editor's own thin default except the primary path,
// which is one step up: a published architecture diagram is read at a glance,
// and uniformly heavy lines make the boxes compete with what connects them.
const EDGE_KINDS = {
  sync: { color: "#1e1e1e", strokeWidth: 1, strokeStyle: "solid" },
  async: { color: "#757575", strokeWidth: 1, strokeStyle: "dashed" },
  primary: { color: null, strokeWidth: 2, strokeStyle: "solid" },
  bidirectional: { color: "#1e1e1e", strokeWidth: 1, strokeStyle: "solid" },
};

// Average advance width per font size unit. Close enough for box sizing; the
// editor rewraps bound text to the container, so small errors stay invisible.
const WIDTH_RATIO = 0.56;
const measure = (text, fontSize = FONT_SIZE) => {
  const lines = String(text).split("\n");
  const longest = lines.reduce((a, b) => (a.length > b.length ? a : b), "");
  return {
    width: Math.ceil(longest.length * fontSize * WIDTH_RATIO),
    height: Math.ceil(lines.length * fontSize * LINE_HEIGHT),
    lines,
  };
};
// Long labels wrap rather than stretching a box across the canvas.
const wrap = (text, limit = 24) => {
  const words = String(text).replace(/\s+/g, " ").trim().split(" ");
  const lines = [];
  let line = "";
  for (const word of words) {
    if (!line) line = word;
    else if ((line + " " + word).length <= limit) line += " " + word;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.join("\n");
};

let order = 0;
const index = () => "a" + String(order++).padStart(4, "0");
const seed = () => Math.floor(Math.random() * 2 ** 31);
const element = (type, props) => ({
  id: crypto.randomUUID(),
  type,
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  angle: 0,
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 1,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  groupIds: [],
  frameId: null,
  roundness: type === "rectangle" ? { type: 3 } : null,
  seed: seed(),
  version: 1,
  versionNonce: seed(),
  isDeleted: false,
  boundElements: null,
  updated: Date.now(),
  link: null,
  locked: false,
  index: index(),
  ...props,
});

const label = (
  text,
  container,
  fontFamily,
  strokeColor,
  fontSize = FONT_SIZE,
) => {
  const size = measure(text, fontSize);
  return element("text", {
    text,
    originalText: text,
    fontSize,
    fontFamily,
    textAlign: "center",
    verticalAlign: "middle",
    containerId: container.id,
    strokeColor,
    width: size.width,
    height: size.height,
    lineHeight: LINE_HEIGHT,
    autoResize: true,
    x: container.x + (container.width - size.width) / 2,
    y: container.y + (container.height - size.height) / 2,
  });
};

// Layered placement: every node sits one step further along than whatever points
// at it, which is what makes a flow read in one direction.
const layerNodes = (nodes, edges) => {
  const layer = new Map(nodes.map((node) => [node.id, 0]));
  for (let pass = 0; pass < nodes.length; pass++) {
    let moved = false;
    for (const edge of edges) {
      if (!layer.has(edge.from) || !layer.has(edge.to)) continue;
      const next = layer.get(edge.from) + 1;
      if (layer.get(edge.to) < next) {
        layer.set(edge.to, next);
        moved = true;
      }
    }
    if (!moved) break; // cycles stop here instead of spinning
  }
  const columns = new Map();
  for (const node of nodes) {
    const depth = layer.get(node.id);
    if (!columns.has(depth)) columns.set(depth, []);
    columns.get(depth).push(node);
  }
  return columns;
};

// One block of nodes, laid out in columns along the flow direction. Local
// coordinates: the caller decides where the block as a whole lands.
const layoutNodes = (nodes, edges, down, sizes) => {
  const columns = layerNodes(nodes, edges);
  const depths = [...columns.keys()].sort((a, b) => a - b);
  const spans = depths.map((depth) =>
    columns
      .get(depth)
      .reduce(
        (total, node) =>
          total +
          (down ? sizes.get(node.id).width : sizes.get(node.id).height) +
          SIBLING_GAP,
        -SIBLING_GAP,
      ),
  );
  const longest = Math.max(0, ...spans);
  const boxes = new Map();
  let across = 0;
  depths.forEach((depth, position) => {
    // Columns are centred against the longest one, so a diagram reads down its
    // middle instead of hanging off one edge.
    let along = snap((longest - spans[position]) / 2);
    let thickest = 0;
    for (const node of columns.get(depth)) {
      const size = sizes.get(node.id);
      boxes.set(node.id, {
        x: snap(down ? along : across),
        y: snap(down ? across : along),
        width: size.width,
        height: size.height,
      });
      along += (down ? size.width : size.height) + SIBLING_GAP;
      thickest = Math.max(thickest, down ? size.height : size.width);
    }
    across += thickest + GAP_ACROSS;
  });
  return { boxes, ...bounds(boxes.values()) };
};

const PAGE_MARGIN = 40;

// Where everything drawn so far actually reaches, in all four directions. The
// bounds helper only measures right and down, because a block starts at the
// origin; a finished page does not.
const extent = (elements) => {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const item of elements) {
    if (!Number.isFinite(item.x) || !Number.isFinite(item.y)) continue;
    left = Math.min(left, item.x);
    top = Math.min(top, item.y);
    right = Math.max(right, item.x + (item.width || 0));
    bottom = Math.max(bottom, item.y + (item.height || 0));
  }
  return Number.isFinite(left) ? { left, top, right, bottom } : null;
};

const bounds = (boxes) => {
  let width = 0;
  let height = 0;
  for (const box of boxes) {
    width = Math.max(width, box.x + box.width);
    height = Math.max(height, box.y + box.height);
  }
  return { width: snap(width), height: snap(height) };
};

// A boundary holds its own nodes and any boundaries inside it. Both are laid
// out together, by the same layering: a boundary stands in for everything
// inside it, so an arrow into one puts it after whatever feeds it. Stacking the
// boundaries after the loose nodes instead is what used to leave a database at
// the top of a diagram and the servers that write to it underneath.
const ZONE_MARGIN = Math.max(0, ZONE_GAP - SIBLING_GAP);
const zoneItem = (id) => `\u0000zone:${id}`;

// Lanes side by side, or bands stacked: spec order along the page, every one
// stretched to the same measure across, so the set reads as a single rack.
const rankedGroup = (own, children, sizes, context) => {
  const across = context.archetype === "lanes";
  const boxes = new Map();
  let along = 0;
  let thickest = 0;
  // Nodes that are in no boundary at all sit ahead of the rack, in a block of
  // their own: in these diagrams that is the user, or the internet.
  if (own.length) {
    const block = layoutNodes(own, context.edges, context.down, sizes);
    for (const [id, box] of block.boxes) boxes.set(id, box);
    along = (across ? block.width : block.height) + ZONE_GAP;
    thickest = across ? block.height : block.width;
  }
  for (const child of children) {
    const size = sizes.get(zoneItem(child.id));
    boxes.set(zoneItem(child.id), {
      x: snap(across ? along : 0),
      y: snap(across ? 0 : along),
      width: size.width,
      height: size.height,
    });
    along += (across ? size.width : size.height) + ZONE_GAP;
    thickest = Math.max(thickest, across ? size.height : size.width);
  }
  // Every lane the height of the tallest, every band the width of the widest.
  for (const child of children) {
    const box = boxes.get(zoneItem(child.id));
    if (across) box.height = snap(thickest);
    else box.width = snap(thickest);
  }
  return { boxes, ...bounds(boxes.values()) };
};

// Where a node's name goes when it is not inside the box. A reference diagram
// names a box on whichever side has room — Route 53 and the load balancer are
// named to their left, the data stores below — and copying one means being
// able to say so.
// An icon keeps the shape it was drawn at. Given a box to sit in, it takes the
// largest size with its own proportions that fits, centred: a wordmark squashed
// into a square, or a square logo pulled into a tall slot, is the first thing
// anyone notices in a drawing.
const fitArt = (area, aspect) => {
  const ratio = Number(aspect);
  if (!Number.isFinite(ratio) || ratio <= 0)
    return { x: area.x, y: area.y, width: area.width, height: area.height };
  let width = area.width;
  let height = width / ratio;
  if (height > area.height) {
    height = area.height;
    width = height * ratio;
  }
  return {
    x: snap(area.x + (area.width - width) / 2),
    y: snap(area.y + (area.height - height) / 2),
    width: Math.max(GRID, Math.round(width)),
    height: Math.max(GRID, Math.round(height)),
  };
};

const besideBox = (area, measured, place) => {
  const middleY = snap(area.y + (area.height - measured.height) / 2);
  const middleX = snap(area.x + (area.width - measured.width) / 2);
  if (place === "left")
    return { x: snap(area.x - LABEL_GAP - measured.width), y: middleY };
  if (place === "right")
    return { x: snap(area.x + area.width + LABEL_GAP), y: middleY };
  if (place === "above")
    return { x: middleX, y: snap(area.y - LABEL_GAP - measured.height) };
  return { x: middleX, y: snap(area.y + area.height + LABEL_GAP) };
};

const layoutGroup = (zoneId, context) => {
  const own = context.nodesByZone.get(zoneId) || [];
  const children = context.zonesByParent.get(zoneId) || [];
  const inners = new Map(
    children.map((child) => [child.id, layoutGroup(child.id, context)]),
  );

  // One item per loose node and one per boundary, each with a size: to the
  // layering a boundary is just a large box.
  const items = [
    ...own.map((node) => ({ id: node.id })),
    ...children.map((child) => ({ id: zoneItem(child.id) })),
  ];
  const sizes = new Map();
  for (const node of own) sizes.set(node.id, context.sizes.get(node.id));
  for (const child of children) {
    const inner = inners.get(child.id);
    sizes.set(zoneItem(child.id), {
      width: inner.width + ZONE_MARGIN,
      height: inner.height + ZONE_MARGIN,
    });
  }

  // Which item in this group each node belongs to: itself if it is loose here,
  // otherwise the boundary of this group that holds it, however deep it sits.
  const itemFor = new Map(own.map((node) => [node.id, node.id]));
  for (const child of children)
    for (const id of context.nodesUnder.get(child.id) || [])
      itemFor.set(id, zoneItem(child.id));
  const edges = [];
  for (const edge of context.edges) {
    const from = itemFor.get(edge.from);
    const to = itemFor.get(edge.to);
    if (from && to && from !== to) edges.push({ from, to });
  }

  // Lanes and bands are not laid out by the flow: they are a row of columns,
  // or a column of rows, in the order they were written, each stretched to the
  // same size across. The arrows cross between them, which is the shape.
  const ranked =
    zoneId === null && context.archetype !== "flow"
      ? rankedGroup(own, children, sizes, context)
      : null;
  const block = ranked || layoutNodes(items, edges, context.down, sizes);
  const boxes = new Map();
  const rects = [];
  for (const node of own) boxes.set(node.id, block.boxes.get(node.id));
  for (const child of children) {
    const slot = block.boxes.get(zoneItem(child.id));
    const inner = inners.get(child.id);
    const dx = snap(slot.x + ZONE_MARGIN / 2);
    const dy = snap(slot.y + ZONE_MARGIN / 2);
    for (const [id, box] of inner.boxes)
      boxes.set(id, { ...box, x: box.x + dx, y: box.y + dy });
    for (const rect of inner.rects)
      rects.push({ ...rect, x: rect.x + dx, y: rect.y + dy });
    rects.push({
      zone: child,
      x: dx,
      y: dy,
      // A lane stretched to the tallest draws at that height, not at the
      // height of what happens to be inside it.
      width: Math.max(inner.width, slot.width - ZONE_MARGIN),
      height: Math.max(inner.height, slot.height - ZONE_MARGIN),
    });
  }
  const { width, height } = bounds([
    ...boxes.values(),
    ...rects.map((rect) => ({ ...rect })),
  ]);
  if (zoneId === null) return { boxes, rects, width, height };
  // Inside a boundary everything moves in by the padding, and the boundary
  // itself is the content plus that padding on all four sides.
  for (const [id, box] of boxes)
    boxes.set(id, {
      ...box,
      x: box.x + ZONE_PADDING,
      y: box.y + ZONE_PADDING,
    });
  for (const rect of rects) {
    rect.x += ZONE_PADDING;
    rect.y += ZONE_PADDING;
  }
  return {
    boxes,
    rects,
    width: snap(width + ZONE_PADDING * 2),
    height: snap(height + ZONE_PADDING * 2),
  };
};

// Connections leave a box on one side and enter the next on the facing side,
// turning at right angles. A diagonal arrow is the fastest way to make a
// reference architecture look amateur.
const STUB = 20;
const LANE_GAP = 40;
// A line is treated as running through a box if it comes this close to it, so
// arrows do not graze a corner or crawl along an edge.
const CLEARANCE = 8;

// Right angles only, and never through a box that is not one of the two being
// joined. A diagram where one arrow crosses an unrelated tile is read as a
// mistake even when the structure behind it is right, so the path is chosen by
// trying the clean shapes in order and taking the first that touches nothing.
// A line straight from one box to the other, clipped to their edges. Right
// angles are the rule, but a fan-out from one box to a row of them is drawn
// with straight lines in every reference diagram there is, and forcing those
// into elbows is what makes a copy look nothing like the original.
const straightRoute = (from, to) => {
  const centre = (box) => ({
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  });
  const a = centre(from);
  const b = centre(to);
  const clip = (box, towards, away) => {
    const dx = towards.x - away.x;
    const dy = towards.y - away.y;
    if (dx === 0 && dy === 0) return { x: away.x, y: away.y };
    // How far along the line the box's own edge is reached.
    const steps = [];
    if (dx !== 0)
      steps.push(((dx > 0 ? box.width : -box.width) / 2) / dx);
    if (dy !== 0)
      steps.push(((dy > 0 ? box.height : -box.height) / 2) / dy);
    const step = Math.min(...steps.filter((value) => value > 0), 1);
    return { x: away.x + dx * step, y: away.y + dy * step };
  };
  const start = clip(from, b, a);
  const end = clip(to, a, b);
  return {
    start: { x: snap(start.x), y: snap(start.y) },
    points: [
      [0, 0],
      [snap(end.x) - snap(start.x), snap(end.y) - snap(start.y)],
    ],
  };
};

// Points that repeat add nothing and draw as a kink in the editor.
const tidy = (points) =>
  points.filter(
    (point, index) =>
      index === 0 ||
      point[0] !== points[index - 1][0] ||
      point[1] !== points[index - 1][1],
  );

const route = (from, to, obstacles = []) => {
  const sideways = to.x >= from.x + from.width || from.x >= to.x + to.width;
  const forward = sideways
    ? to.x >= from.x + from.width
    : to.y >= from.y + from.height;
  const start = sideways
    ? {
        x: forward ? from.x + from.width : from.x,
        y: snap(from.y + from.height / 2),
      }
    : {
        x: snap(from.x + from.width / 2),
        y: forward ? from.y + from.height : from.y,
      };
  const end = sideways
    ? { x: forward ? to.x : to.x + to.width, y: snap(to.y + to.height / 2) }
    : { x: snap(to.x + to.width / 2), y: forward ? to.y : to.y + to.height };
  // One piece of routing serves both directions: u runs along the flow and v
  // across it, so a sideways diagram and a downwards one are the same problem.
  const u = (point) => (sideways ? point.x : point.y);
  const v = (point) => (sideways ? point.y : point.x);
  const at = (alongU, acrossV) =>
    sideways ? [alongU, acrossV] : [acrossV, alongU];
  const du = u(end) - u(start);
  // Two boxes a few pixels out of line are meant to be in line. Stepping
  // sideways by less than one grid square to join them draws a wiggle nobody
  // asked for, so anything that close is treated as straight.
  const drift = v(end) - v(start);
  const dv = Math.abs(drift) <= GRID ? 0 : drift;
  const walls = obstacles.map((box) =>
    sideways
      ? { u: box.x, uSize: box.width, v: box.y, vSize: box.height }
      : { u: box.y, uSize: box.height, v: box.x, vSize: box.width },
  );
  const touches = (a, b, wall) =>
    Math.min(a[0], b[0]) - CLEARANCE < wall.u + wall.uSize &&
    Math.max(a[0], b[0]) + CLEARANCE > wall.u &&
    Math.min(a[1], b[1]) - CLEARANCE < wall.v + wall.vSize &&
    Math.max(a[1], b[1]) + CLEARANCE > wall.v;
  // Offsets are measured from the start, walls in absolute terms.
  const origin = [u(start), v(start)];
  const clean = (path) =>
    path.every((point, index) => {
      if (!index) return true;
      const a = [
        origin[0] + path[index - 1][0],
        origin[1] + path[index - 1][1],
      ];
      const b = [origin[0] + point[0], origin[1] + point[1]];
      return walls.every((wall) => !touches(a, b, wall));
    });
  const built = (path) => ({
    start,
    end,
    points: tidy(path.map(([a, b]) => at(a, b))),
  });

  const straight = [
    [0, 0],
    [du, 0],
  ];
  if (dv === 0 && clean(straight)) return built(straight);

  // A single sideways step, taken wherever it fits: the middle first, because
  // that is what a person would draw, then anywhere else along the run.
  const middle = snap(du / 2);
  const steps = [middle];
  for (
    let turn = Math.sign(du) * STUB;
    Math.abs(turn) < Math.abs(du) - STUB;
    turn += Math.sign(du) * GRID
  )
    if (snap(turn) !== middle) steps.push(snap(turn));
  for (const turn of steps) {
    const path = [
      [0, 0],
      [turn, 0],
      [turn, dv],
      [du, dv],
    ];
    if (clean(path)) return built(path);
  }

  // Nothing fits between the boxes, so the line leaves its box, runs in a lane
  // clear of everything in the way, and comes back in.
  const spanLow = Math.min(u(start), u(end));
  const spanHigh = Math.max(u(start), u(end));
  const inTheWay = walls.filter(
    (wall) => wall.u < spanHigh && wall.u + wall.uSize > spanLow,
  );
  const across = [
    v(start),
    v(end),
    ...inTheWay.flatMap((wall) => [wall.v, wall.v + wall.vSize]),
  ];
  const outU = du > 0 ? STUB : -STUB;
  for (const lane of [
    snap(Math.max(...across) + LANE_GAP),
    snap(Math.min(...across) - LANE_GAP),
  ].sort((a, b) => Math.abs(a - v(start)) - Math.abs(b - v(start)))) {
    const path = [
      [0, 0],
      [outU, 0],
      [outU, lane - v(start)],
      [du - outU, lane - v(start)],
      [du - outU, dv],
      [du, dv],
    ];
    if (clean(path)) return built(path);
  }
  return built([
    [0, 0],
    [middle, 0],
    [middle, dv],
    [du, dv],
  ]);
};

const plainText = (
  text,
  x,
  y,
  fontFamily,
  fontSize,
  strokeColor,
  align = "left",
) => {
  const size = measure(text, fontSize);
  return element("text", {
    text,
    originalText: text,
    fontSize,
    fontFamily,
    textAlign: align,
    verticalAlign: "top",
    containerId: null,
    strokeColor,
    x: snap(x),
    y: snap(y),
    width: size.width,
    height: size.height,
    lineHeight: LINE_HEIGHT,
    autoResize: true,
  });
};

export function buildDiagram(spec, icons = new Map(), warnings = []) {
  order = 0;
  const nodes = Array.isArray(spec?.nodes) ? spec.nodes : [];
  const edges = Array.isArray(spec?.edges) ? spec.edges : [];
  const zoneList = Array.isArray(spec?.zones) ? spec.zones : [];
  if (!nodes.length) fail(400, "Describe at least one node.");
  if (nodes.length > MAX_NODES)
    fail(400, `Up to ${MAX_NODES} nodes per drawing.`);
  const ids = new Set();
  for (const node of nodes) {
    if (!node?.id || typeof node.id !== "string")
      fail(400, "Every node needs an id.");
    if (ids.has(node.id)) fail(400, `Duplicate node id: ${node.id}`);
    ids.add(node.id);
    if (node.label && String(node.label).length > MAX_LABEL)
      fail(400, "Labels are limited to 160 characters.");
  }
  // An arrow may join two boundaries as well as two nodes: in a reference
  // diagram the line from a build account to a production one leaves the
  // region itself, not any box inside it.
  const zoneIds = new Set(
    (Array.isArray(spec?.zones) ? spec.zones : [])
      .filter((zone) => zone?.id)
      .map((zone) => String(zone.id)),
  );
  for (const edge of edges)
    if (
      !(ids.has(edge?.from) || zoneIds.has(edge?.from)) ||
      !(ids.has(edge?.to) || zoneIds.has(edge?.to))
    )
      fail(
        400,
        `Edge ${edge?.from} → ${edge?.to} names a node or boundary that does not exist.`,
      );

  const style = spec.style || {};
  const fontFamily =
    FONTS[
      String(style.font || "")
        .toLowerCase()
        .trim()
    ] || FONTS.inter;
  const palette =
    COLORS[String(style.color || "").toLowerCase()] || COLORS.blue;
  const sketchy = style.sketchy === true;
  // Three structures cover nearly every diagram in the set this style follows:
  // a flow along one direction, full-height lanes side by side, or full-width
  // bands stacked down the page. Lanes and bands fix the direction inside a
  // boundary, because that is the whole point of the shape.
  const asked = String(spec.layout || "right").toLowerCase();
  const archetype = ["lanes", "bands", "manual"].includes(asked)
    ? asked
    : "flow";
  // Inside a lane or a band the flow runs across the page; it is the rack of
  // lanes or bands itself that runs the other way. A lane's own nodes have no
  // arrows between them as a rule, so they come out as one column, which is
  // what a lane is.
  const down = archetype === "flow" ? asked.startsWith("down") : false;
  const manual = archetype === "manual";
  // Square corners unless asked otherwise. The rounded rectangle is the
  // editor's default; the diagrams this follows draw boxes with corners.
  const corners =
    String(style.corners || "").toLowerCase() === "round" ? { type: 3 } : null;
  const dark = String(style.theme || "").toLowerCase() === "dark";
  // In the dark diagrams a tile is an outline in its own colour, not a pastel
  // block: a pale fill on a dark canvas reads as a hole punched in the page.
  const ink = dark ? "#e9ecef" : "#1e1e1e";
  const muted = dark ? "#adb5bd" : "#757575";
  const paper = style.background || (dark ? "#121212" : "#ffffff");

  // ── boundaries ─────────────────────────────────────────────────────────────
  // The spec as it was written, kept beside the parsed boundary: a hand-placed
  // drawing reads its coordinates straight off it.
  const zoneSpec = new Map(
    zoneList.filter((zone) => zone?.id).map((zone) => [zone.id, zone]),
  );
  const zones = new Map();
  for (const zone of zoneList) {
    if (!zone?.id || zones.has(zone.id)) {
      warnings.push(
        `Boundary "${zone?.id}" has no id or repeats one; ignored.`,
      );
      continue;
    }
    const named = COLORS[String(zone.color || "").toLowerCase()];
    if (zone.color && !named)
      warnings.push(
        `Boundary "${zone.id}" asks for colour "${
          zone.color
        }", which is not one of: ${Object.keys(COLORS).join(
          ", ",
        )}. Drawn in its level's colour.`,
      );
    if (zone.label_at && !TAG_PLACES.includes(String(zone.label_at)))
      warnings.push(
        `Boundary "${zone.id}" asks for its name at "${
          zone.label_at
        }", which is not one of: ${TAG_PLACES.join(", ")}. Drawn top-left.`,
      );
    zones.set(zone.id, {
      id: zone.id,
      // An empty label is a decision, not an omission: an inner box in a
      // reference picture often carries no name at all.
      label: zone.label === undefined ? zone.id : String(zone.label),
      parent: zone.parent || null,
      level: Math.min(Math.max(Number(zone.level) || 0, 1), LEVELS.length) - 1,
      members: new Set((zone.nodes || []).map(String)),
      labelAt: String(zone.label_at || "top-left"),
      labelStyle: zone.label_style === "plain" ? "plain" : "pill",
      badgeArt: zone.badge ? icons.get(String(zone.badge)) || null : null,
      badgeAt: zone.badge_at === "top-left" ? "top-left" : "top-right",
      caption: zone.caption ? String(zone.caption) : null,
      strokeStyle: ["solid", "dashed", "dotted"].includes(
        String(zone.style || ""),
      )
        ? String(zone.style)
        : null,
      // A named colour tints the boundary and its pill together, so the two
      // never drift apart.
      colors: named
        ? { fill: named.fill, stroke: named.stroke, tag: named.fill, opacity: 30 }
        : null,
    });
  }
  for (const zone of zones.values())
    if (zone.parent && !zones.has(zone.parent)) {
      warnings.push(
        `Boundary "${zone.id}" names a parent "${zone.parent}" that does not exist; drawn at the top level.`,
      );
      zone.parent = null;
    }
  // A level nobody set is read off the depth of the nesting itself.
  const depthOf = (zone, seen = new Set()) => {
    if (!zone.parent || seen.has(zone.id)) return 0;
    seen.add(zone.id);
    return 1 + depthOf(zones.get(zone.parent), seen);
  };
  for (const zone of zones.values())
    if (!zoneList.find((z) => z.id === zone.id)?.level)
      zone.level = Math.min(depthOf(zone), LEVELS.length - 1);

  const zoneOf = new Map();
  for (const zone of zones.values())
    for (const member of zone.members)
      if (ids.has(member)) zoneOf.set(member, zone.id);
  for (const node of nodes) {
    if (!node.zone) continue;
    if (!zones.has(node.zone)) {
      warnings.push(
        `Node "${node.id}" names a boundary "${node.zone}" that does not exist; drawn outside any boundary.`,
      );
      continue;
    }
    zoneOf.set(node.id, node.zone);
  }

  // ── tiles ──────────────────────────────────────────────────────────────────
  const fills = new Set();
  const rolesUsed = new Map();
  const sizes = new Map(
    nodes.map((node) => {
      const art = node.icon ? icons.get(String(node.icon)) : null;
      const plain = String(node.shape || "") === "plain";
      // An empty label is a decision, not an omission: many logos carry their
      // own name, and repeating it under the picture is what makes a copy of
      // a reference diagram look wrong.
      const named = node.label === undefined ? node.id : String(node.label);
      const text = wrap(named, plain ? 20 : art ? 18 : 24);
      const size = measure(text, FONT_SIZE);
      if (plain)
        return [
          node.id,
          {
            text,
            art,
            plain: true,
            width: snap(Math.max(size.width, art ? ICON_PLAIN : 0) + PADDING),
            height: snap(
              (art ? ICON_PLAIN + PLAIN_GAP : 0) + size.height + PLAIN_GAP,
            ),
          },
        ];
      const width = art
        ? ICON_GAP + ICON + 16 + size.width + ICON_GAP
        : size.width + PADDING * 2;
      return [
        node.id,
        {
          text,
          art,
          width: snap(Math.max(MIN_WIDTH, width)),
          height: snap(Math.max(MIN_HEIGHT, size.height + PADDING)),
        },
      ];
    }),
  );

  const context = {
    edges,
    down,
    sizes,
    nodesByZone: new Map(),
    zonesByParent: new Map(),
    nodesUnder: new Map(),
    archetype,
  };
  for (const node of nodes) {
    const key = zoneOf.get(node.id) || null;
    if (!context.nodesByZone.has(key)) context.nodesByZone.set(key, []);
    context.nodesByZone.get(key).push(node);
  }
  for (const zone of zones.values()) {
    const key = zone.parent || null;
    if (!context.zonesByParent.has(key)) context.zonesByParent.set(key, []);
    context.zonesByParent.get(key).push(zone);
  }
  // Every node a boundary holds, however deep. The layering of a boundary's
  // parent needs it to tell whether an arrow leads into that boundary.
  for (const node of nodes) {
    let key = zoneOf.get(node.id) || null;
    const seen = new Set();
    while (key && !seen.has(key)) {
      seen.add(key);
      if (!context.nodesUnder.has(key)) context.nodesUnder.set(key, new Set());
      context.nodesUnder.get(key).add(node.id);
      key = zones.get(key)?.parent || null;
    }
  }

  // Placed by hand. A reference picture is not the output of a layout
  // algorithm, and asking an engine to guess its way back to one never ends
  // with the picture. When every box says where it goes, the engine stops
  // deciding and starts drawing: coordinates are in pixels, snapped to the
  // grid, so a drawing copied off a reference still lines up.
  const placed = (thing) => {
    const at = thing?.at;
    if (!at || typeof at !== "object") return null;
    const read = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
    const x = read(at.x);
    const y = read(at.y);
    if (x === null || y === null) return null;
    return { x: snap(x), y: snap(y), w: read(at.w), h: read(at.h) };
  };
  const layout = manual
    ? (() => {
        const boxes = new Map();
        for (const node of nodes) {
          const spot = placed(node);
          const size = sizes.get(node.id);
          if (!spot) {
            warnings.push(
              `Node "${node.id}" has no at: {x, y} and the drawing is placed by hand; it was put at the origin.`,
            );
          }
          boxes.set(node.id, {
            x: spot?.x ?? 0,
            y: spot?.y ?? 0,
            width: snap(spot?.w ?? size.width),
            height: snap(spot?.h ?? size.height),
          });
        }
        // Outermost boundaries first, so a nested one draws on top of the one
        // holding it.
        const rects = [...zones.values()]
          .map((zone) => ({ zone, spot: placed(zoneSpec.get(zone.id)) }))
          .filter(({ zone, spot }) => {
            if (spot) return true;
            warnings.push(
              `Boundary "${zone.id}" has no at: {x, y, w, h} and the drawing is placed by hand; it was left out.`,
            );
            return false;
          })
          .sort((a, b) => a.zone.level - b.zone.level)
          .map(({ zone, spot }) => ({
            zone,
            x: spot.x,
            y: spot.y,
            width: snap(spot.w ?? 200),
            height: snap(spot.h ?? 200),
          }));
        return { boxes, rects, width: 0, height: 0 };
      })()
    : layoutGroup(null, context);
  const boxes = new Map();
  const elements = [];
  const files = {};
  // Things a step badge must not cover: tiles and the names of boundaries.
  const keepClear = [];

  // An image travels with the drawing as a data URL, named by its contents so
  // the same picture used twice is stored once.
  const stash = (art) => {
    const fileId = crypto
      .createHash("sha256")
      .update(art.dataURL)
      .digest("hex")
      .slice(0, 40);
    files[fileId] = {
      id: fileId,
      mimeType: art.mime,
      dataURL: art.dataURL,
      created: Date.now(),
      lastRetrieved: Date.now(),
    };
    return fileId;
  };

  // Boundaries are drawn first so every tile sits on top of the one holding it.
  const zoneBoxes = new Map();
  for (const rect of layout.rects) {
    zoneBoxes.set(rect.zone.id, {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    });
    const level = LEVELS[rect.zone.level] || LEVELS[0];
    const paint = rect.zone.colors || level;
    const container = element("rectangle", {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      backgroundColor: paint.fill,
      fillStyle: "solid",
      opacity: paint.opacity ?? level.opacity,
      strokeColor: paint.stroke,
      strokeWidth: level.strokeWidth,
      strokeStyle: rect.zone.strokeStyle || level.strokeStyle || "solid",
      roughness: 0,
      roundness: corners,
    });
    elements.push(container);
    // The name is a pill sitting on the top edge, tucked into whichever corner
    // was asked for. It straddles the line on purpose: that is what makes the
    // boundary read as a named region rather than a box with a caption in it.
    // A badge on the corner, the way a cloud provider's mark sits on the edge
    // of its own region in a reference diagram.
    if (rect.zone.badgeArt) {
      const side = rect.zone.badgeAt === "top-left" ? rect.x : rect.x + rect.width - BADGE_ART;
      elements.push(
        element("image", {
          fileId: stash(rect.zone.badgeArt),
          ...fitArt(
            {
              x: snap(side - BADGE_ART / 4),
              y: snap(rect.y - BADGE_ART / 2),
              width: BADGE_ART,
              height: BADGE_ART,
            },
            rect.zone.badgeArt.aspect,
          ),
          status: "saved",
          scale: [1, 1],
          crop: null,
          strokeColor: "transparent",
          backgroundColor: "transparent",
          roundness: null,
        }),
      );
    }
    const text = String(rect.zone.label || "").slice(0, MAX_LABEL);
    // Some diagrams name a region in plain words centred over it rather than
    // in a pill. Both are in the house set; the drawing says which.
    if (text && rect.zone.labelStyle === "plain") {
      const measured = measure(text, ZONE_LABEL_SIZE);
      const where = TAG_PLACES.includes(rect.zone.labelAt)
        ? rect.zone.labelAt
        : "top-center";
      const name = plainText(
        text,
        where === "top-left"
          ? snap(rect.x + TAG_INSET)
          : where === "top-right"
          ? snap(rect.x + rect.width - TAG_INSET - measured.width)
          : snap(rect.x + (rect.width - measured.width) / 2),
        snap(rect.y + 12),
        fontFamily,
        ZONE_LABEL_SIZE,
        // In its own colour when the boundary has one, the way these diagrams
        // letter a region's name: the words and the border say the same thing.
        rect.zone.colors ? paint.stroke : ink,
      );
      keepClear.push(name);
      elements.push(name);
    } else if (text) {
      const measured = measure(text, ZONE_LABEL_SIZE);
      const width = snap(measured.width + TAG_PADDING * 2);
      const place = TAG_PLACES.includes(rect.zone.labelAt)
        ? rect.zone.labelAt
        : "top-left";
      const left =
        place === "top-center"
          ? snap(rect.x + (rect.width - width) / 2)
          : place === "top-right"
          ? snap(rect.x + rect.width - TAG_INSET - width)
          : snap(rect.x + TAG_INSET);
      const tag = element("rectangle", {
        x: left,
        y: snap(rect.y - TAG_HEIGHT / 2),
        width,
        height: TAG_HEIGHT,
        backgroundColor: paint.tag || level.tag,
        fillStyle: "solid",
        strokeColor: paint.stroke,
        strokeWidth: 1,
        roughness: 0,
        roundness: { type: 3 },
      });
      const name = label(text, tag, fontFamily, ink, ZONE_LABEL_SIZE);
      tag.boundElements = [{ id: name.id, type: "text" }];
      // A boundary's own name is as unwelcome under a step badge as a tile is.
      keepClear.push(tag);
      elements.push(tag, name);
    }
    if (rect.zone.caption) {
      const caption = plainText(
        String(rect.zone.caption).slice(0, MAX_LABEL),
        rect.x + TAG_INSET,
        rect.y + rect.height + 12,
        fontFamily,
        SMALL_SIZE,
        muted,
      );
      keepClear.push(caption);
      elements.push(caption);
    }
  }

  for (const node of nodes) {
    const placed = layout.boxes.get(node.id);
    const size = sizes.get(node.id);
    const role = ROLES[String(node.role || "").toLowerCase()];
    if (node.role && !role)
      warnings.push(
        `Node "${node.id}" asks for role "${
          node.role
        }", which is not one of: ${Object.keys(ROLES).join(
          ", ",
        )}. Drawn in the default colour.`,
      );
    if (role) rolesUsed.set(String(node.role).toLowerCase(), role);
    const colors =
      role || COLORS[String(node.color || "").toLowerCase()] || palette;
    const shape = SHAPES.includes(node.shape) ? node.shape : "rectangle";
    // No box at all: the picture is the node and its name sits underneath.
    // Nothing is drawn to bind an arrow to, so the geometry alone is kept —
    // routed arrows are already unbound, and these are routed the same way.
    if (size.plain) {
      // The name may sit outside the picture, and then the picture alone is
      // what an arrow points at: in a reference diagram an arrow lands on the
      // box, never on the words beside it.
      const outside = LABEL_PLACES.includes(node.label_at)
        ? node.label_at
        : "below";
      const art = size.art
        ? {
            // Hand-placed: the box that was given is the picture. Laid out:
            // the picture sits at the top of the space the words share.
            width: manual ? placed.width : ICON_PLAIN,
            height: manual ? placed.height : ICON_PLAIN,
          }
        : null;
      const area = art
        ? {
            x: snap(placed.x + (placed.width - art.width) / 2),
            y: placed.y,
            width: art.width,
            height: art.height,
          }
        : {
            x: placed.x,
            y: placed.y,
            width: placed.width,
            height: placed.height,
          };
      boxes.set(node.id, area);
      keepClear.push(area);
      const measured = measure(size.text, FONT_SIZE);
      if (size.art)
        elements.push(
          element("image", {
            fileId: stash(size.art),
            ...fitArt(area, size.art.aspect),
            status: "saved",
            scale: [1, 1],
            crop: null,
            strokeColor: "transparent",
            backgroundColor: "transparent",
            roundness: null,
          }),
        );
      const spot = size.art
        ? besideBox(area, measured, outside === "inside" ? "below" : outside)
        : {
            x: snap(area.x + (area.width - measured.width) / 2),
            y: area.y,
          };
      if (size.text.trim())
        elements.push(
          plainText(
            size.text,
            spot.x,
            spot.y,
            fontFamily,
            FONT_SIZE,
            // A product's name takes the colour of what it is, the way these
            // diagrams letter a component in its own hue.
            node.role || node.color ? colors.stroke : ink,
          ),
        );
      continue;
    }
    // On a dark canvas a tile is an outline in its own colour: a pastel block
    // there reads as a hole punched in the page, which is why the dark
    // diagrams in the house set are drawn as outlines.
    const fill = node.fill || (dark ? "transparent" : colors.fill);
    fills.add(fill);
    const box = element(shape, {
      x: placed.x,
      y: placed.y,
      width: placed.width,
      height: placed.height,
      strokeColor: node.stroke || colors.stroke,
      backgroundColor: fill,
      strokeWidth: 1,
      roughness: sketchy ? 1 : 0,
      roundness: shape === "rectangle" ? corners : null,
    });
    boxes.set(node.id, box);
    keepClear.push(box);
    elements.push(box);
    if (size.art) {
      // The icon sits in from the left edge and the label beside it, the way a
      // reference architecture names a product.
      const fileId = stash(size.art);
      elements.push(
        element("image", {
          fileId,
          ...fitArt(
            {
              x: box.x + ICON_GAP,
              y: snap(box.y + (box.height - ICON) / 2),
              width: ICON,
              height: ICON,
            },
            size.art.aspect,
          ),
          status: "saved",
          scale: [1, 1],
          crop: null,
          strokeColor: "transparent",
          backgroundColor: "transparent",
          roundness: null,
        }),
      );
      const size_ = measure(size.text, FONT_SIZE);
      elements.push(
        plainText(
          size.text,
          box.x + ICON_GAP + ICON + 16,
          box.y + (box.height - size_.height) / 2,
          fontFamily,
          FONT_SIZE,
          ink,
        ),
      );
    } else {
      const text = label(size.text, box, fontFamily, ink);
      box.boundElements = [{ id: text.id, type: "text" }];
      elements.push(text);
    }
  }

  // ── connections ────────────────────────────────────────────────────────────
  const badges = [];
  for (const edge of edges) {
    const from = boxes.get(edge.from) || zoneBoxes.get(edge.from);
    const to = boxes.get(edge.to) || zoneBoxes.get(edge.to);
    if (!from || !to) continue;
    const kind = EDGE_KINDS[String(edge.kind || "").toLowerCase()] || null;
    if (edge.kind && !kind)
      warnings.push(
        `Edge ${edge.from} → ${edge.to} asks for kind "${
          edge.kind
        }", which is not one of: ${Object.keys(EDGE_KINDS).join(
          ", ",
        )}. Drawn as a plain arrow.`,
      );
    // Every other box is something this arrow must go around.
    const path =
      edge.route === "straight"
        ? straightRoute(from, to)
        : route(
            from,
            to,
            // A line between two regions is allowed over the boxes inside
            // them; it is the regions it must not cut through. And when the
            // drawing was placed by hand, nothing is dodged at all: whoever
            // set the coordinates already decided what goes where, and an
            // engine taking a line the long way round to avoid a box is
            // exactly what makes a copy stop looking like the original.
            manual || zoneBoxes.has(edge.from) || zoneBoxes.has(edge.to)
              ? []
              : [...boxes.values()].filter(
                  (box) => box !== from && box !== to,
                ),
          );
    const stroke =
      edge.color ||
      (kind?.color ?? null) ||
      (kind ? from.strokeColor : "#1e1e1e");
    const arrow = element("arrow", {
      x: path.start.x,
      y: path.start.y,
      // The shape a routed line actually covers, not the gap between its ends:
      // a label bound to the arrow is placed inside this.
      width:
        Math.max(...path.points.map(([x]) => x)) -
        Math.min(...path.points.map(([x]) => x)),
      height:
        Math.max(...path.points.map(([, y]) => y)) -
        Math.min(...path.points.map(([, y]) => y)),
      points: path.points,
      strokeColor: stroke,
      strokeWidth: kind?.strokeWidth || 1,
      backgroundColor: "transparent",
      strokeStyle:
        edge.style === "dashed" ? "dashed" : kind?.strokeStyle || "solid",
      roughness: sketchy ? 1 : 0,
      // Square corners and a solid head. The open V and the rounded elbow are
      // the editor's defaults, not this house's: every diagram in the set
      // turns a line at a right angle and ends it in a filled triangle.
      roundness: null,
      startArrowhead: edge.kind === "bidirectional" ? "triangle" : null,
      endArrowhead: "triangle",
      elbowed: false,
      // A straight run can stay bound to its boxes; a routed one cannot, because
      // the editor would recompute it into a diagonal and undo the routing.
      startBinding:
        path.points.length === 2
          ? { elementId: from.id, focus: 0, gap: 8 }
          : null,
      endBinding:
        path.points.length === 2
          ? { elementId: to.id, focus: 0, gap: 8 }
          : null,
    });
    if (path.points.length === 2) {
      from.boundElements = [
        ...(from.boundElements || []),
        { id: arrow.id, type: "arrow" },
      ];
      to.boundElements = [
        ...(to.boundElements || []),
        { id: arrow.id, type: "arrow" },
      ];
    }
    elements.push(arrow);
    if (edge.label) {
      const text = label(
        wrap(edge.label, 18),
        {
          id: arrow.id,
          x: Math.min(path.start.x, path.end.x),
          y: Math.min(path.start.y, path.end.y),
          width: Math.abs(path.end.x - path.start.x),
          height: Math.abs(path.end.y - path.start.y),
        },
        fontFamily,
        stroke,
        SMALL_SIZE,
      );
      arrow.boundElements = [{ id: text.id, type: "text" }];
      elements.push(text);
    }
    if (edge.step !== undefined && edge.step !== null)
      badges.push({
        step: edge.step,
        // The whole line, so a number crowded out at one end can move along it.
        corners: path.points.map(([x, y]) => ({
          x: path.start.x + x,
          y: path.start.y + y,
        })),
      });
  }

  // Numbered steps, drawn clear of the line they belong to.
  badges.sort((a, b) => Number(a.step) - Number(b.step));
  // Text is measured by an average letter width, so a name can render a little
  // wider than it was counted. The gap a badge keeps covers that difference.
  const BADGE_GAP = 12;
  const unoccupied = (x, y) =>
    keepClear.every(
      (other) =>
        x >= other.x + other.width + BADGE_GAP ||
        x + BADGE + BADGE_GAP <= other.x ||
        y >= other.y + other.height + BADGE_GAP ||
        y + BADGE + BADGE_GAP <= other.y,
    );
  for (const badge of badges) {
    // Beside the line it belongs to, never on top of a tile or a boundary's
    // name. The places are tried from the start of the line outwards, because a
    // number that has drifted down the line no longer says which step it is.
    const spots = [];
    for (let at = 0; at < badge.corners.length - 1; at += 1) {
      const from = badge.corners[at];
      const to = badge.corners[at + 1];
      const sideways = from.y === to.y;
      for (const along of [0.15, 0.5, 0.85]) {
        const point = {
          x: from.x + (to.x - from.x) * along,
          y: from.y + (to.y - from.y) * along,
        };
        const sides = sideways
          ? [point.y - BADGE - 12, point.y + 12]
          : [point.x + 12, point.x - BADGE - 12];
        for (const across of sides)
          spots.push(
            sideways
              ? [point.x - BADGE / 2, across]
              : [across, point.y - BADGE / 2],
          );
      }
    }
    const [x, y] = spots.find(([across, down]) =>
      unoccupied(snap(across), snap(down)),
    ) ||
      spots[0] || [badge.corners[0].x, badge.corners[0].y];
    const circle = element("ellipse", {
      x: snap(x),
      y: snap(y),
      width: BADGE,
      height: BADGE,
      // Amber, not the solid black of an AWS reference diagram: that is what
      // these diagrams number their steps with, and it stays legible on a
      // pale tile as well as on the page.
      backgroundColor: "#ffd8a8",
      fillStyle: "solid",
      strokeColor: "#f08c00",
      strokeWidth: 1,
      roundness: null,
    });
    const text = label(
      String(badge.step),
      circle,
      fontFamily,
      "#1e1e1e",
      FONT_SIZE,
    );
    circle.boundElements = [{ id: text.id, type: "text" }];
    elements.push(circle, text);
  }

  if (fills.size > MAX_FILLS)
    warnings.push(
      `This drawing uses ${fills.size} fill colours. More than ${MAX_FILLS} and the colours stop meaning anything; give nodes a role instead.`,
    );

  // ── title, legend, brand ───────────────────────────────────────────────────
  const frame = bounds([
    ...layout.boxes.values(),
    ...layout.rects.map((rect) => ({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    })),
  ]);

  const wantsLegend =
    spec.legend === true || (spec.legend !== false && rolesUsed.size >= 5);
  let legendBottom = frame.height;
  if (wantsLegend && rolesUsed.size) {
    const x = snap(Math.max(0, frame.width - LEGEND_WIDTH));
    const y = snap(frame.height + ZONE_GAP);
    const height = snap(60 + LEGEND_ROW * rolesUsed.size);
    elements.push(
      element("rectangle", {
        x,
        y,
        width: LEGEND_WIDTH,
        height,
        backgroundColor: dark ? "#1e1e1e" : "#ffffff",
        fillStyle: "solid",
        strokeColor: muted,
        strokeWidth: 1,
        roundness: { type: 3 },
      }),
      element("rectangle", {
        x,
        y,
        width: LEGEND_WIDTH,
        height: 40,
        backgroundColor: "#fff3bf",
        fillStyle: "solid",
        strokeColor: "#757575",
        strokeWidth: 1,
        roundness: { type: 3 },
      }),
      plainText(
        "Key Components",
        x + 16,
        y + 12,
        fontFamily,
        ZONE_LABEL_SIZE,
        "#1e1e1e",
      ),
    );
    let row = y + 56;
    for (const [key, role] of rolesUsed) {
      elements.push(
        element("rectangle", {
          x: x + 16,
          y: snap(row),
          width: 20,
          height: 20,
          backgroundColor: role.fill,
          fillStyle: "solid",
          strokeColor: role.stroke,
          strokeWidth: 1,
          roughness: 0,
          roundness: null,
        }),
        plainText(
          `${role.name}  (${key})`,
          x + 48,
          row,
          fontFamily,
          SMALL_SIZE,
          ink,
        ),
      );
      row += LEGEND_ROW;
    }
    legendBottom = y + height;
  }

  // Four title treatments, read off the finished diagrams. Underlined is the
  // most common of them, so a drawing that says nothing gets that one.
  if (spec.title) {
    const text = String(spec.title).slice(0, MAX_LABEL);
    const size = measure(text, TITLE_SIZE);
    const wanted = String(style.title_style || "").toLowerCase();
    const treatment = TITLE_STYLES.includes(wanted) ? wanted : "underline";
    if (style.title_style && !TITLE_STYLES.includes(wanted))
      warnings.push(
        `The title style "${
          style.title_style
        }" is not one of: ${TITLE_STYLES.join(
          ", ",
        )}. Drawn with an underline.`,
      );
    const top = -(ZONE_GAP + 80);
    const left = snap((frame.width - size.width) / 2);
    if (treatment === "banner") {
      const banner = element("rectangle", {
        x: 0,
        y: top,
        width: snap(Math.max(400, size.width + 80)),
        height: 80,
        backgroundColor: "#ffc9c9",
        fillStyle: "solid",
        strokeColor: "#1e1e1e",
        strokeWidth: 1,
        roughness: 0,
        roundness: { type: 3 },
      });
      const bannerText = label(text, banner, fontFamily, "#1e1e1e", TITLE_SIZE);
      banner.boundElements = [{ id: bannerText.id, type: "text" }];
      elements.unshift(banner, bannerText);
    } else if (treatment === "highlight") {
      // The words sit in a filled block with no outline, the way a marker pen
      // leaves them.
      const block = element("rectangle", {
        x: snap(left - 16),
        y: snap(top + 8),
        width: snap(size.width + 32),
        height: snap(size.height + 16),
        backgroundColor: "#fff3bf",
        fillStyle: "solid",
        strokeColor: "transparent",
        strokeWidth: 1,
        roughness: 0,
        roundness: { type: 3 },
      });
      elements.unshift(
        block,
        plainText(text, left, top + 16, fontFamily, TITLE_SIZE, "#1e1e1e"),
      );
    } else if (treatment === "bar") {
      elements.unshift(
        element("rectangle", {
          x: snap(left - 32),
          y: snap(top + 8),
          width: 12,
          height: snap(size.height + 8),
          backgroundColor: "#f08c00",
          fillStyle: "solid",
          strokeColor: "#f08c00",
          strokeWidth: 1,
          roughness: 0,
          roundness: null,
        }),
        plainText(text, left, top + 12, fontFamily, TITLE_SIZE, ink),
      );
    } else {
      const head = plainText(
        text,
        left,
        top + 12,
        fontFamily,
        TITLE_SIZE,
        ink,
      );
      elements.unshift(head);
      if (treatment === "underline")
        elements.push(
          element("line", {
            x: snap(left - 20),
            y: snap(top + 16 + size.height + 10),
            width: snap(size.width + 40),
            height: 0,
            points: [
              [0, 0],
              [snap(size.width + 40), 0],
            ],
            strokeColor: ink,
            strokeWidth: 2,
            // The one rule drawn by hand: a ruled line under a hand-lettered
            // title reads as printed rather than drawn.
            roughness: 1,
            roundness: null,
          }),
        );
    }
  }

  if (style.brand)
    elements.push(
      plainText(
        String(style.brand).slice(0, 60),
        frame.width - 160,
        legendBottom + 40,
        fontFamily,
        SMALL_SIZE,
        muted,
      ),
    );

  // A hairline rounded frame around the whole page. Every finished diagram in
  // the house set has one; it is what makes the image read as a card rather
  // than a photograph of somebody's canvas. Drawn last and put first, so it
  // sits behind everything.
  if (style.frame !== false) {
    const edge = extent(elements);
    if (edge) {
      elements.unshift(
        element("rectangle", {
          x: snap(edge.left - PAGE_MARGIN),
          y: snap(edge.top - PAGE_MARGIN),
          width: snap(edge.right - edge.left + PAGE_MARGIN * 2),
          height: snap(edge.bottom - edge.top + PAGE_MARGIN * 2),
          backgroundColor: "transparent",
          strokeColor: dark ? "#495057" : "#ced4da",
          strokeWidth: 1,
          roughness: 0,
          roundness: { type: 3 },
        }),
      );
    }
  }

  return {
    type: "excalidraw",
    version: 2,
    source: "self-hosted",
    elements,
    appState: { viewBackgroundColor: paper },
    files,
  };
}

export const styleGuide = () => ({
  fonts: Object.keys(FONTS),
  colors: Object.keys(COLORS),
  roles: Object.fromEntries(
    Object.entries(ROLES).map(([key, role]) => [key, role.name]),
  ),
  shapes: [...SHAPES, "plain"],
  layouts: ["right", "down", "lanes", "bands", "manual"],
  structures: {
    flow: "right or down: boxes connected by arrows, laid out along the flow",
    lanes:
      "full-height columns side by side, one per tier, arrows crossing between them",
    bands:
      "full-width rows stacked down the page, one per topic, each with its own flow inside",
    manual:
      "nothing is placed for you: every node and boundary carries at: {x, y, w, h} in pixels. Use this to copy a picture exactly.",
  },
  node_label_places: LABEL_PLACES,
  edge_routes: ["orthogonal", "straight"],
  title_styles: TITLE_STYLES,
  themes: ["light", "dark"],
  boundary_label_places: TAG_PLACES,
  edge_styles: ["solid", "dashed"],
  edge_kinds: Object.keys(EDGE_KINDS),
  boundaries: {
    levels: LEVELS.length,
    note: "Nest boundaries with `zones`. Level 1 is the outermost (a cloud or platform), level 4 the innermost (a pod or process).",
  },
  grid: {
    unit: GRID,
    tile: `${MIN_WIDTH} x ${MIN_HEIGHT}`,
    note: "The server places everything on this grid; you do not send coordinates.",
  },
  how_to_make_it_read_well: [
    "Give every node a role rather than a colour. One role looks the same everywhere.",
    "Use zones for anything with an inside and an outside: a cloud, an account, a cluster, a node.",
    "Number the steps of a request with `step` on the edges, starting at 1.",
    "Say what a connection is with `kind`: sync, async, primary or bidirectional.",
    "Name a product on the nodes that are products: write what it is, and the picture is found here or fetched.",
    "Keep to six fill colours; past that the colours stop meaning anything.",
    "Draw a node with shape plain — a big icon and its name underneath, no box — unless the thing really is a container or a region. Most diagrams here are drawn that way.",
    "Name every boundary. The name is drawn in a pill on its top edge; label_at says which corner.",
    "Use layout lanes when the diagram is tiers side by side, and bands when it is one topic per row.",
    "Copying a picture somebody sent? Use layout manual and give every node and boundary at: {x, y, w, h} read off that picture, in pixels. Nothing is moved for you, so what you send is what is drawn.",
  ],
  limits: {
    nodes: MAX_NODES,
    label_characters: MAX_LABEL,
    fill_colours: MAX_FILLS,
  },
});
