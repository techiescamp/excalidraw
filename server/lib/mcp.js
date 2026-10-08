import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { transaction } from "./core.js";
import { buildDiagram, styleGuide } from "./diagram.js";

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

const nodeSchema = z.object({
  id: z.string().describe("Short name used by edges, e.g. api"),
  label: z.string().optional().describe("Words shown inside the shape"),
  shape: z.enum(["rectangle", "ellipse", "diamond"]).optional(),
  color: z
    .string()
    .optional()
    .describe("blue, green, red, orange, violet, teal, pink, grey, black"),
  fill: z.string().optional().describe("Exact background colour, e.g. #a5d8ff"),
  stroke: z.string().optional().describe("Exact outline colour, e.g. #1971c2"),
  icon: z
    .string()
    .optional()
    .describe("Icon drawn inside the box, as set/name, e.g. logos/kubernetes"),
});
const edgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  label: z.string().optional().describe("Words shown on the arrow"),
  style: z.enum(["solid", "dashed"]).optional(),
  color: z.string().optional(),
});
const specSchema = {
  title: z.string().optional().describe("Heading drawn above the diagram"),
  layout: z.enum(["right", "down"]).optional().describe("Flow direction"),
  style: z
    .object({
      font: z.string().optional().describe("Font name, e.g. Inter"),
      color: z.string().optional().describe("Default colour for shapes"),
      background: z.string().optional().describe("Canvas colour, e.g. #ffffff"),
      sketchy: z.boolean().optional().describe("Hand-drawn look"),
    })
    .optional(),
  nodes: z.array(nodeSchema).describe("The boxes"),
  edges: z.array(edgeSchema).optional().describe("Arrows between boxes"),
};

export function installMcp(
  app,
  db,
  drawings,
  keyHolder,
  origin,
  bearerHolder,
  icons,
) {
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

  // Icons named by the model are looked up (and fetched once, if the workspace
  // allows it) before the diagram is built.
  const artwork = async (workspace, spec) => {
    const found = new Map();
    if (!icons) return found;
    for (const node of spec?.nodes || []) {
      if (!node?.icon || found.has(node.icon)) continue;
      try {
        const art = await icons.iconData(workspace, node.icon);
        if (art) found.set(node.icon, art);
      } catch {
        // a missing icon never fails the drawing; the box is simply drawn plain
      }
    }
    return found;
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
    server.registerTool(
      "list_icons",
      {
        title: "List available icons",
        description:
          "Icons this workspace can draw with, named set/name. Use one in a node's icon field.",
        inputSchema: {
          search: z.string().optional().describe("Filter by words in the name"),
        },
        outputSchema: {
          icons: z.array(z.string()),
          fetching_allowed: z.boolean(),
        },
      },
      async ({ search }) => {
        const workspace = await workspaceFor(context);
        const { rows } = await db.query(
          `SELECT set_name||'/'||name AS ref FROM icons
           WHERE workspace_id=$1 AND ($2::text IS NULL OR name ILIKE '%'||$2||'%')
           ORDER BY set_name,name LIMIT 200`,
          [workspace, search || null],
        );
        const allowed = icons ? (await icons.settings()).fetch_enabled : false;
        const result = {
          icons: rows.map((row) => row.ref),
          fetching_allowed: Boolean(allowed),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      },
    );
    server.registerTool(
      "drawing_style_guide",
      {
        title: "Drawing options",
        description:
          "The fonts, colours, shapes and layouts this workspace can draw with. Read this before creating a drawing.",
        inputSchema: {},
      },
      async () => {
        const guide = styleGuide();
        return {
          content: [{ type: "text", text: JSON.stringify(guide, null, 1) }],
          structuredContent: guide,
        };
      },
    );
    if (context.scope === "write") {
      server.registerTool(
        "create_drawing",
        {
          title: "Create a drawing",
          description:
            "Draw a new diagram from a description. Say which boxes exist and what connects to what; positions are worked out here.",
          inputSchema: {
            name: z.string().describe("Name of the drawing"),
            collection: z
              .string()
              .optional()
              .describe("Collection id from list_collections"),
            ...specSchema,
          },
        },
        async ({ name, collection, ...spec }) => {
          const workspace = await workspaceFor(context);
          const payload = buildDiagram(spec, await artwork(workspace, spec));
          const scene = await transaction(db, (tx) =>
            drawings.create(
              {
                user: context.user,
                body: {
                  workspace_id: workspace,
                  name,
                  collection_id: collection || null,
                  private: !collection,
                },
              },
              tx,
              payload,
            ),
          );
          const result = {
            id: scene.id,
            name: scene.name,
            url: editorUrl(scene.id),
            elements: payload.elements.length,
          };
          return {
            content: [
              {
                type: "text",
                text: `Drew "${scene.name}" with ${result.elements} elements: ${result.url}`,
              },
            ],
            structuredContent: result,
          };
        },
      );
      server.registerTool(
        "update_drawing",
        {
          title: "Redraw a drawing",
          description:
            "Replace the contents of an existing drawing with a new diagram. The old version stays in its history.",
          inputSchema: { id: z.string().describe("Drawing id"), ...specSchema },
        },
        async ({ id, ...spec }) => {
          const scene = await sceneRow(context, id);
          const payload = buildDiagram(
            spec,
            await artwork(scene.workspace_id, spec),
          );
          const saved = await drawings.saveScene(
            context.user,
            scene.id,
            payload,
          );
          const result = {
            id: scene.id,
            version: saved.version,
            url: editorUrl(scene.id),
            elements: payload.elements.length,
          };
          return {
            content: [
              {
                type: "text",
                text: `Redrew "${scene.name}" (version ${saved.version}): ${result.url}`,
              },
            ],
            structuredContent: result,
          };
        },
      );
    }
    return server;
  };

  app.all("/mcp", async (req, res) => {
    const header = req.get("authorization");
    const token =
      /^Bearer\s+(.+)$/i.exec(header || "")?.[1] || req.get("x-api-key");
    const context =
      (await keyHolder(token)) ||
      (bearerHolder ? await bearerHolder(token) : null);
    if (!context) {
      // Clients discover the sign-in flow from this pointer (RFC 9728).
      res.set(
        "WWW-Authenticate",
        `Bearer realm="excalidraw", error="invalid_token", resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
      );
      return res.status(401).json({
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
