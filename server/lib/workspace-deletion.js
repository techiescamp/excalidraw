import { fail, uuid, transaction } from "./core.js";
const countsSQL = `SELECT w.*,
 (SELECT count(*)::int FROM scenes WHERE workspace_id=w.id) AS scenes,
 (SELECT count(*)::int FROM collections WHERE workspace_id=w.id) AS collections
 FROM workspaces w WHERE w.id=$1`;
const audit = (db, actor, action, id, metadata) =>
  db.query(
    "INSERT INTO audit_log(actor_id,action,target_type,target_id,metadata) VALUES($1,$2,'workspace',$3,$4)",
    [actor, action, id, { ...metadata, outcome: "success" }],
  );
export async function cleanupWorkspaceTrash(db, storage) {
  const job = await transaction(db, async (tx) => {
    if (
      !(await tx.query("SELECT pg_try_advisory_xact_lock(4271909) AS locked"))
        .rows[0].locked
    )
      return null;
    const row = (
      await tx.query(
        `SELECT * FROM workspaces WHERE deleted_at IS NOT NULL AND purge_after<=now() ORDER BY purge_after LIMIT 1 FOR UPDATE SKIP LOCKED`,
      )
    ).rows[0];
    if (!row) return null;
    if (!row.purging_at) {
      await tx.query("UPDATE workspaces SET purging_at=now() WHERE id=$1", [
        row.id,
      ]);
      await tx.query(
        `INSERT INTO workspace_cleanup_objects(workspace_id,object_key)
       SELECT $1,key FROM (
        SELECT s3_key AS key FROM scenes WHERE workspace_id=$1
        UNION SELECT thumb_s3_key FROM scenes WHERE workspace_id=$1
        UNION SELECT collab_s3_key FROM scenes WHERE workspace_id=$1
        UNION SELECT v.s3_key FROM scene_versions v JOIN scenes s ON s.id=v.scene_id WHERE s.workspace_id=$1
        UNION SELECT f.s3_key FROM scene_files f WHERE f.scene_id IN(SELECT id FROM scenes WHERE workspace_id=$1) OR f.room_id IN(SELECT room_id FROM scenes WHERE workspace_id=$1)
        UNION SELECT object_key FROM workspace_exports WHERE workspace_id=$1
       ) objects WHERE key IS NOT NULL AND key<>'' ON CONFLICT DO NOTHING`,
        [row.id],
      );
      await audit(tx, row.deleted_by, "workspace.purge.start", row.id, {
        name: row.name,
      });
    }
    return row;
  });
  if (!job) return;
  // Persistent per-object completion makes failed or interrupted cleanup retryable.
  const objects = (
    await db.query(
      "SELECT object_key FROM workspace_cleanup_objects WHERE workspace_id=$1 AND completed_at IS NULL LIMIT 100",
      [job.id],
    )
  ).rows;
  for (const { object_key: key } of objects) {
    const shared = (
      await db.query(
        `SELECT 1 WHERE
      EXISTS(SELECT 1 FROM scenes WHERE workspace_id<>$1 AND (s3_key=$2 OR thumb_s3_key=$2 OR collab_s3_key=$2)) OR
      EXISTS(SELECT 1 FROM scene_versions v JOIN scenes s ON s.id=v.scene_id WHERE s.workspace_id<>$1 AND v.s3_key=$2) OR
      EXISTS(SELECT 1 FROM scene_files f LEFT JOIN scenes s ON s.id=f.scene_id WHERE f.s3_key=$2 AND (s.workspace_id<>$1 OR (f.scene_id IS NULL AND NOT EXISTS(SELECT 1 FROM scenes own WHERE own.workspace_id=$1 AND own.room_id=f.room_id)))) OR
      EXISTS(SELECT 1 FROM shared_scenes WHERE s3_key=$2) OR
      EXISTS(SELECT 1 FROM workspace_exports WHERE workspace_id<>$1 AND object_key=$2)`,
        [job.id, key],
      )
    ).rowCount;
    if (!shared) await storage.remove(key);
    await db.query(
      "UPDATE workspace_cleanup_objects SET completed_at=now() WHERE workspace_id=$1 AND object_key=$2",
      [job.id, key],
    );
  }
  await transaction(db, async (tx) => {
    const workspace = (
      await tx.query("SELECT * FROM workspaces WHERE id=$1 FOR UPDATE", [
        job.id,
      ])
    ).rows[0];
    if (!workspace) return;
    if (
      (
        await tx.query(
          "SELECT 1 FROM workspace_cleanup_objects WHERE workspace_id=$1 AND completed_at IS NULL LIMIT 1",
          [job.id],
        )
      ).rowCount
    )
      return;
    await tx.query(
      "DELETE FROM scene_files WHERE scene_id IS NULL AND room_id IN(SELECT room_id FROM scenes WHERE workspace_id=$1)",
      [job.id],
    );
    await audit(tx, workspace.deleted_by, "workspace.purge.complete", job.id, {
      name: workspace.name,
    });
    await tx.query("DELETE FROM workspaces WHERE id=$1", [job.id]);
  });
}
export function installWorkspaceDeletion(
  app,
  db,
  storage,
  { auth, admin, recent },
) {
  const prefix = "/api/admin/workspaces/:id";
  app.get(prefix + "/delete-preview", auth, admin, async (req, res) => {
    if (!uuid(req.params.id)) fail(404, "Workspace not found.");
    const row = (await db.query(countsSQL, [req.params.id])).rows[0];
    if (!row || row.deleted_at) fail(404, "Workspace not found.");
    res.json({
      name: row.name,
      collections: row.collections,
      scenes: row.scenes,
      retention_days: 30,
    });
  });
  app.delete(prefix, auth, admin, recent, async (req, res) => {
    if (!uuid(req.params.id)) fail(404, "Workspace not found.");
    const result = await transaction(db, async (tx) => {
      // Wait for a running export before taking the workspace offline.
      await tx.query("SELECT pg_advisory_xact_lock(4271909)");
      const row = (
        await tx.query(countsSQL + " FOR UPDATE OF w", [req.params.id])
      ).rows[0];
      if (!row || row.deleted_at) fail(404, "Workspace not found.");
      if (req.body?.name !== row.name)
        fail(400, "Type the exact workspace name to confirm.");
      if (
        req.body?.scenes !== row.scenes ||
        req.body?.collections !== row.collections
      )
        fail(
          409,
          "Workspace contents changed. Review the updated counts before deleting.",
        );
      const updated = (
        await tx.query(
          "UPDATE workspaces SET deleted_at=now(),deleted_by=$2,purge_after=now()+interval '30 days' WHERE id=$1 RETURNING purge_after",
          [row.id, req.user.id],
        )
      ).rows[0];
      await audit(tx, req.user.id, "workspace.trash", row.id, {
        name: row.name,
        scenes: row.scenes,
        collections: row.collections,
        purge_after: updated.purge_after,
      });
      await tx.query("SELECT pg_notify('workspace_changed',$1)", [row.id]);
      return updated;
    });
    res.json(result);
  });
  app.post(prefix + "/restore", auth, admin, recent, async (req, res) => {
    if (!uuid(req.params.id)) fail(404, "Workspace not found.");
    await transaction(db, async (tx) => {
      const row = (
        await tx.query("SELECT * FROM workspaces WHERE id=$1 FOR UPDATE", [
          req.params.id,
        ])
      ).rows[0];
      if (!row || !row.deleted_at) fail(404, "Trashed workspace not found.");
      if (row.purging_at || new Date(row.purge_after) <= new Date())
        fail(409, "The restore period has ended.");
      await tx.query(
        "UPDATE workspaces SET deleted_at=NULL,deleted_by=NULL,purge_after=NULL WHERE id=$1",
        [row.id],
      );
      await audit(tx, req.user.id, "workspace.restore", row.id, {
        name: row.name,
      });
    });
    res.json({ restored: true });
  });
  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    // Separate session lock keeps multiple API instances from sharing a cleanup job.
    let client;
    try {
      client = await db.connect();
      if (
        !(await client.query("SELECT pg_try_advisory_lock(4271910) AS locked"))
          .rows[0].locked
      )
        return;
      await cleanupWorkspaceTrash(db, storage);
    } catch (error) {
      console.error("Workspace cleanup:", error.message);
    } finally {
      if (client) {
        await client
          .query("SELECT pg_advisory_unlock(4271910)")
          .catch(() => {});
        client.release();
      }
      running = false;
    }
  }
  const timer = setInterval(() => void tick(), 60000);
  timer.unref();
  void tick();
}
