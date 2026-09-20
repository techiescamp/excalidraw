import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const MAX_TEXT = 4000;
const MAX_EXPORT_BYTES = 400 * 1024;
const WINDOW_MS = 60_000;
const MAX_CALLS = 120;

// Per-key request budget. Single process, so an in-memory window is enough.
const calls = new Map();
const withinBudget = (keyId) => {
  const now = Date.now();
  const seen = calls.get(keyId);
  if (!seen || now - seen.start > WINDOW_MS) {
    calls.set(keyId, { start: now, count: 1 });
    return true;
  }
  seen.count += 1;
  return seen.count <= MAX_CALLS;
};

const summarize = (scene, payload) => {
  const elements = (payload.elements || []).filter((e) => !e.isDeleted);
  const counts = {};
  const words = [];
  for (const element of elements) {
    counts[element.type] = (counts[element.type] || 0) + 1;
    if (typeof element.text === "string" && element.text.trim())
      words.push(element.text.trim());
  }
  const shape = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) => `${n} ${type}${n === 1 ? "" : "s"}`)
    .join(", ");
  const text = words.join("\n").slice(0, MAX_TEXT);
  return [
    `Drawing: ${scene.name}`,
    `Collections: ${
      scene.collections?.map((c) => c.name).join(", ") || "Private"
    }`,
    `Created by: ${scene.owner_name || "unknown"}`,
    `Last changed: ${new Date(scene.updated_at).toISOString()}`,
    `Contents: ${shape || "empty"}`,
    words.length ? `\nText in the drawing:\n${text}` : "",
  ]
    .filter(Boolean)
    .join("\n");
};

export function installMcp(app, db, drawings, keyHolder, origin) {
  const editorUrl = (id) => `${origin}/editor?scene=${id}`;
  const workspaceFor = async (context) => {
    if (context.workspaceId) return context.workspaceId;
    const { rows } = await db.query(
      `SELECT w.id FROM workspaces w LEFT JOIN workspace_members m ON m.workspace_id=w.id AND m.user_id=$1
       WHERE w.deleted_at IS NULL AND ($2 OR m.user_id IS NOT NULL) ORDER BY w.created_at LIMIT 1`,
      [context.user.id, context.user.is_superadmin],
    );
    if (!rows[0]) throw new Error("This key has no workspace to work in.");
    return rows[0].id;
  };
  const sceneRow = async (context, id) => {
    const workspace = await workspaceFor(context);
    const { items } = await drawings.listScenes(context.user, {
      workspace,
      limit: 100,
    });
    const known = items.find((s) => s.id === id);
    // sceneAccess re-checks permissions and reaches drawings outside the first page
    const { scene } = await drawings.sceneAccess(context.user, id);
    return {
      ...scene,
      collections: known?.collections || [],
      owner_name: known?.owner_name,
    };
  };

  const build = (context) => {
    const server = new McpServer({
      name: "excalidraw-workspace",
      version: "1.0.0",
    });
    server.registerTool(
      "search",
      {
        title: "Search drawings",
        description:
          "Find drawings in the workspace by words in their name. Returns links that open in the editor.",
        inputSchema: {
          query: z.string().describe("Words to look for in drawing names"),
          collection: z
            .string()
            .optional()
            .describe("Limit to one collection id"),
          limit: z.number().int().min(1).max(50).optional(),
        },
        outputSchema: {
          results: z.array(
            z.object({
              id: z.string(),
              title: z.string(),
              url: z.string(),
              collection: z.string(),
              owner: z.string(),
              updated_at: z.string(),
            }),
          ),
        },
      },
      async ({ query, collection, limit }) => {
        const workspace = await workspaceFor(context);
        const { items } = await drawings.listScenes(context.user, {
          workspace,
          collection,
          search: query,
          limit: limit || 20,
          sort: "updated",
        });
        const results = items.map((scene) => ({
          id: scene.id,
          title: scene.name,
          url: editorUrl(scene.id),
          collection:
            scene.collections?.map((c) => c.name).join(", ") || "Private",
          owner: scene.owner_name || "unknown",
          updated_at: new Date(scene.updated_at).toISOString(),
        }));
        return {
          content: [{ type: "text", text: JSON.stringify({ results }) }],
          structuredContent: { results },
        };
      },
    );
    server.registerTool(
      "fetch",
      {
        title: "Read a drawing",
        description:
          "Read one drawing: what it contains, who made it and all text inside it.",
        inputSchema: { id: z.string().describe("Drawing id from search") },
        outputSchema: {
          id: z.string(),
          title: z.string(),
          text: z.string(),
          url: z.string(),
          metadata: z.record(z.string()),
        },
      },
      async ({ id }) => {
        const scene = await sceneRow(context, id);
        const payload = await drawings.readScene(scene);
        const result = {
          id: scene.id,
          title: scene.name,
          text: summarize(scene, payload),
          url: editorUrl(scene.id),
          metadata: {
            version: String(scene.scene_version),
            elements: String(
              (payload.elements || []).filter((e) => !e.isDeleted).length,
            ),
            owner: scene.owner_name || "unknown",
          },
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      },
    );
    server.registerTool(
      "list_collections",
      {
        title: "List collections",
        description: "List the collections (folders) in the workspace.",
        inputSchema: {},
        outputSchema: {
          collections: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              drawings: z.number(),
            }),
          ),
        },
      },
      async () => {
        const workspace = await workspaceFor(context);
        const { rows } = await db.query(
          `SELECT c.id,c.name,count(cd.drawing_id)::int AS drawings FROM collections c
           LEFT JOIN collection_drawings cd ON cd.collection_id=c.id
           WHERE c.workspace_id=$1 AND c.deleted_at IS NULL AND (NOT c.is_private OR c.created_by=$2 OR $3)
           GROUP BY c.id ORDER BY c.position,c.created_at LIMIT 100`,
          [workspace, context.user.id, context.user.is_superadmin],
        );
        const collections = rows.map((r) => ({
          id: r.id,
          name: r.name,
          drawings: r.drawings,
        }));
        return {
          content: [{ type: "text", text: JSON.stringify({ collections }) }],
          structuredContent: { collections },
        };
      },
    );
    server.registerTool(
      "export_drawing",
      {
        title: "Export a drawing",
        description:
          "Get the full Excalidraw contents of one drawing, for copying or converting.",
        inputSchema: { id: z.string() },
      },
      async ({ id }) => {
        const scene = await sceneRow(context, id);
        const payload = await drawings.readScene(scene);
        const body = JSON.stringify(payload);
        if (body.length > MAX_EXPORT_BYTES)
          throw new Error(
            `This drawing is ${Math.round(
              body.length / 1024,
            )} KB, too large to export here. Open it at ${editorUrl(id)}.`,
          );
        return { content: [{ type: "text", text: body }] };
      },
    );
    return server;
  };

  app.all("/mcp", async (req, res) => {
    const header = req.get("authorization");
    const token =
      /^Bearer\s+(.+)$/i.exec(header || "")?.[1] || req.get("x-api-key");
    const context = await keyHolder(token);
    if (!context) {
      res.set(
        "WWW-Authenticate",
        `Bearer realm="excalidraw", error="invalid_token"`,
      );
      return res
        .status(401)
        .json({
          error: "A valid MCP key is required in the Authorization header.",
        });
    }
    if (!withinBudget(context.keyId))
      return res
        .status(429)
        .json({ error: "Too many requests for this key. Try again shortly." });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = build(context);
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
}
