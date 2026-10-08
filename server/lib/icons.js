import crypto from "node:crypto";
import { fail, uuid, audit } from "./core.js";

// Icons live in the workspace's own library. Anything fetched from the internet
// is stored here on first use, so drawings never depend on a site staying up and
// the same icon is never downloaded twice.
const SOURCE = "https://api.iconify.design";
const MAX_BYTES = 256 * 1024;
const MAX_IMPORT = 40;
const REF = /^[a-z0-9][a-z0-9_-]{0,59}\/[a-z0-9][a-z0-9._-]{0,79}$/i;
const TIMEOUT_MS = 8000;
// The icon source names things "set:name"; this library uses "set/name".
const normal = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(":", "/");

export function installIcons(app, db, storage, { auth, admin, recent }) {
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

  const store = async (workspace, set, name, body, mime, meta, actor) => {
    const key = `icons/${workspace}/${set}/${crypto.randomUUID()}.svg`;
    await storage.put(key, body, mime);
    const { rows } = await db.query(
      `INSERT INTO icons(workspace_id,set_name,name,mime,s3_key,source,license,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (workspace_id,set_name,name) DO UPDATE SET s3_key=EXCLUDED.s3_key,mime=EXCLUDED.mime
       RETURNING id,set_name,name`,
      [workspace, set, name, mime, key, meta.source, meta.license, actor],
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
      icon.s3_key = (
        await db.query("SELECT s3_key,mime FROM icons WHERE id=$1", [icon.id])
      ).rows[0].s3_key;
      icon.mime = "image/svg+xml";
    }
    const body = await storage.read(icon.s3_key);
    if (!body) return null;
    return {
      ref: `${icon.set_name}/${icon.name}`,
      mime: icon.mime,
      dataURL: `data:${icon.mime};base64,${body.toString("base64")}`,
    };
  };

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
      "SELECT set_name,name,source,license,created_at FROM icons WHERE workspace_id=$1 ORDER BY set_name,name",
      [workspace],
    );
    res.json({ icons: rows, ...(await settings()) });
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
    const refs = Array.isArray(req.body?.icons) ? req.body.icons : [];
    if (!refs.length || refs.length > MAX_IMPORT)
      fail(400, `Import between 1 and ${MAX_IMPORT} icons at a time.`);
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
