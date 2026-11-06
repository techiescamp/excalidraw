import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { COLORS, ROLES, buildDiagram, styleGuide } from "../lib/diagram.js";

// The engine is what decides whether a drawing reads as a blueprint or as a
// flowchart, so these check the rules that make the difference, not the shapes.

const spec = (overrides = {}) => ({
  title: "Request path",
  nodes: [
    { id: "user", label: "kubectl", role: "external" },
    { id: "api", label: "API Server", role: "control-plane", zone: "cluster" },
    { id: "etcd", label: "etcd", role: "storage", zone: "cluster" },
  ],
  edges: [
    { from: "user", to: "api", step: 1, kind: "sync", label: "HTTPS" },
    { from: "api", to: "etcd", step: 2, kind: "primary" },
  ],
  zones: [{ id: "cluster", label: "Kubernetes Cluster", level: 2 }],
  ...overrides,
});

const placed = (scene) =>
  scene.elements.filter((element) => !element.containerId);

describe("blueprint diagrams", () => {
  it("places everything it positions on the 20px grid", () => {
    const scene = buildDiagram(spec());
    for (const element of placed(scene)) {
      assert.ok(element.x % 20 === 0, `${element.type} x=${element.x}`);
      assert.ok(element.y % 20 === 0, `${element.type} y=${element.y}`);
    }
  });

  it("turns arrows at right angles and never runs one diagonally", () => {
    const scene = buildDiagram(spec({ layout: "down" }));
    const arrows = scene.elements.filter((e) => e.type === "arrow");
    assert.ok(arrows.length >= 2);
    for (const arrow of arrows)
      arrow.points.forEach(([x, y], at) => {
        if (!at) return;
        const [previousX, previousY] = arrow.points[at - 1];
        assert.ok(
          x === previousX || y === previousY,
          `segment ${at} of an arrow runs diagonally`,
        );
      });
  });

  it("never runs an arrow through a box it does not belong to", () => {
    // A row of boxes with a line that has to get from one end to the other:
    // the straight path across is exactly the one that would cut through the
    // three boxes in between.
    const scene = buildDiagram({
      title: "Long hop",
      nodes: [
        { id: "a", label: "Ingress", role: "gateway" },
        { id: "b", label: "Event Bus", role: "data-plane" },
        { id: "c", label: "Order API", role: "data-plane" },
        { id: "d", label: "Orders DB", role: "storage" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "c", to: "d" },
        { from: "a", to: "d", label: "health check" },
      ],
    });
    const boxes = scene.elements.filter(
      (element) => element.type === "rectangle" && element.width <= 400,
    );
    const arrows = scene.elements.filter((e) => e.type === "arrow");
    assert.equal(arrows.length, 4);
    for (const arrow of arrows) {
      // The two boxes this arrow joins are the ones it starts and ends on.
      const ends = arrow.points.map(([x, y]) => [arrow.x + x, arrow.y + y]);
      const joined = boxes.filter((box) =>
        ends.some(
          ([x, y]) =>
            x >= box.x - 1 &&
            x <= box.x + box.width + 1 &&
            y >= box.y - 1 &&
            y <= box.y + box.height + 1,
        ),
      );
      for (let at = 1; at < ends.length; at += 1) {
        const [ax, ay] = ends[at - 1];
        const [bx, by] = ends[at];
        for (const box of boxes) {
          if (joined.includes(box)) continue;
          const crosses =
            Math.min(ax, bx) < box.x + box.width &&
            Math.max(ax, bx) > box.x &&
            Math.min(ay, by) < box.y + box.height &&
            Math.max(ay, by) > box.y;
          assert.ok(
            !crosses,
            `an arrow runs through the box at ${box.x},${box.y}`,
          );
        }
      }
    }
  });

  it("colours a node by its role, the same way every time", () => {
    const scene = buildDiagram(spec());
    const boxes = scene.elements.filter((e) => e.type === "rectangle");
    const storage = boxes.find(
      (box) => box.backgroundColor === ROLES.storage.fill,
    );
    assert.ok(storage, "the storage node is drawn in the storage colour");
    assert.equal(storage.strokeColor, ROLES.storage.stroke);
  });

  it("draws a boundary around the nodes inside it, with padding", () => {
    const scene = buildDiagram(spec());
    const cluster = scene.elements.find(
      (e) => e.type === "text" && e.text === "Kubernetes Cluster",
    );
    assert.ok(cluster, "the boundary carries its label");
    const boundary = scene.elements.find(
      (e) =>
        e.type === "rectangle" &&
        e.x <= cluster.x &&
        e.width >= 200 &&
        e.backgroundColor === "#dbe4ff",
    );
    assert.ok(boundary, "a level 2 boundary is drawn");
    // The name is a filled pill straddling the boundary's top edge, not text
    // dropped inside its corner: that is the house style this engine follows.
    const tag = scene.elements.find(
      (e) => e.id === cluster.containerId && e.type === "rectangle",
    );
    assert.ok(tag, "the name sits in a pill of its own");
    assert.ok(
      tag.y < boundary.y && tag.y + tag.height > boundary.y,
      "and the pill straddles the boundary's top edge",
    );
    assert.equal(tag.strokeColor, boundary.strokeColor);
    // A name pill is part of its boundary rather than something placed inside
    // it, and it is recognisable by starting above the boundary's top edge, so
    // the padding rule does not apply to it.
    const inside = scene.elements.filter(
      (e) =>
        e.type === "rectangle" &&
        e !== boundary &&
        e.y >= boundary.y &&
        e.x > boundary.x &&
        e.x + e.width < boundary.x + boundary.width,
    );
    assert.ok(inside.length >= 2, "both nodes sit inside the boundary");
    for (const box of inside) {
      assert.ok(box.x - boundary.x >= 40, "40px of padding on the left");
      assert.ok(
        boundary.x + boundary.width - (box.x + box.width) >= 40,
        "40px of padding on the right",
      );
    }
  });

  it("numbers the steps of a flow", () => {
    const scene = buildDiagram(spec());
    const badges = scene.elements.filter((e) => e.type === "ellipse");
    assert.equal(badges.length, 2);
    const numbers = scene.elements
      .filter((e) => badges.some((badge) => badge.id === e.containerId))
      .map((text) => text.text)
      .sort();
    assert.deepEqual(numbers, ["1", "2"]);
  });

  it("keeps a step number off the tiles and the boundary names", () => {
    // Boxes packed inside a boundary, so the first place a badge would like to
    // sit is already taken.
    const scene = buildDiagram({
      title: "Crowded",
      zones: [{ id: "cluster", label: "Kubernetes Cluster", level: 2 }],
      nodes: [
        { id: "lb", label: "Ingress", role: "gateway" },
        { id: "bus", label: "Event Bus", role: "data-plane", zone: "cluster" },
        { id: "api", label: "Order API", role: "data-plane", zone: "cluster" },
        { id: "db", label: "Orders DB", role: "storage", zone: "cluster" },
      ],
      edges: [
        { from: "lb", to: "api", step: 1 },
        { from: "api", to: "bus", step: 2 },
        { from: "api", to: "db", step: 3 },
        { from: "bus", to: "db", step: 4 },
      ],
    });
    const badges = scene.elements.filter((e) => e.type === "ellipse");
    assert.equal(badges.length, 4);
    const tiles = scene.elements.filter(
      (e) => e.type === "rectangle" && e.width <= 400 && e.strokeWidth === 2,
    );
    const names = scene.elements.filter(
      (e) => e.type === "text" && e.text === "Kubernetes Cluster",
    );
    for (const badge of badges)
      for (const other of [...tiles, ...names])
        assert.ok(
          badge.x >= other.x + other.width ||
            badge.x + badge.width <= other.x ||
            badge.y >= other.y + other.height ||
            badge.y + badge.height <= other.y,
          `step ${
            scene.elements.find((e) => e.containerId === badge.id)?.text
          } sits on top of something`,
        );
  });

  it("draws a key when the drawing is asked for one", () => {
    const scene = buildDiagram(spec({ legend: true }));
    const key = scene.elements.find(
      (e) => e.type === "text" && e.text === "Key Components",
    );
    assert.ok(key, "the legend has a header");
    const entries = scene.elements.filter(
      (e) => e.type === "text" && /\(control-plane\)|\(storage\)/.test(e.text),
    );
    assert.equal(entries.length, 2, "one row per role used");
  });

  it("leaves a plain description looking as it always did", () => {
    const scene = buildDiagram({
      nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
      edges: [{ from: "a", to: "b" }],
    });
    assert.equal(scene.elements.filter((e) => e.type === "ellipse").length, 0);
    const rectangles = scene.elements.filter((e) => e.type === "rectangle");
    assert.equal(
      rectangles.length,
      3,
      "two boxes, no boundary, and the page frame",
    );
    // The frame is drawn behind everything and holds the rest inside it.
    const [frame, ...boxes] = rectangles;
    assert.equal(frame.backgroundColor, "transparent");
    for (const box of boxes)
      assert.ok(
        frame.x < box.x &&
          frame.y < box.y &&
          frame.x + frame.width > box.x + box.width &&
          frame.y + frame.height > box.y + box.height,
        "every box is inside the page frame",
      );
  });

  it("sets lanes side by side and makes them all the same height", () => {
    const scene = buildDiagram({
      layout: "lanes",
      zones: [
        { id: "edge", label: "External", color: "red" },
        { id: "gw", label: "Gateway", color: "green" },
        { id: "data", label: "Data Layer", color: "violet" },
      ],
      nodes: [
        { id: "u", label: "Web Users", zone: "edge" },
        { id: "n", label: "Nginx", zone: "gw" },
        { id: "app", label: "App", zone: "gw" },
        { id: "db", label: "Postgres", zone: "data" },
      ],
      edges: [
        { from: "u", to: "n" },
        { from: "u", to: "app" },
        { from: "n", to: "db" },
      ],
    });
    const lanes = ["#ffc9c9", "#b2f2bb", "#d0bfff"].map((fill) =>
      scene.elements.find(
        (e) => e.type === "rectangle" && e.backgroundColor === fill,
      ),
    );
    assert.ok(lanes.every(Boolean), "one boundary per named colour");
    const heights = new Set(lanes.map((lane) => lane.height));
    assert.equal(heights.size, 1, "every lane is the height of the tallest");
    for (let at = 1; at < lanes.length; at += 1)
      assert.ok(
        lanes[at].x >= lanes[at - 1].x + lanes[at - 1].width,
        "lanes stand side by side in the order they were written",
      );
    // The middle lane holds two nodes with no arrow between them, and they
    // stack down it rather than across it: that is the point of a lane.
    const inside = scene.elements.filter(
      (e) =>
        e.type === "rectangle" &&
        e.backgroundColor !== "transparent" &&
        e.y > lanes[1].y &&
        e.x > lanes[1].x &&
        e.x + e.width < lanes[1].x + lanes[1].width,
    );
    assert.equal(inside.length, 2);
    assert.notEqual(inside[0].y, inside[1].y, "stacked down the lane");
  });

  it("stacks bands down the page at one width", () => {
    const scene = buildDiagram({
      layout: "bands",
      zones: [
        { id: "cri", label: "CRI", color: "blue", caption: "1. Pull  2. Run" },
        { id: "cni", label: "CNI", color: "green" },
      ],
      nodes: [
        { id: "k", label: "kubelet", zone: "cri" },
        { id: "r", label: "containerd", zone: "cri" },
        { id: "p", label: "CNI Plugin", zone: "cni" },
      ],
      edges: [{ from: "k", to: "r" }],
    });
    const bands = ["#a5d8ff", "#b2f2bb"].map((fill) =>
      scene.elements.find(
        (e) => e.type === "rectangle" && e.backgroundColor === fill,
      ),
    );
    assert.ok(bands.every(Boolean));
    assert.equal(bands[0].width, bands[1].width, "one width for every band");
    assert.ok(bands[1].y >= bands[0].y + bands[0].height, "stacked downwards");
    assert.ok(
      scene.elements.some(
        (e) => e.type === "text" && e.text === "1. Pull  2. Run",
      ),
      "a band carries its caption",
    );
  });

  it("draws a plain node as a picture with its name under it", () => {
    const art = new Map([
      [
        "k8s",
        { ref: "logos/k8s", mime: "image/svg+xml", dataURL: "data:image/svg+xml;base64,PHN2Zy8+" },
      ],
    ]);
    const scene = buildDiagram(
      {
        nodes: [
          { id: "a", label: "Kubernetes", shape: "plain", icon: "k8s", role: "control-plane" },
          { id: "b", label: "Boxed" },
        ],
        edges: [{ from: "a", to: "b" }],
      },
      art,
    );
    const image = scene.elements.find((e) => e.type === "image");
    assert.ok(image, "the picture is placed");
    const name = scene.elements.find(
      (e) => e.type === "text" && e.text === "Kubernetes",
    );
    assert.ok(name, "and the name with it");
    assert.equal(name.containerId, null, "the name is not bound to a box");
    assert.ok(name.y >= image.y + image.height, "the name sits under it");
    assert.equal(
      name.strokeColor,
      ROLES["control-plane"].stroke,
      "a product is lettered in the colour of what it is",
    );
    // No box: the only rectangles are the other node and the page frame.
    assert.equal(
      scene.elements.filter((e) => e.type === "rectangle").length,
      2,
    );
  });

  it("sets the title four ways and underlines it by default", () => {
    const underlined = buildDiagram({ title: "Hello", nodes: [{ id: "a" }] });
    assert.ok(
      underlined.elements.some((e) => e.type === "line"),
      "underlined unless told otherwise",
    );
    const highlight = buildDiagram({
      title: "Hello",
      style: { title_style: "highlight" },
      nodes: [{ id: "a" }],
    });
    assert.ok(
      highlight.elements.some(
        (e) => e.type === "rectangle" && e.backgroundColor === "#fff3bf",
      ),
      "a marker block behind the words",
    );
    const bar = buildDiagram({
      title: "Hello",
      style: { title_style: "bar" },
      nodes: [{ id: "a" }],
    });
    assert.ok(
      bar.elements.some(
        (e) =>
          e.type === "rectangle" &&
          e.backgroundColor === "#f08c00" &&
          e.width === 12,
      ),
      "a coloured bar beside the words",
    );
    const plain = buildDiagram({
      title: "Hello",
      style: { title_style: "plain" },
      nodes: [{ id: "a" }],
    });
    assert.equal(
      plain.elements.filter((e) => e.type === "line").length,
      0,
      "plain means plain",
    );
  });

  it("draws a dark page as outlines rather than pale blocks", () => {
    const scene = buildDiagram({
      style: { theme: "dark" },
      nodes: [{ id: "a", label: "API", role: "gateway" }],
    });
    assert.equal(scene.appState.viewBackgroundColor, "#121212");
    const box = scene.elements.find(
      (e) => e.type === "rectangle" && e.strokeColor === ROLES.gateway.stroke,
    );
    assert.ok(box, "the tile keeps its own colour");
    assert.equal(box.backgroundColor, "transparent", "drawn as an outline");
    const text = scene.elements.find((e) => e.type === "text");
    assert.equal(text.strokeColor, "#e9ecef", "lettered light on dark");
  });

  it("names a boundary in the corner that was asked for", () => {
    const scene = buildDiagram({
      zones: [
        {
          id: "k",
          label: "Kubernetes",
          label_at: "top-right",
          style: "dashed",
          color: "teal",
        },
      ],
      nodes: [
        { id: "a", label: "Pod", zone: "k" },
        { id: "b", label: "Another pod", zone: "k" },
      ],
      edges: [{ from: "a", to: "b" }],
    });
    const name = scene.elements.find(
      (e) => e.type === "text" && e.text === "Kubernetes",
    );
    const pill = scene.elements.find((e) => e.id === name.containerId);
    const boundary = scene.elements.find(
      (e) =>
        e.type === "rectangle" &&
        e.backgroundColor === COLORS.teal.fill &&
        e.height > pill.height * 2,
    );
    assert.equal(
      pill.backgroundColor,
      COLORS.teal.fill,
      "the pill is tinted with the boundary",
    );
    assert.equal(boundary.strokeStyle, "dashed");
    assert.ok(
      pill.x + pill.width <= boundary.x + boundary.width,
      "the pill stays inside the boundary's width",
    );
    assert.ok(
      pill.x > boundary.x + boundary.width / 2,
      "and sits in the right-hand corner, as asked",
    );
  });

  it("puts everything exactly where it was told to, when placed by hand", () => {
    const art = new Map([
      [
        "aws",
        {
          ref: "logos/aws",
          mime: "image/svg+xml",
          dataURL: "data:image/svg+xml;base64,PHN2Zy8+",
        },
      ],
    ]);
    const scene = buildDiagram(
      {
        layout: "manual",
        zones: [
          {
            id: "cloud",
            label: "www.example.com",
            label_style: "plain",
            color: "grey",
            badge: "aws",
            badge_at: "top-right",
            at: { x: 100, y: 60, w: 600, h: 400 },
          },
          { id: "inner", parent: "cloud", label: "", at: { x: 160, y: 140, w: 300, h: 200 } },
        ],
        nodes: [
          { id: "a", label: "Route 53", shape: "plain", icon: "aws", label_at: "left", at: { x: 200, y: 180, w: 60, h: 60 } },
          { id: "b", label: "", shape: "plain", icon: "aws", at: { x: 360, y: 180, w: 60, h: 60 } },
        ],
        edges: [{ from: "a", to: "b", route: "straight" }],
      },
      art,
    );
    const inner = scene.elements.find(
      (e) => e.type === "rectangle" && e.x === 160 && e.y === 140,
    );
    assert.ok(inner, "a boundary lands on the coordinates it was given");
    assert.equal(inner.width, 300);
    assert.equal(inner.height, 200);
    const picture = scene.elements.find(
      (e) => e.type === "image" && e.x === 200 && e.y === 180,
    );
    assert.ok(picture, "and so does a node's picture");
    assert.equal(picture.width, 60, "at the size it was given, not a default");
    // The name sits to the left of the picture, clear of it.
    const name = scene.elements.find(
      (e) => e.type === "text" && e.text === "Route 53",
    );
    assert.ok(name.x + name.width <= picture.x, "named on the left, as asked");
    // An empty label draws nothing: many logos carry their own name.
    assert.equal(
      scene.elements.filter((e) => e.type === "text").length,
      2,
      "the named node and the boundary, and nothing for the empty labels",
    );
    // The provider's mark sits on the boundary's top-right corner.
    const badge = scene.elements.find(
      (e) => e.type === "image" && e.x > 600 && e.y < 60,
    );
    assert.ok(badge, "the badge straddles the corner it was put on");
    // A straight edge is two points, not an elbow.
    const arrow = scene.elements.find((e) => e.type === "arrow");
    assert.equal(arrow.points.length, 2);
  });

  it("draws an arrow between two regions, not between boxes inside them", () => {
    const scene = buildDiagram({
      layout: "manual",
      zones: [
        { id: "left", label: "Build", at: { x: 0, y: 0, w: 200, h: 200 } },
        { id: "right", label: "Run", at: { x: 400, y: 0, w: 200, h: 200 } },
      ],
      nodes: [
        { id: "a", label: "A", zone: "left", at: { x: 40, y: 60 } },
        { id: "b", label: "B", zone: "right", at: { x: 440, y: 60 } },
      ],
      edges: [{ from: "left", to: "right" }],
    });
    const arrow = scene.elements.find((e) => e.type === "arrow");
    assert.ok(arrow, "the regions themselves are joined");
    assert.equal(arrow.x, 200, "it leaves the left region's edge");
    assert.equal(
      arrow.x + arrow.points[arrow.points.length - 1][0],
      400,
      "and lands on the right region's edge",
    );
  });

  it("says so when a hand-placed drawing leaves something unplaced", () => {
    const warnings = [];
    buildDiagram(
      {
        layout: "manual",
        zones: [{ id: "z", label: "Nowhere" }],
        nodes: [{ id: "a", label: "A" }],
      },
      new Map(),
      warnings,
    );
    assert.equal(warnings.length, 2);
    assert.match(warnings.join("\n"), /Node "a" has no at/);
    assert.match(warnings.join("\n"), /Boundary "z" has no at/);
  });

  it("draws boxes with corners and arrows with solid heads", () => {
    const scene = buildDiagram({
      nodes: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
      edges: [{ from: "a", to: "b" }],
    });
    const boxes = scene.elements.filter(
      (e) => e.type === "rectangle" && e.backgroundColor !== "transparent",
    );
    assert.ok(boxes.length >= 2);
    for (const box of boxes)
      assert.equal(box.roundness, null, "square corners, not the editor's round ones");
    const arrow = scene.elements.find((e) => e.type === "arrow");
    assert.equal(arrow.endArrowhead, "triangle", "a filled head, not an open V");
    assert.equal(arrow.roundness, null, "and square corners where it turns");
    // Asking for round corners still gets them.
    const round = buildDiagram({
      style: { corners: "round" },
      nodes: [{ id: "a", label: "A" }],
    });
    assert.ok(
      round.elements.some(
        (e) =>
          e.type === "rectangle" &&
          e.backgroundColor !== "transparent" &&
          e.roundness,
      ),
    );
  });

  it("runs a line straight between boxes that are nearly in line", () => {
    // Two boxes a few pixels out of line are meant to be in line. Stepping
    // sideways to join them draws a wiggle nobody asked for.
    const scene = buildDiagram({
      layout: "manual",
      nodes: [
        { id: "a", label: "A", at: { x: 100, y: 100, w: 100, h: 60 } },
        { id: "b", label: "B", at: { x: 110, y: 300, w: 100, h: 60 } },
      ],
      edges: [{ from: "a", to: "b" }],
    });
    const arrow = scene.elements.find((e) => e.type === "arrow");
    assert.equal(arrow.points.length, 2, "one straight run, not an elbow");
    assert.equal(arrow.points[1][0], 0, "and no sideways step");
  });

  it("keeps an icon the shape it was drawn at", () => {
    // A wordmark is three times as wide as it is tall. Dropped into a square
    // slot it must stay that shape and sit in the middle, not stretch.
    const art = new Map([
      [
        "wide",
        {
          ref: "logos/wide",
          mime: "image/svg+xml",
          aspect: 3,
          dataURL: "data:image/svg+xml;base64,PHN2Zy8+",
        },
      ],
    ]);
    const scene = buildDiagram(
      {
        layout: "manual",
        nodes: [
          { id: "a", label: "", shape: "plain", icon: "wide", at: { x: 100, y: 100, w: 120, h: 120 } },
        ],
      },
      art,
    );
    const picture = scene.elements.find((e) => e.type === "image");
    assert.equal(picture.width, 120, "as wide as the slot allows");
    assert.equal(picture.height, 40, "and the height its own shape asks for");
    assert.equal(picture.x, 100);
    assert.equal(picture.y, 140, "centred in the slot it was given");
  });

  it("draws the pieces that are not boxes", () => {
    const scene = buildDiagram({
      layout: "manual",
      nodes: [{ id: "a", label: "A", at: { x: 400, y: 400 } }],
      edges: [{ from: "why", to: "a", style: "dashed", route: "straight" }],
      extras: [
        {
          kind: "code",
          at: { x: 0, y: 0, w: 400 },
          lines: ["kind: Pod", "spec:", "  hostUsers: false"],
          highlight: [3],
        },
        {
          kind: "note",
          id: "why",
          at: { x: 700, y: 400, w: 320 },
          heading: "What this is",
          text: "A card the drawing hangs off a dashed line.",
          status: "ok",
        },
        {
          kind: "note",
          at: { x: 1200, y: 400, w: 900 },
          text: "A card the drawing hangs off a dashed line.",
        },
        {
          kind: "panel",
          at: { x: 700, y: 700, w: 300 },
          heading: "Key",
          rows: [{ chip: "green", label: "Starts" }, { label: "No chip" }],
        },
        { kind: "band", at: { x: 0, y: 1000, w: 600 }, text: "the footer line" },
        { kind: "divider", at: { x: 650, y: 0, h: 900 } },
        { kind: "measure", at: { x: 0, y: 900, w: 300 }, label: "30s" },
        { kind: "text", at: { x: 0, y: 940 }, text: "loose words", size: "small" },
      ],
    });
    const words = scene.elements
      .filter((e) => e.type === "text")
      .map((e) => e.text);
    assert.ok(words.includes("kind: Pod\nspec:\n  hostUsers: false"));
    assert.ok(words.includes("What this is"));
    assert.ok(words.includes("Key"));
    assert.ok(words.includes("the footer line"));
    assert.ok(words.includes("30s"));
    assert.ok(words.includes("loose words"));
    // The window has its three lights and a band behind the line picked out.
    assert.equal(
      scene.elements.filter((e) => e.type === "ellipse" && e.width === 16)
        .length,
      3,
    );
    assert.ok(
      scene.elements.some(
        (e) => e.type === "rectangle" && e.backgroundColor === "#6b5b3e",
      ),
      "the highlighted line is banded",
    );
    // The rule is a line, and the arrow from the note found the note.
    assert.ok(scene.elements.some((e) => e.type === "line" && e.height === 900));
    const arrow = scene.elements.find(
      (e) => e.type === "arrow" && e.strokeStyle === "dashed",
    );
    assert.ok(arrow, "an arrow can be pointed at a note by its id");
    // A card wraps to the width it was given: the same words in a wider card
    // come out on longer lines.
    const cards = scene.elements
      .filter((e) => e.type === "text" && e.text.startsWith("A card"))
      .map((e) =>
        e.text.split("\n").reduce((long, line) => Math.max(long, line.length), 0),
      );
    assert.equal(cards.length, 2);
    assert.ok(
      Math.max(...cards) > Math.min(...cards),
      "the wider card wraps to longer lines",
    );
  });

  it("sweeps a callout curve and lays out a grid of chips", () => {
    const scene = buildDiagram({
      layout: "manual",
      nodes: [
        { id: "a", label: "A", color: "grey", at: { x: 200, y: 600, w: 160, h: 80 } },
        { id: "b", label: "B", color: "grey", at: { x: 900, y: 200, w: 160, h: 80 } },
      ],
      edges: [{ from: "b", to: "a", route: "curved", color: "#f08c00" }],
      extras: [
        {
          kind: "grid",
          at: { x: 200, y: 900, w: 460 },
          heading: "What you version",
          columns: 2,
          chips: [
            { color: "blue", label: "Git" },
            { color: "green", label: "DVC / S3" },
            { color: "orange", label: "MLflow" },
            { color: "yellow", label: "Eval metrics" },
          ],
        },
      ],
    });
    const arrow = scene.elements.find((e) => e.type === "arrow");
    assert.equal(arrow.points.length, 3, "three points make the bow");
    assert.deepEqual(arrow.roundness, { type: 2 }, "and it is drawn curved");
    const middle = arrow.points[1];
    const end = arrow.points[2];
    assert.notEqual(
      middle[0] * 2,
      end[0],
      "the middle point is pushed off the straight line",
    );
    // Four chips, two across, inside one holder.
    const chips = scene.elements.filter(
      (e) =>
        e.type === "rectangle" &&
        [COLORS.blue.fill, COLORS.green.fill, COLORS.orange.fill, COLORS.yellow.fill].includes(
          e.backgroundColor,
        ),
    );
    assert.equal(chips.length, 4);
    const rows = new Set(chips.map((chip) => chip.y));
    assert.equal(rows.size, 2, "two rows of two");
    const columns = new Set(chips.map((chip) => chip.x));
    assert.equal(columns.size, 2);
    assert.ok(
      scene.elements.some(
        (e) => e.type === "text" && e.text === "What you version",
      ),
    );
  });

  it("joins boxes that share a band with a level line, not a slope", () => {
    // A note beside a picture points at it straight. A slope between their
    // middles reads as a mistake, and it is what a copy gets wrong first.
    const scene = buildDiagram({
      layout: "manual",
      nodes: [
        { id: "icon", label: "", at: { x: 220, y: 80, w: 180, h: 180 } },
        { id: "below", label: "", at: { x: 240, y: 600, w: 140, h: 140 } },
      ],
      edges: [
        { from: "note", to: "icon", route: "straight" },
        { from: "icon", to: "below", route: "straight" },
      ],
      extras: [
        {
          kind: "note",
          id: "note",
          at: { x: 600, y: 190, w: 400, h: 100 },
          text: "SSH into the server",
        },
      ],
    });
    const [across, down] = scene.elements.filter((e) => e.type === "arrow");
    assert.equal(across.points.length, 2);
    assert.equal(across.points[1][1], 0, "the line across is level");
    assert.equal(across.x, 600, "it leaves the note's left edge");
    assert.equal(
      across.x + across.points[1][0],
      400,
      "and lands on the picture's right edge",
    );
    assert.equal(down.points[1][0], 0, "the line down is plumb");
  });

  it("never lets one piece of writing land on another", () => {
    // Every heading, row and caption is placed from where the line above
    // actually landed. Working the next position out and snapping it
    // separately put headings on top of the first row under them.
    const scene = buildDiagram({
      layout: "manual",
      nodes: [{ id: "a", label: "A", at: { x: 0, y: 0 } }],
      extras: [
        {
          kind: "panel",
          at: { x: 400, y: 100, w: 480 },
          heading: "DAG Structure",
          rows: [
            { chip: "green", label: "A   Starts the workflow" },
            { chip: "blue", label: "B   Depends on A" },
          ],
        },
        {
          kind: "note",
          at: { x: 1000, y: 100, w: 420 },
          heading: "Why it matters",
          text: "A model is not one thing you version, it is three moving together.",
        },
      ],
    });
    const words = scene.elements.filter((e) => e.type === "text");
    const overlaps = (a, b) =>
      !(
        a.x + a.width <= b.x ||
        b.x + b.width <= a.x ||
        a.y + a.height <= b.y ||
        b.y + b.height <= a.y
      );
    const clashes = words.flatMap((a, index) =>
      words.slice(index + 1).filter((b) => overlaps(a, b)),
    );
    assert.deepEqual(clashes, []);
  });

  it("says what it could not do rather than silently dropping it", () => {
    const warnings = [];
    buildDiagram(
      {
        nodes: [
          { id: "a", label: "A", role: "nonsense" },
          { id: "b", label: "B", zone: "nowhere" },
        ],
        edges: [{ from: "a", to: "b", kind: "telepathy" }],
      },
      new Map(),
      warnings,
    );
    assert.equal(warnings.length, 3);
    assert.match(warnings.join("\n"), /role "nonsense"/);
    assert.match(warnings.join("\n"), /boundary "nowhere"/);
    assert.match(warnings.join("\n"), /kind "telepathy"/);
  });

  it("warns when the colours stop meaning anything", () => {
    const warnings = [];
    buildDiagram(
      {
        nodes: Object.keys(ROLES).map((role, at) => ({
          id: `n${at}`,
          label: role,
          role,
        })),
      },
      new Map(),
      warnings,
    );
    assert.match(warnings.join("\n"), /fill colours/);
  });

  it("tells an assistant what it may use", () => {
    const guide = styleGuide();
    assert.ok(guide.roles["control-plane"]);
    assert.equal(guide.grid.unit, 20);
    assert.ok(guide.edge_kinds.includes("primary"));
    assert.ok(guide.how_to_make_it_read_well.length >= 4);
  });
});
