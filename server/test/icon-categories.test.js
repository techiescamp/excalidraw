import test from "node:test";
import assert from "node:assert/strict";
import { installIcons } from "../lib/icons.js";

test("workspace icon list filters by category and returns category labels", async () => {
  const handlers = new Map();
  const app = {
    get(path, ...middleware) {
      handlers.set(path, middleware.at(-1));
    },
    post() {},
    put() {},
  };
  const rows = [
    {
      set_name: "logos",
      name: "helm",
      display_name: "Helm",
      category: "Kubernetes",
    },
    {
      set_name: "logos",
      name: "kubernetes",
      display_name: "Kubernetes Logo",
      category: "Kubernetes",
    },
  ];
  const allRows = [
    ...rows,
    {
      set_name: "logos",
      name: "postgresql",
      display_name: "PostgreSQL",
      category: "Databases",
    },
  ];
  const queries = [];
  const db = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes("SELECT DISTINCT category")) {
        return { rows: [{ category: "Databases" }, { category: "Kubernetes" }] };
      }
      return { rows: params[2] === "Kubernetes" ? rows : allRows };
    },
  };
  const permissions = [];
  installIcons(
    app,
    db,
    { read: async () => null },
    {
      auth() {},
      admin() {},
      recent() {},
      permit: async (_user, workspace, permission) => {
        permissions.push({ workspace, permission });
      },
    },
  );

  let response;
  await handlers.get("/api/workspaces/:workspace/icons")(
    {
      params: { workspace: "workspace-id" },
      query: { q: "", category: "Kubernetes", limit: "300" },
      user: { id: "member-id" },
    },
    { json: (value) => (response = value) },
  );

  assert.ok(
    queries.some(
      ({ sql, params }) =>
        sql.includes("category=$3") && params[2] === "Kubernetes",
    ),
  );
  assert.deepEqual(response.icons, rows);
  assert.deepEqual(response.categories, ["Databases", "Kubernetes"]);
  assert.deepEqual(permissions, [
    { workspace: "workspace-id", permission: "drawing.read" },
  ]);
});
