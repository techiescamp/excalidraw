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
const FONT_SIZE = 20;
const LINE_HEIGHT = 1.25;
const PADDING = 24;
const MIN_WIDTH = 160;
const MIN_HEIGHT = 80;
const GAP_ACROSS = 140;
const GAP_DOWN = 70;
const MAX_NODES = 120;
const MAX_LABEL = 160;

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
  strokeWidth: 2,
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

const label = (text, container, fontFamily, strokeColor) => {
  const size = measure(text);
  return element("text", {
    text,
    originalText: text,
    fontSize: FONT_SIZE,
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

export function buildDiagram(spec) {
  order = 0;
  const nodes = Array.isArray(spec?.nodes) ? spec.nodes : [];
  const edges = Array.isArray(spec?.edges) ? spec.edges : [];
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

  const columns = layerNodes(nodes, edges);
  const boxes = new Map();
  const elements = [];
  const sizes = new Map(
    nodes.map((node) => {
      const text = wrap(node.label || node.id);
      const size = measure(text);
      return [
        node.id,
        {
          text,
          width: Math.max(MIN_WIDTH, size.width + PADDING * 2),
          height: Math.max(MIN_HEIGHT, size.height + PADDING),
        },
      ];
    }),
  );
  const depths = [...columns.keys()].sort((a, b) => a - b);
  let across = 0;
  for (const depth of depths) {
    const column = columns.get(depth);
    const widest = Math.max(...column.map((n) => sizes.get(n.id).width));
    const tallest = Math.max(...column.map((n) => sizes.get(n.id).height));
    const span = column.reduce(
      (total, node) =>
        total + (down ? sizes.get(node.id).width : sizes.get(node.id).height),
      0,
    );
    let along = -(span + (column.length - 1) * GAP_DOWN) / 2;
    for (const node of column) {
      const size = sizes.get(node.id);
      const colors = COLORS[String(node.color || "").toLowerCase()] || palette;
      const shape = SHAPES.includes(node.shape) ? node.shape : "rectangle";
      const box = element(shape, {
        x: down ? along : across,
        y: down ? across : along,
        width: size.width,
        height: size.height,
        strokeColor: node.stroke || colors.stroke,
        backgroundColor: node.fill || colors.fill,
        roughness: sketchy ? 1 : 0,
        roundness: shape === "rectangle" ? { type: 3 } : null,
      });
      const text = label(size.text, box, fontFamily, "#1e1e1e");
      box.boundElements = [{ id: text.id, type: "text" }];
      boxes.set(node.id, box);
      elements.push(box, text);
      along += (down ? size.width : size.height) + GAP_DOWN;
    }
    across += (down ? tallest : widest) + GAP_ACROSS;
  }

  for (const edge of edges) {
    const from = boxes.get(edge.from),
      to = boxes.get(edge.to);
    const start = {
      x: from.x + from.width / (down ? 2 : 1),
      y: from.y + from.height / (down ? 1 : 2),
    };
    const end = {
      x: to.x + (down ? to.width / 2 : 0),
      y: to.y + (down ? 0 : to.height / 2),
    };
    const arrow = element("arrow", {
      x: start.x,
      y: start.y,
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y),
      points: [
        [0, 0],
        [end.x - start.x, end.y - start.y],
      ],
      strokeColor: edge.color || "#1e1e1e",
      backgroundColor: "transparent",
      strokeStyle: edge.style === "dashed" ? "dashed" : "solid",
      roughness: sketchy ? 1 : 0,
      roundness: { type: 2 },
      startArrowhead: null,
      endArrowhead: "arrow",
      startBinding: { elementId: from.id, focus: 0, gap: 8 },
      endBinding: { elementId: to.id, focus: 0, gap: 8 },
      elbowed: false,
    });
    from.boundElements = [
      ...(from.boundElements || []),
      { id: arrow.id, type: "arrow" },
    ];
    to.boundElements = [
      ...(to.boundElements || []),
      { id: arrow.id, type: "arrow" },
    ];
    elements.push(arrow);
    if (edge.label) {
      const text = label(
        wrap(edge.label, 18),
        {
          id: arrow.id,
          x: Math.min(start.x, end.x),
          y: Math.min(start.y, end.y),
          width: Math.abs(end.x - start.x),
          height: Math.abs(end.y - start.y),
        },
        fontFamily,
        edge.color || "#1e1e1e",
      );
      arrow.boundElements = [{ id: text.id, type: "text" }];
      elements.push(text);
    }
  }

  if (spec.title) {
    const text = String(spec.title).slice(0, MAX_LABEL);
    const size = measure(text, 28);
    elements.unshift(
      element("text", {
        text,
        originalText: text,
        fontSize: 28,
        fontFamily,
        textAlign: "left",
        verticalAlign: "top",
        x: 0,
        y: -(size.height + 60),
        width: size.width,
        height: size.height,
        lineHeight: LINE_HEIGHT,
        autoResize: true,
        containerId: null,
      }),
    );
  }

  return {
    type: "excalidraw",
    version: 2,
    source: "self-hosted",
    elements,
    appState: { viewBackgroundColor: style.background || "#ffffff" },
    files: {},
  };
}

export const styleGuide = () => ({
  fonts: Object.keys(FONTS),
  colors: Object.keys(COLORS),
  shapes: SHAPES,
  layouts: ["right", "down"],
  edge_styles: ["solid", "dashed"],
  limits: { nodes: MAX_NODES, label_characters: MAX_LABEL },
});
