import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ROLES, buildDiagram, styleGuide } from "../lib/diagram.js";

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
        e.y <= cluster.y &&
        e.width >= 200 &&
        e.backgroundColor === "#dbe4ff",
    );
    assert.ok(boundary, "a level 2 boundary is drawn");
    const inside = scene.elements.filter(
      (e) =>
        e.type === "rectangle" &&
        e !== boundary &&
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
    assert.equal(
      scene.elements.filter((e) => e.type === "rectangle").length,
      2,
      "two boxes and no boundary",
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
