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
