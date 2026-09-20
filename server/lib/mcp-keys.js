import crypto from "node:crypto";
import { fail, uuid, sha256, audit } from "./core.js";

// Keys are shown once at creation and stored only as a hash, like password tokens.
const PREFIX = "exmcp_";
const TOKEN = /^exmcp_[A-Za-z0-9_-]{43}$/;

export function installMcpKeys(app, db, { auth, admin, recent }) {
  const list = `SELECT k.id,k.name,k.scope,k.workspace_id,k.created_at,k.last_used_at,
   u.username AS owner,w.name AS workspace FROM mcp_keys k JOIN users u ON u.id=k.user_id
   LEFT JOIN workspaces w ON w.id=k.workspace_id WHERE k.revoked_at IS NULL ORDER BY k.created_at DESC`;
  app.get("/api/admin/mcp-keys", auth, admin, async (_req, res) => {
    const { rows } = await db.query(list);
    res.json(rows);
  });
  app.post("/api/admin/mcp-keys", auth, admin, recent, async (req, res) => {
    const name = String(req.body?.name || "").trim();
    if (!name || [...name].length > 80)
      fail(400, "Use a key name of 1–80 characters.");
    const scope = req.body?.scope === "write" ? "write" : "read";
    const workspace = req.body?.workspace_id || null;
    if (workspace && !uuid(workspace)) fail(400, "Invalid workspace.");
    const token = PREFIX + crypto.randomBytes(32).toString("base64url");
    const { rows } = await db.query(
      `INSERT INTO mcp_keys(user_id,workspace_id,name,token_hash,scope,created_by)
       VALUES($1,$2,$3,$4,$5,$1) RETURNING id,name,scope,created_at`,
      [req.user.id, workspace, name, sha256(token), scope],
    );
    await audit(db, req.user.id, "mcp.key.create", rows[0].id);
    // The token is returned exactly once; only its hash is stored.
    res.status(201).json({ ...rows[0], token });
  });
  app.delete(
    "/api/admin/mcp-keys/:id",
    auth,
    admin,
    recent,
    async (req, res) => {
      if (!uuid(req.params.id)) fail(404, "Key not found.");
      const { rows } = await db.query(
        "UPDATE mcp_keys SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL RETURNING id",
        [req.params.id],
      );
      if (!rows[0]) fail(404, "Key not found.");
      await audit(db, req.user.id, "mcp.key.revoke", rows[0].id);
      res.json({ ok: true });
    },
  );

  // Resolves a presented token to the person it acts as. Revoked keys, inactive
  // accounts and deleted workspaces all stop working immediately.
  return async function keyHolder(token) {
    if (typeof token !== "string" || !TOKEN.test(token)) return null;
    const { rows } = await db.query(
      `UPDATE mcp_keys k SET last_used_at=now() FROM users u
       WHERE k.token_hash=$1 AND k.revoked_at IS NULL AND u.id=k.user_id AND u.is_active AND NOT u.pending_setup
       RETURNING k.id AS key_id,k.scope,k.workspace_id,u.id,u.username,u.display_name,u.is_superadmin`,
      [sha256(token)],
    );
    if (!rows[0]) return null;
    const row = rows[0];
    return {
      keyId: row.key_id,
      scope: row.scope,
      workspaceId: row.workspace_id,
      user: {
        id: row.id,
        username: row.username,
        display_name: row.display_name,
        is_superadmin: row.is_superadmin,
      },
    };
  };
}
