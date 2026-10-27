import crypto from "node:crypto";
import { fail, uuid, audit } from "./core.js";

// Icons live in the workspace's own library. Anything fetched from the internet
// is stored here on first use, so drawings never depend on a site staying up and
// the same icon is never downloaded twice.
const SOURCE = "https://api.iconify.design";
const MAX_BYTES = 256 * 1024;
const MAX_WORKSPACE_ICON_BYTES = 5 * 1024 * 1024;
const MAX_IMPORT = 40;
const MAX_CATEGORY_LENGTH = 40;
const MAX_DISPLAY_NAME_LENGTH = 80;
const WORKSPACE_ICON_MIMES = new Set([
  "image/svg+xml",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/x-icon",
  "image/avif",
  "image/jfif",
]);
const REF = /^[a-z0-9][a-z0-9_-]{0,59}\/[a-z0-9][a-z0-9._-]{0,79}$/i;
const TIMEOUT_MS = 8000;
// The icon source names things "set:name"; this library uses "set/name".
const normal = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(":", "/");
const categoryValue = (value) => {
  const category = String(value || "General").trim();
  if (!category || category.length > MAX_CATEGORY_LENGTH)
    fail(400, `Category must be 1–${MAX_CATEGORY_LENGTH} characters.`);
  return category;
};
const displayNameValue = (value) => {
  const displayName = String(value || "").trim();
  if (displayName.length > MAX_DISPLAY_NAME_LENGTH)
    fail(400, `Icon name must be ${MAX_DISPLAY_NAME_LENGTH} characters or less.`);
  return displayName || null;
};
const parseCanvasImage = (value) => {
  if (typeof value !== "string" || value.length > MAX_WORKSPACE_ICON_BYTES * 1.4) {
    fail(413, "Icons must be 5 MiB or smaller.");
  }
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/]+={0,2})$/i.exec(
    value,
  );
  if (!match) fail(400, "Choose a supported image from the canvas.");
  const mime = match[1].toLowerCase();
  if (!WORKSPACE_ICON_MIMES.has(mime)) {
    fail(415, "That image format is not supported for icons.");
  }
  const body = Buffer.from(match[2], "base64");
  if (
    !body.length ||
    body.length > MAX_WORKSPACE_ICON_BYTES ||
    body.toString("base64").replace(/=+$/, "") !== match[2].replace(/=+$/, "")
  ) {
    fail(400, "The image data is invalid.");
  }

  const startsWith = (...bytes) =>
    body.length >= bytes.length && bytes.every((byte, index) => body[index] === byte);
  const signatureMatches =
    mime === "image/svg+xml"
      ? (() => {
          const svg = body.toString("utf8");
          return (
            /<svg\b/i.test(svg) &&
            !/<\s*(?:script|foreignObject|!doctype|!entity)\b|\bon[a-z]+\s*=|javascript:|(?:href|xlink:href)\s*=\s*["'](?!#)|url\s*\(\s*["']?(?!#)/i.test(
              svg,
            )
          );
        })()
      : mime === "image/png"
      ? startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
      : mime === "image/jpeg" || mime === "image/jfif"
      ? startsWith(0xff, 0xd8, 0xff)
      : mime === "image/gif"
      ? body.subarray(0, 6).toString("ascii").match(/^GIF8[79]a$/)
      : mime === "image/webp"
      ? body.subarray(0, 4).toString("ascii") === "RIFF" &&
        body.subarray(8, 12).toString("ascii") === "WEBP"
      : mime === "image/bmp"
      ? body.subarray(0, 2).toString("ascii") === "BM"
      : mime === "image/x-icon"
      ? startsWith(0x00, 0x00, 0x01, 0x00) || startsWith(0x00, 0x00, 0x02, 0x00)
      : mime === "image/avif"
      ? body.subarray(4, 8).toString("ascii") === "ftyp" &&
        /^(?:avif|avis)$/.test(body.subarray(8, 12).toString("ascii"))
      : false;
  if (!signatureMatches) fail(400, "The image data does not match its format.");
  return { body, mime };
};
const safeIconName = (value) => {
  const slug = String(value || "icon")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
    .slice(0, 60);
  return `${slug || "icon"}-${crypto.randomUUID().slice(0, 8)}`;
};

export function installIcons(
  app,
  db,
  storage,
  { auth, admin, recent, permit },
) {
  const settings = async () =>
    (await db.query("SELECT value FROM app_settings WHERE key='icons'")).rows[0]
      ?.value || { fetch_enabled: false };

  // Only this one host, only SVG, only small files: a fetch triggered by a model
  // must never become a way to reach arbitrary addresses from this server.
  const download = async (set, name) => {
    const response = await fetch(`${SOURCE}/${set}/${name}.svg`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: "image/svg+xml" },
    });
    if (!response.ok) fail(404, `No icon called ${set}/${name}.`);
    const type = response.headers.get("content-type") || "";
    if (!type.includes("image/svg+xml"))
      fail(502, "That source returned a file that is not an SVG.");
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > MAX_BYTES) fail(413, "That icon is larger than 256 KB.");
    if (/<\s*script|javascript:|<\s*foreignObject/i.test(body.toString("utf8")))
      fail(422, "That icon contains scripting and was rejected.");
    return body;
  };

  const store = async (
    workspace,
    set,
    name,
    body,
    mime,
    meta,
    actor,
    category = "General",
    displayName = null,
  ) => {
    const { rows } = await db.query(
      `INSERT INTO icons(workspace_id,set_name,name,mime,s3_key,svg_data,icon_data,source,license,created_by,category,display_name)
       VALUES($1,$2,$3,$4,NULL,NULL,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (workspace_id,set_name,name) DO UPDATE
       SET svg_data=NULL,icon_data=EXCLUDED.icon_data,mime=EXCLUDED.mime,
           source=EXCLUDED.source,license=EXCLUDED.license,
           category=EXCLUDED.category,
           display_name=COALESCE(EXCLUDED.display_name,icons.display_name)
       RETURNING id,set_name,name,mime,s3_key,svg_data,icon_data,category,display_name`,
      [
        workspace,
        set,
        name,
        mime,
        body,
        meta.source,
        meta.license,
        actor,
        category,
        displayName,
      ],
    );
    return rows[0];
  };

  // Used by the drawing tools: returns the icon ready to embed in a scene.
  const iconData = async (workspace, reference) => {
    const ref = normal(reference);
    if (!REF.test(ref)) return null;
    const [set, name] = ref.split("/");
    const { rows } = await db.query(
      "SELECT * FROM icons WHERE workspace_id=$1 AND set_name=$2 AND name=$3",
      [workspace, set.toLowerCase(), name.toLowerCase()],
    );
    let icon = rows[0];
    if (!icon) {
      if (!(await settings()).fetch_enabled) return null;
      const body = await download(set.toLowerCase(), name.toLowerCase());
      icon = await store(
        workspace,
        set.toLowerCase(),
        name.toLowerCase(),
        body,
        "image/svg+xml",
        { source: `${SOURCE}/${set}/${name}.svg`, license: "see source" },
        null,
      );
    }
    const body =
      icon.icon_data ||
      icon.svg_data ||
      (icon.s3_key ? await storage.read(icon.s3_key) : null);
    if (!body) return null;
    return {
      ref: `${icon.set_name}/${icon.name}`,
      mime: icon.mime,
      dataURL: `data:${icon.mime};base64,${body.toString("base64")}`,
    };
  };

  app.get("/api/workspaces/:workspace/icons", auth, async (req, res) => {
    await permit(req.user, req.params.workspace, "drawing.read");
    const query = String(req.query.q || "")
      .trim()
      .slice(0, 80);
    const category = String(req.query.category || "").trim().slice(0, 40);
    const limit = Math.max(1, Math.min(300, Number(req.query.limit) || 120));
    const [{ rows }, categories] = await Promise.all([
      db.query(
        `SELECT set_name,name,mime,source,license,created_at,category,display_name
       FROM icons WHERE workspace_id=$1
       AND ($2::text='' OR set_name ILIKE '%'||$2||'%' OR name ILIKE '%'||$2||'%' OR display_name ILIKE '%'||$2||'%')
       AND ($3::text='' OR category=$3)
       ORDER BY category,COALESCE(display_name,name),set_name,name LIMIT $4`,
        [req.params.workspace, query, category, limit],
      ),
      db.query(
        "SELECT DISTINCT category FROM icons WHERE workspace_id=$1 ORDER BY category",
        [req.params.workspace],
      ),
    ]);
    res.json({
      icons: rows,
      categories: categories.rows.map((row) => row.category),
    });
  });

  app.post("/api/workspaces/:workspace/icons", auth, async (req, res) => {
    const workspace = req.params.workspace;
    await permit(req.user, workspace, "drawing.edit");
    const { body, mime } = parseCanvasImage(req.body?.data_url);
    const displayName = displayNameValue(req.body?.display_name);
    if (!displayName) fail(400, "Icon name is required.");
    const category = categoryValue(req.body?.category);
    const icon = await store(
      workspace,
      "uploads",
      safeIconName(displayName),
      body,
      mime,
      { source: "canvas", license: null },
      req.user.id,
      category,
      displayName,
    );
    await audit(db, req.user.id, "icons.add_from_canvas", workspace);
    res.status(201).json({ icon });
  });

  app.get(
    "/api/workspaces/:workspace/icons/:set/:name",
    auth,
    async (req, res) => {
      await permit(req.user, req.params.workspace, "drawing.read");
      const reference = normal(`${req.params.set}/${req.params.name}`);
      if (!REF.test(reference)) fail(404, "Icon not found.");
      const [set, name] = reference.split("/");
      const { rows } = await db.query(
        `SELECT mime,s3_key,svg_data,icon_data FROM icons
         WHERE workspace_id=$1 AND set_name=$2 AND name=$3`,
        [req.params.workspace, set, name],
      );
      const icon = rows[0];
      if (!icon) fail(404, "Icon not found.");
      const body =
        icon.icon_data ||
        icon.svg_data ||
        (icon.s3_key ? await storage.read(icon.s3_key) : null);
      if (!body) fail(404, "Icon data not found.");
      res.set({
        "Content-Type": icon.mime,
        "Cache-Control": "private, max-age=3600",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
        "X-Content-Type-Options": "nosniff",
      });
      res.send(body);
    },
  );

  // Search the icon source by words, so an admin never has to guess exact names.
  app.get("/api/admin/icons/search", auth, admin, async (req, res) => {
    const query = String(req.query.q || "").trim().slice(0, 60);
    if (!query) return res.json({ results: [] });
    const response = await fetch(
      `${SOURCE}/search?query=${encodeURIComponent(query)}&limit=48`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (!response.ok) fail(502, "The icon source is unavailable right now.");
    const body = await response.json();
    res.json({ results: Array.isArray(body.icons) ? body.icons.slice(0, 48) : [] });
  });

  // Previews are proxied so the page can show them without reaching outside.
  app.get("/api/admin/icons/preview", auth, admin, async (req, res) => {
    const ref = normal(req.query.ref);
    if (!REF.test(ref)) fail(400, "Use the form set/name or set:name.");
    const [set, name] = ref.split("/");
    const body = await download(set, name);
    res.set({
      "Content-Type": "image/svg+xml",
      "Cache-Control": "private, max-age=86400",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    });
    res.send(body);
  });

  app.get("/api/admin/icons", auth, admin, async (req, res) => {
    const workspace = req.query.workspace;
    if (!uuid(workspace)) fail(400, "Choose a workspace.");
    const { rows } = await db.query(
      "SELECT set_name,name,display_name,category,source,license,created_at FROM icons WHERE workspace_id=$1 ORDER BY category,COALESCE(display_name,name),set_name,name",
      [workspace],
    );
    const categories = await db.query(
      "SELECT DISTINCT category FROM icons WHERE workspace_id=$1 ORDER BY category",
      [workspace],
    );
    res.json({
      icons: rows,
      categories: categories.rows.map((row) => row.category),
      ...(await settings()),
    });
  });

  app.put(
    "/api/admin/icons/settings",
    auth,
    admin,
    recent,
    async (req, res) => {
      const enabled = req.body?.fetch_enabled === true;
      await db.query(
        `INSERT INTO app_settings(key,value) VALUES('icons',$1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value=$1::jsonb,updated_at=now(),updated_by=$2`,
        [JSON.stringify({ fetch_enabled: enabled }), req.user.id],
      );
      await audit(
        db,
        req.user.id,
        "icons.fetch." + (enabled ? "enable" : "disable"),
        null,
      );
      res.json({ fetch_enabled: enabled });
    },
  );

  // Pull a named set of icons into the library in one go.
  app.post("/api/admin/icons/import", auth, admin, recent, async (req, res) => {
    const workspace = req.body?.workspace_id;
    if (!uuid(workspace)) fail(400, "Choose a workspace.");
    const category = categoryValue(req.body?.category);
    const refs = Array.isArray(req.body?.icons) ? req.body.icons : [];
    if (!refs.length || refs.length > MAX_IMPORT)
      fail(400, `Import between 1 and ${MAX_IMPORT} icons at a time.`);
    const displayName =
      refs.length === 1 ? displayNameValue(req.body?.display_name) : null;
    const imported = [];
    const failed = [];
    for (const ref of refs) {
      if (!REF.test(normal(ref))) {
        failed.push({
          ref,
          error: "Use the form set/name, like logos/kubernetes.",
        });
        continue;
      }
      const [set, name] = normal(ref).split("/");
      try {
        const body = await download(set, name);
        imported.push(
          await store(
            workspace,
            set,
            name,
            body,
            "image/svg+xml",
            { source: `${SOURCE}/${set}/${name}.svg`, license: "CC0/see set" },
            req.user.id,
            category,
            displayName,
          ),
        );
      } catch (error) {
        failed.push({ ref, error: error.message });
      }
    }
    await audit(db, req.user.id, "icons.import", workspace);
    res.json({ imported: imported.length, failed, icons: imported });
  });

  return { iconData, settings, REF };
}
