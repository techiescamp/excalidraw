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
