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
  role: z
    .string()
    .optional()
    .describe(
      "What this is, which decides its colour: control-plane, data-plane, storage, external, gateway, error, observability, neutral. Prefer this over picking a colour.",
    ),
  zone: z
    .string()
    .optional()
    .describe("Id of the boundary this sits inside, from zones"),
  shape: z.enum(["rectangle", "ellipse", "diamond"]).optional(),
  color: z
    .string()
    .optional()
    .describe(
      "Only when no role fits: blue, green, red, orange, violet, teal, pink, grey, black",
    ),
  fill: z.string().optional().describe("Exact background colour, e.g. #a5d8ff"),
  stroke: z.string().optional().describe("Exact outline colour, e.g. #1971c2"),
  icon: z
    .string()
    .optional()
    .describe(
      "Picture drawn inside the box. An exact name like logos/kubernetes, or plain words for what it is — database, message queue, load balancer — and the closest icon in the library is used.",
    ),
});
const edgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  label: z.string().optional().describe("Words shown on the arrow"),
  kind: z
    .enum(["sync", "async", "primary", "bidirectional"])
    .optional()
    .describe(
      "What the connection is: a request (sync), a watch or background flow (async), the main data path (primary), or both ways (bidirectional)",
    ),
  step: z
    .number()
    .int()
    .min(1)
    .max(99)
    .optional()
    .describe("Step number in a request flow; drawn as a badge on the arrow"),
  style: z.enum(["solid", "dashed"]).optional(),
  color: z.string().optional(),
});
const zoneSchema = z.object({
  id: z.string().describe("Short name used by nodes and by nested boundaries"),
  label: z.string().optional().describe("Words shown at the boundary's corner"),
  parent: z.string().optional().describe("Id of the boundary this sits inside"),
  level: z
    .number()
    .int()
    .min(1)
    .max(4)
    .optional()
    .describe(
      "1 is the outermost (a cloud or platform), 4 the innermost (a pod or process). Left out, it follows the nesting.",
    ),
  nodes: z
    .array(z.string())
    .optional()
    .describe(
      "Node ids inside this boundary; a node's own zone field does the same",
    ),
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
      brand: z
        .string()
        .optional()
        .describe("Small mark in the corner, e.g. a site or author name"),
    })
    .optional(),
  nodes: z.array(nodeSchema).describe("The boxes"),
  edges: z.array(edgeSchema).optional().describe("Arrows between boxes"),
  zones: z
    .array(zoneSchema)
    .optional()
    .describe(
      "Boundaries that hold nodes and other boundaries: a cloud, an account, a cluster, a node",
    ),
  legend: z
    .boolean()
    .optional()
    .describe(
      "Draw a key of the roles used. Left out, one appears when five or more roles are in the drawing.",
    ),
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
  const artwork = async (workspace, spec, warnings = []) => {
    const found = new Map();
    const missing = new Set();
    const swapped = [];
    const fetched = [];
    if (!icons) return found;
    for (const node of spec?.nodes || []) {
      if (!node?.icon || found.has(node.icon) || missing.has(node.icon))
        continue;
      try {
        // Plain words are accepted, not only exact names: a description asking
        // for "the queue" gets whichever picture in the library means that.
        const art = await icons.findIcon(workspace, node.icon, node.label);
        if (art) {
          found.set(node.icon, art);
          if (art.matched)
            (art.fetched ? fetched : swapped).push([node.icon, art.ref]);
        } else missing.add(node.icon);
      } catch {
        // a missing icon never fails the drawing; the box is simply drawn plain
        missing.add(node.icon);
      }
    }
    // An icon that was asked for and not found is the kind of thing an assistant
    // can fix on its next call, but only if it is told.
    for (const name of missing)
      warnings.push(
        `No icon could be found for "${name}", here or online. That box was drawn without one; list_icons searches the library by meaning.`,
      );
    // A substitution is not a fault, but the caller asked for one picture and
    // got another, so it is told which — it may know a better word to use.
    for (const [asked, used] of swapped)
      warnings.push(`Used ${used} for "${asked}".`);
    // Something the library did not have was found online and kept. Saying so
    // is how a reviewer learns a new icon arrived without anyone importing it.
    for (const [asked, used] of fetched)
      warnings.push(
        `No icon here meant "${asked}", so ${used} was found online and added to this workspace's library.`,
      );
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
        title: "Find icons",
        description:
          "Icons this workspace can draw with. Search in plain words — what the thing is, not what the file is called — and the closest icons come back best first: \"database\" finds postgresql, \"queue\" finds kafka. Put the answer in a node's icon field, or put the plain words there and the same search runs while drawing.",
        inputSchema: {
          search: z
            .string()
            .optional()
            .describe(
              "What you want a picture of, e.g. database, message queue, load balancer, user",
            ),
        },
        outputSchema: {
          icons: z.array(z.string()),
          matches: z
            .array(
              z.object({
                ref: z.string(),
                name: z.string(),
                category: z.string(),
              }),
            )
            .optional(),
          fetching_allowed: z.boolean(),
        },
      },
      async ({ search }) => {
        const workspace = await workspaceFor(context);
        const allowed = icons ? (await icons.settings()).fetch_enabled : false;
        // Without words, the library itself; with words, what they mean.
        const matches =
          search && icons ? await icons.matchIcons(workspace, search, 20) : [];
        if (search && icons) {
          const result = {
            icons: matches.map((match) => match.ref),
            matches: matches.map(({ ref, name, category }) => ({
              ref,
              name,
              category,
            })),
            fetching_allowed: Boolean(allowed),
          };
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          };
        }
        const { rows } = await db.query(
          `SELECT set_name||'/'||name AS ref FROM icons
           WHERE workspace_id=$1 OR shared
           ORDER BY set_name,name LIMIT 200`,
          [workspace],
        );
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
          "The roles, boundary levels, fonts, shapes, layouts and limits this workspace draws with, and the rules that make a diagram read well. Read this before creating a drawing.",
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
    // The house rules, where an assistant can pick them up without being told.
    // A tool description has to be short; this does not.
    server.registerPrompt(
      "diagram_rules",
      {
        title: "How to draw here",
        description:
          "The rules this workspace draws by, including how to turn a picture somebody sends you into a drawing.",
      },
      () => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                "Before drawing in this workspace, work out the structure, then describe it.",
                "",
                "1. Name the one thing the drawing explains. That is the title.",
                "2. Write the boundaries outermost first, for example: cloud > account > cluster > node. Send them as zones, and put each node in the zone that holds it.",
                "3. Give every node a role rather than a colour: control-plane, data-plane, storage, external, gateway, error, observability, neutral. One role always looks the same, which is what lets a reader learn the drawing in two seconds.",
                "4. Say what each connection is with kind: sync for a request, async for a watch or a background flow, primary for the main data path, bidirectional for both ways.",
                "5. If the drawing explains a request from start to finish, number the edges with step, beginning at 1, in the order they happen.",
                "6. Put an icon on every node that is a named product. Write what the thing is — postgres, message queue, load balancer, user — and the closest icon in this workspace's library is used; when the library has nothing named that and this workspace allows it, the icon is fetched from the icon source and kept. list_icons searches the same way if you want to see the choices first.",
                "7. Ask for a legend when the drawing uses five or more roles or introduces words the reader may not know.",
                "",
                "Positions, sizes, colours, arrow routes and the grid are decided by the server. Do not try to place anything yourself.",
                "",
                "When somebody gives you a picture and asks for one like it: read the picture and write down what it contains, then send that as the description. List the boundaries you can see, what sits inside each one, which way the arrows point, and what the numbers on them say. Name the roles from what each box is, not from the colour it happens to have in the picture. Name an icon for every box that is a product, using the words on the box. The result will be a clean redrawing of the same structure, not a copy of the image.",
                "",
                "Whoever asked may want a particular look. Pass it in style: font for the lettering (drawing_style_guide lists the fonts), background for the canvas, sketchy for the hand-drawn look, brand for a small mark in the corner. Leave these out and the workspace default is used; set them when you have been told what to use, and keep them the same across a set of drawings that belong together.",
                "",
                "Every create_drawing and update_drawing answers with any warnings. Read them: they say what could not be done, such as an icon this workspace does not have. Fix the description and call update_drawing on the same drawing rather than making a second one.",
              ].join("\n"),
            },
          },
        ],
      }),
    );
    if (context.scope === "write") {
      server.registerTool(
        "create_drawing",
        {
          title: "Create a drawing",
          description:
            "Draw a new diagram. Say which boxes exist, what connects to what, which boundary each box sits in, and what each box is (its role); every position, colour and arrow route is worked out here, on a grid. Read drawing_style_guide first for the roles and boundary levels.",
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
          const warnings = [];
          const payload = buildDiagram(
            spec,
            await artwork(workspace, spec, warnings),
            warnings,
          );
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
            warnings,
          };
          return {
            content: [
              {
                type: "text",
                text: [
                  `Drew "${scene.name}" with ${result.elements} elements: ${result.url}`,
                  ...warnings.map((warning) => `- ${warning}`),
                ].join("\n"),
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
            "Replace the contents of an existing drawing with a new diagram, using the same description as create_drawing. The old version stays in its history, so this is how you correct a drawing after looking at it.",
          inputSchema: { id: z.string().describe("Drawing id"), ...specSchema },
        },
        async ({ id, ...spec }) => {
          const scene = await sceneRow(context, id);
          const warnings = [];
          const payload = buildDiagram(
            spec,
            await artwork(scene.workspace_id, spec, warnings),
            warnings,
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
            warnings,
          };
          return {
            content: [
              {
                type: "text",
                text: [
                  `Redrew "${scene.name}" (version ${saved.version}): ${result.url}`,
                  ...warnings.map((warning) => `- ${warning}`),
                ].join("\n"),
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
