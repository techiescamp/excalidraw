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
  { fill: "transparent", opacity: 100, stroke: "#757575", strokeWidth: 1 },
  { fill: "#dbe4ff", opacity: 25, stroke: "#4a9eed", strokeWidth: 1 },
  { fill: "#fff3bf", opacity: 40, stroke: "#f59e0b", strokeWidth: 1 },
  {
    fill: "#e5dbff",
    opacity: 45,
    stroke: "#8b5cf6",
    strokeWidth: 1,
    strokeStyle: "dashed",
  },
];

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

  const block = layoutNodes(items, edges, context.down, sizes);
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
      width: inner.width,
      height: inner.height,
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
  const dv = v(end) - v(start);
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
    points: path.map(([a, b]) => at(a, b)),
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
  for (const edge of edges)
    if (!ids.has(edge?.from) || !ids.has(edge?.to))
      fail(
        400,
        `Edge ${edge?.from} → ${edge?.to} names a node that does not exist.`,
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
  const down = String(spec.layout || "right").startsWith("down");

  // ── boundaries ─────────────────────────────────────────────────────────────
  const zones = new Map();
  for (const zone of zoneList) {
    if (!zone?.id || zones.has(zone.id)) {
      warnings.push(
        `Boundary "${zone?.id}" has no id or repeats one; ignored.`,
      );
      continue;
    }
    zones.set(zone.id, {
      id: zone.id,
      label: zone.label || zone.id,
      parent: zone.parent || null,
      level: Math.min(Math.max(Number(zone.level) || 0, 1), LEVELS.length) - 1,
      members: new Set((zone.nodes || []).map(String)),
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
      const text = wrap(node.label || node.id, art ? 18 : 24);
      const size = measure(text, FONT_SIZE);
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

  const layout = layoutGroup(null, context);
  const boxes = new Map();
  const elements = [];
  const files = {};
  // Things a step badge must not cover: tiles and the names of boundaries.
  const keepClear = [];

  // Boundaries are drawn first so every tile sits on top of the one holding it.
  for (const rect of layout.rects) {
    const level = LEVELS[rect.zone.level] || LEVELS[0];
    const container = element("rectangle", {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      backgroundColor: level.fill,
      fillStyle: "solid",
      opacity: level.opacity,
      strokeColor: level.stroke,
      strokeWidth: level.strokeWidth,
      strokeStyle: level.strokeStyle || "solid",
      roughness: 0,
      roundness: { type: 3 },
    });
    const name = plainText(
      rect.zone.label,
      rect.x + 16,
      rect.y + 12,
      fontFamily,
      ZONE_LABEL_SIZE,
      level.stroke,
    );
    // A boundary's own name is as unwelcome under a step badge as a tile is.
    keepClear.push(name);
    elements.push(container, name);
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
    const fill = node.fill || colors.fill;
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
      roundness: shape === "rectangle" ? { type: 3 } : null,
    });
    boxes.set(node.id, box);
    keepClear.push(box);
    elements.push(box);
    if (size.art) {
      // The icon sits in from the left edge and the label beside it, the way a
      // reference architecture names a product.
      const fileId = crypto
        .createHash("sha256")
        .update(size.art.dataURL)
        .digest("hex")
        .slice(0, 40);
      files[fileId] = {
        id: fileId,
        mimeType: size.art.mime,
        dataURL: size.art.dataURL,
        created: Date.now(),
        lastRetrieved: Date.now(),
      };
      elements.push(
        element("image", {
          fileId,
          x: box.x + ICON_GAP,
          y: snap(box.y + (box.height - ICON) / 2),
          width: ICON,
          height: ICON,
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
          "#1e1e1e",
        ),
      );
    } else {
      const text = label(size.text, box, fontFamily, "#1e1e1e");
      box.boundElements = [{ id: text.id, type: "text" }];
      elements.push(text);
    }
  }

  // ── connections ────────────────────────────────────────────────────────────
  const badges = [];
  for (const edge of edges) {
    const from = boxes.get(edge.from);
    const to = boxes.get(edge.to);
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
    const path = route(
      from,
      to,
      [...boxes.values()].filter((box) => box !== from && box !== to),
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
      roundness: { type: 2 },
      startArrowhead: edge.kind === "bidirectional" ? "arrow" : null,
      endArrowhead: "arrow",
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
      backgroundColor: "#1e1e1e",
      fillStyle: "solid",
      strokeColor: "#1e1e1e",
      strokeWidth: 1,
      roundness: null,
    });
    const text = label(
      String(badge.step),
      circle,
      fontFamily,
      "#ffffff",
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
        backgroundColor: "#ffffff",
        fillStyle: "solid",
        strokeColor: "#757575",
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
          "#1e1e1e",
        ),
      );
      row += LEGEND_ROW;
    }
    legendBottom = y + height;
  }

  if (spec.title) {
    const text = String(spec.title).slice(0, MAX_LABEL);
    const size = measure(text, TITLE_SIZE);
    const banner = element("rectangle", {
      x: 0,
      y: -(ZONE_GAP + 80),
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
  }

  if (style.brand)
    elements.push(
      plainText(
        String(style.brand).slice(0, 60),
        frame.width - 160,
        legendBottom + 40,
        fontFamily,
        SMALL_SIZE,
        "#757575",
      ),
    );

  return {
    type: "excalidraw",
    version: 2,
    source: "self-hosted",
    elements,
    appState: { viewBackgroundColor: style.background || "#ffffff" },
    files,
  };
}

export const styleGuide = () => ({
  fonts: Object.keys(FONTS),
  colors: Object.keys(COLORS),
  roles: Object.fromEntries(
    Object.entries(ROLES).map(([key, role]) => [key, role.name]),
  ),
  shapes: SHAPES,
  layouts: ["right", "down"],
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
  ],
  limits: {
    nodes: MAX_NODES,
    label_characters: MAX_LABEL,
    fill_colours: MAX_FILLS,
  },
});
