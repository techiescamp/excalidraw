import crypto from "node:crypto";
import express from "express";
import { fail, uuid, transaction, sha256 } from "./core.js";
import {
  archiveTask,
  safePath,
  MAX_BYTES,
  MAX_SCENE_BYTES,
  MAX_FILES,
} from "./transfer-archive.js";
const cleanName = (name) =>
  String(name)
    .replace(/[\\/\x00-\x1f<>:"|?*]/g, "_")
    .slice(0, 80) || "Untitled";
export function installWorkspaceTransfer(app, db, storage, security, drawings) {
  const { auth, admin, permit } = security;
  const prefix = "/api/admin/workspaces/:workspaceId";
  const audit = (tx, user, action, id, metadata = {}) =>
    tx.query(
      "INSERT INTO audit_log(actor_id,action,target_type,target_id,metadata) VALUES($1,$2,'workspace',$3,$4)",
      [user, action, id, { ...metadata, outcome: "success" }],
    );
  const workspaceAccess = async (req, res, next) => {
    if (!uuid(req.params.workspaceId)) fail(404, "Workspace not found.");
    if (
      !(
        await db.query("SELECT 1 FROM workspaces WHERE id=$1", [
          req.params.workspaceId,
        ])
      ).rowCount
    )
      fail(404, "Workspace not found.");
    await permit(req.user, req.params.workspaceId, "drawing.read");
    next();
  };
  app.get(
    prefix + "/transfers",
    auth,
    admin,
    workspaceAccess,
    async (req, res) => {
      const workspace = req.params.workspaceId;
      const history = await db.query(
        `SELECT e.id,e.scope,e.status,e.scene_count,e.error,e.created_at,e.expires_at,u.username,
      e.requested_by=$2 AS own FROM workspace_exports e JOIN users u ON u.id=e.requested_by WHERE e.workspace_id=$1 ORDER BY e.created_at DESC LIMIT 50`,
        [workspace, req.user.id],
      );
      const members = await db.query(
        "SELECT u.id,u.username FROM users u JOIN workspace_members m ON m.user_id=u.id WHERE m.workspace_id=$1 AND u.is_active ORDER BY u.username",
        [workspace],
      );
      const cooldown = await db.query(
        "SELECT max(created_at)+interval '1 hour' AS next_export_at FROM workspace_exports WHERE workspace_id=$1 AND requested_by=$2",
        [workspace, req.user.id],
      );
      res.json({
        history: history.rows,
        members: members.rows,
        next_export_at: cooldown.rows[0].next_export_at,
        storage: storage.kind(),
      });
    },
  );
  app.post(
    prefix + "/exports",
    auth,
    admin,
    workspaceAccess,
    async (req, res) => {
      const scope = req.body?.scope,
        member = req.body?.member_id;
      if (!["accessible", "all", "member"].includes(scope))
        fail(400, "Choose an export scope.");
      if (
        scope === "member" &&
        (!uuid(member) ||
          !(
            await db.query(
              "SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2",
              [req.params.workspaceId, member],
            )
          ).rowCount)
      )
        fail(400, "Choose a workspace member.");
      const job = await transaction(db, async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "export:" + req.params.workspaceId + req.user.id,
        ]);
        if (
          (
            await tx.query(
              "SELECT 1 FROM workspace_exports WHERE workspace_id=$1 AND requested_by=$2 AND created_at>now()-interval '1 hour'",
              [req.params.workspaceId, req.user.id],
            )
          ).rowCount
        )
          fail(429, "You can export once per hour.");
        const { rows } = await tx.query(
          "INSERT INTO workspace_exports(workspace_id,requested_by,scope,member_id) VALUES($1,$2,$3,$4) RETURNING id",
          [
            req.params.workspaceId,
            req.user.id,
            scope,
            scope === "member" ? member : null,
          ],
        );
        await audit(
          tx,
          req.user.id,
          "workspace.export.request",
          req.params.workspaceId,
          {
            export_id: rows[0].id,
            scope,
            member_id: scope === "member" ? member : null,
          },
        );
        return rows[0];
      });
      res.status(202).json(job);
      void tick();
    },
  );
  app.get(
    prefix + "/exports/:id/download",
    auth,
    admin,
    workspaceAccess,
    async (req, res) => {
      const { rows } = await db.query(
        "SELECT * FROM workspace_exports WHERE id=$1 AND workspace_id=$2 AND requested_by=$3 AND status='ready' AND expires_at>now()",
        [
          uuid(req.params.id) ? req.params.id : null,
          req.params.workspaceId,
          req.user.id,
        ],
      );
      const job = rows[0];
      if (!job) fail(404, "Export is unavailable or expired.");
      await audit(
        db,
        req.user.id,
        "workspace.export.download",
        req.params.workspaceId,
        { export_id: job.id, scope: job.scope },
      );
      res.set("Cache-Control", "no-store");
      res.attachment("workspace-export-" + job.id + ".zip");
      if (!(await storage.pipe(job.object_key, res)))
        fail(404, "Export file is unavailable.");
    },
  );
  // Admission happens before reading the body, keeping concurrent uploads bounded.
  let importing = false;
  app.post(
    prefix + "/imports",
    auth,
    admin,
    workspaceAccess,
    (req, res, next) => {
      if (importing)
        return res
          .status(429)
          .json({ error: "Another import is running. Try again shortly." });
      importing = true;
      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          importing = false;
        }
      };
      req.releaseImport = release;
      res.once("finish", release);
      res.once("close", () => {
        if (!req.processingImport) release();
      });
      next();
    },
    express.raw({
      type: ["application/zip", "application/x-excalidraw"],
      limit: "100mb",
    }),
    async (req, res) => {
      req.processingImport = true;
      try {
        const workspace = req.params.workspaceId,
          requestId = req.get("Idempotency-Key");
        if (!uuid(requestId)) fail(400, "A UUID Idempotency-Key is required.");
        if (!Buffer.isBuffer(req.body))
          fail(400, "Upload a ZIP or Excalidraw file.");
        let files;
        try {
          files = req.is("application/zip")
            ? await archiveTask("unzip", req.body)
            : {
                [safePath(
                  decodeURIComponent(
                    req.get("X-File-Path") || "Drawing.excalidraw",
                  ),
                )]: req.body,
              };
        } catch (error) {
          fail(400, error.message);
        }
        const entries = Object.entries(files).filter(([name]) =>
          /\.excalidraw$/i.test(name),
        );
        if (!entries.length) fail(400, "No .excalidraw files were found.");
        if (entries.length > MAX_FILES) fail(413, "Too many drawings.");
        let manifest = null;
        if (files["manifest.json"]) {
          try {
            manifest = JSON.parse(
              Buffer.from(files["manifest.json"]).toString(),
            );
          } catch {
            fail(400, "Invalid manifest.");
          }
        }
        const result = { imported: 0, skipped: 0, errors: [] };
        for (const [file, bytes] of entries) {
          try {
            if (bytes.length > MAX_SCENE_BYTES)
              fail(413, "Drawing exceeds 25 MB.");
            const parsed = JSON.parse(Buffer.from(bytes).toString());
            if (parsed.type !== "excalidraw")
              fail(400, "Invalid Excalidraw file.");
            const payload = drawings.validateScene({
              ...parsed,
              appState: parsed.appState || {},
              files: parsed.files || {},
            });
            const info =
              manifest?.format === "excalidraw-workspace-v1"
                ? manifest.scenes?.find((s) => s.path === file)
                : null;
            const fingerprint = sha256(bytes);
            const imported = await transaction(db, async (tx) => {
              await tx.query(
                "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
                ["import:" + workspace + req.user.id + requestId],
              );
              const old = (
                await tx.query(
                  "SELECT fingerprint FROM workspace_import_files WHERE workspace_id=$1 AND requested_by=$2 AND request_id=$3 AND file_path=$4",
                  [workspace, req.user.id, requestId, file],
                )
              ).rows[0];
              if (old) {
                if (old.fingerprint !== fingerprint)
                  fail(409, "Retry content changed.");
                return false;
              }
              const folder = file.includes("/")
                ? file.slice(0, file.lastIndexOf("/"))
                : null;
              const isPrivate = info
                ? info.private === true
                : folder === "Private";
              const collectionNames =
                info && Array.isArray(info.collections)
                  ? info.collections.map((c) => c.name)
                  : folder && !isPrivate
                  ? [folder]
                  : [];
              const collections = [];
              if (!isPrivate)
                for (const value of collectionNames) {
                  const name = String(value).trim();
                  if (!name || [...name].length > 80)
                    fail(400, "Collection name must be 1–80 characters.");
                  await permit(req.user, workspace, "collection.create", tx);
                  const col = (
                    await tx.query(
                      `INSERT INTO collections(workspace_id,name,normalized_name,created_by) VALUES($1,$2,lower(normalize($2,NFKC)),$3)
              ON CONFLICT(workspace_id,normalized_name) DO UPDATE SET name=collections.name RETURNING *`,
                      [workspace, name, req.user.id],
                    )
                  ).rows[0];
                  if (col.deleted_at)
                    fail(
                      409,
                      "Restore the matching collection from Trash first.",
                    );
                  await drawings.collectionAccess(
                    req.user,
                    col.id,
                    "collection.add",
                    tx,
                  );
                  collections.push(col.id);
                }
              const selected = req.query.collection_id;
              if (!folder && !info && selected) {
                await drawings.collectionAccess(
                  req.user,
                  selected,
                  "collection.add",
                  tx,
                );
                collections.push(selected);
              }
              await permit(req.user, workspace, "drawing.import", tx);
              const scene = await drawings.create(
                {
                  user: req.user,
                  body: {
                    workspace_id: workspace,
                    name:
                      info?.name ||
                      file
                        .split("/")
                        .pop()
                        .replace(/\.excalidraw$/, ""),
                    collection_id: collections[0] || null,
                    private: isPrivate || (!info && !collections.length),
                  },
                },
                tx,
                payload,
              );
              for (const collection of collections.slice(1))
                await tx.query(
                  "INSERT INTO collection_drawings(workspace_id,collection_id,drawing_id,added_by) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
                  [workspace, collection, scene.id, req.user.id],
                );
              await tx.query(
                "INSERT INTO workspace_import_files(workspace_id,requested_by,request_id,file_path,fingerprint,scene_id) VALUES($1,$2,$3,$4,$5,$6)",
                [
                  workspace,
                  req.user.id,
                  requestId,
                  file,
                  fingerprint,
                  scene.id,
                ],
              );
              await audit(
                tx,
                req.user.id,
                "workspace.import.scene",
                workspace,
                { scene_id: scene.id, file },
              );
              return true;
            });
            result[imported ? "imported" : "skipped"]++;
          } catch (error) {
            result.errors.push({
              file,
              error: error.status
                ? error.message
                : "Invalid file or import failed. Try again.",
            });
          }
        }
        res.json(result);
      } finally {
        req.releaseImport();
      }
    },
  );
  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    // A session lock prevents two API processes from building the same queue concurrently.
    let lock;
    try {
      lock = await db.connect();
      if (
        !(await lock.query("SELECT pg_try_advisory_lock(4271909) AS locked"))
          .rows[0].locked
      )
        return;
      const expired = await db.query(
        "SELECT id,object_key FROM workspace_exports WHERE expires_at<=now() AND status<>'expired'",
      );
      for (const job of expired.rows) {
        if (job.object_key) await storage.remove(job.object_key);
        await db.query(
          "UPDATE workspace_exports SET status='expired',object_key=NULL WHERE id=$1",
          [job.id],
        );
      }
      // With the queue lock held, an exporting row is an interrupted previous process.
      const { rows } = await db.query(
        "SELECT e.*,u.is_superadmin,u.is_active FROM workspace_exports e JOIN users u ON u.id=e.requested_by WHERE status IN ('queued','exporting') AND expires_at>now() ORDER BY created_at LIMIT 1",
      );
      const job = rows[0];
      if (!job) return;
      try {
        if (!job.is_active || !job.is_superadmin)
          throw new Error("Requesting administrator is no longer active.");
        await db.query(
          "UPDATE workspace_exports SET status='exporting' WHERE id=$1",
          [job.id],
        );
        const user = { id: job.requested_by, is_superadmin: true };
        async function* scenePages() {
          let cursor = "00000000-0000-0000-0000-000000000000";
          while (true) {
            const { rows } = await db.query(
              `SELECT * FROM scenes WHERE workspace_id=$1 AND deleted_at IS NULL
               AND ($2<>'member' OR private_owner_id=$3) AND id>$4 ORDER BY id LIMIT 100`,
              [job.workspace_id, job.scope, job.member_id, cursor],
            );
            if (!rows.length) return;
            for (const row of rows) yield row;
            cursor = rows.at(-1).id;
          }
        }
        const files = Object.create(null),
          manifest = {
            format: "excalidraw-workspace-v1",
            workspace_id: job.workspace_id,
            scenes: [],
          };
        let total = 0;
        for await (const scene of scenePages()) {
          if (job.scope === "accessible") {
            try {
              await drawings.sceneAccess(user, scene.id);
            } catch (error) {
              if ([403, 404].includes(error.status)) continue;
              throw error;
            }
          }
          if (manifest.scenes.length >= MAX_FILES - 1)
            throw new Error(
              "Export exceeds 999 drawings. Export a smaller scope.",
            );
          const cols = (
            await db.query(
              "SELECT c.id,c.name FROM collections c JOIN collection_drawings cd ON cd.collection_id=c.id WHERE cd.drawing_id=$1 AND c.deleted_at IS NULL ORDER BY c.name",
              [scene.id],
            )
          ).rows;
          const folder = scene.private_owner_id
            ? "Private"
            : cols.length
            ? cleanName(cols[0].name) + "__" + cols[0].id
            : "Uncollected";
          const path =
            folder +
            "/" +
            cleanName(scene.name) +
            "__" +
            scene.id +
            ".excalidraw";
          const bytes = Buffer.from(
            JSON.stringify(await drawings.readScene(scene)),
          );
          if (
            bytes.length > MAX_SCENE_BYTES ||
            (total += bytes.length) > MAX_BYTES
          )
            throw new Error(
              "Export exceeds 100 MB total or 25 MB per drawing. Export a smaller scope.",
            );
          files[path] = bytes;
          manifest.scenes.push({
            path,
            name: scene.name,
            private: Boolean(scene.private_owner_id),
            collections: scene.private_owner_id ? [] : cols,
          });
        }
        files["manifest.json"] = Buffer.from(JSON.stringify(manifest));
        if (total + files["manifest.json"].length > MAX_BYTES)
          throw new Error("Export exceeds 100 MB including its manifest.");
        const bytes = await archiveTask("zip", files),
          key = "workspace-exports/" + job.workspace_id + "/" + job.id + ".zip";
        await storage.put(key, bytes, "application/zip");
        await db.query(
          "UPDATE workspace_exports SET status='ready',object_key=$2,scene_count=$3,completed_at=now(),error=NULL WHERE id=$1",
          [job.id, key, manifest.scenes.length],
        );
        await audit(
          db,
          job.requested_by,
          "workspace.export.ready",
          job.workspace_id,
          {
            export_id: job.id,
            scope: job.scope,
            scene_count: manifest.scenes.length,
          },
        );
      } catch (error) {
        await db.query(
          "UPDATE workspace_exports SET status='failed',error=$2,completed_at=now() WHERE id=$1",
          [job.id, error.message],
        );
      }
    } catch (error) {
      console.error("Workspace transfer worker:", error.message);
    } finally {
      if (lock) {
        await lock.query("SELECT pg_advisory_unlock(4271909)").catch(() => {});
        lock.release();
      }
      running = false;
    }
  }
  const timer = setInterval(() => void tick(), 5000);
  timer.unref();
  void tick();
}
