import { protectSecret, revealSecret } from "./secrets.js";
import { mergeSceneSnapshots } from "./merge-scene.js";
import { collectionTeamVisibility } from "./teams.js";
import crypto from "node:crypto";
import { fail, uuid, transaction, sha256 } from "./core.js";

export function installDrawings(app, db, storage, security) {
  const { auth, permit } = security;
  // Keep legacy view-only scene grants and private collection visibility restrictions.
  const visibility = `(s.private_owner_id IS NULL OR s.private_owner_id=$1) AND (NOT EXISTS(SELECT 1 FROM legacy_scene_visibility pv WHERE pv.scene_id=s.id AND pv.visible_to<>$1)
   OR $2::boolean) AND (
 NOT EXISTS(SELECT 1 FROM collection_drawings cd JOIN collections c ON c.id=cd.collection_id WHERE cd.drawing_id=s.id)
 OR EXISTS(SELECT 1 FROM collection_drawings cd JOIN collections c ON c.id=cd.collection_id WHERE cd.drawing_id=s.id AND ${collectionTeamVisibility}))`;
  const sceneAccess = async (
    user,
    id,
    key = "drawing.read",
    tx = db,
    trashed = false,
  ) => {
    if (!uuid(id)) fail(404, "Drawing not found.");
    const { rows } = await tx.query(
      `SELECT s.*,sp.permission AS explicit_permission FROM scenes s LEFT JOIN scene_permissions sp ON sp.scene_id=s.id AND sp.user_id=$1 WHERE s.id=$3 AND ${visibility}`,
      [user.id, user.is_superadmin, id],
    );
    const scene = rows[0];
    if (!scene || (scene.deleted_at && !trashed))
      fail(404, "Drawing not found.");
    const permissions = await permit(user, scene.workspace_id, key, tx);
    if (
      scene.explicit_permission === "view" &&
      ["drawing.edit", "drawing.rename", "drawing.trash"].includes(key) &&
      !user.is_superadmin
    )
      fail(403, "This drawing is read-only.");
    return { scene, permissions };
  };
  const collectionAccess = async (user, id, key, tx = db, lock = false) => {
    if (!uuid(id)) fail(404, "Collection not found.");
    const { rows } = await tx.query(
      `SELECT c.* FROM collections c WHERE c.id=$3 AND ${collectionTeamVisibility} ${
        lock ? "FOR UPDATE" : ""
      }`,
      [user.id, user.is_superadmin, id],
    );
    const col = rows[0];
    if (
      !col ||
      col.deleted_at ||
      (col.is_private && col.created_by !== user.id && !user.is_superadmin)
    )
      fail(404, "Collection not found.");
    await permit(user, col.workspace_id, key, tx);
    return col;
  };
  const collectionIcon = (value) =>
    typeof value === "string" && [...value].length <= 12 ? value : "folder";
  const activity = (tx, user, scene, action) =>
    tx.query(
      "INSERT INTO workspace_activity(workspace_id,scene_id,actor_id,action) VALUES($1,$2,$3,$4)",
      [scene.workspace_id, scene.id, user.id, action],
    );
  const title = (value) => {
    if (typeof value !== "string") fail(400, "A name is required.");
    const name = value.trim();
    if (!name || [...name].length > 80)
      fail(400, "Use a name of 1–80 characters.");
    return name;
  };
  const idempotent = async (req, kind, run) => {
    const key = req.get("Idempotency-Key");
    if (!uuid(key)) fail(400, "A UUID Idempotency-Key is required.");
    const fingerprint = sha256(JSON.stringify(req.body));
    return transaction(db, async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        req.user.id + key,
      ]);
      const old = await tx.query(
        "SELECT * FROM creation_requests WHERE user_id=$1 AND request_id=$2",
        [req.user.id, key],
      );
      if (old.rows[0]) {
        if (
          old.rows[0].kind !== kind ||
          old.rows[0].fingerprint !== fingerprint
        )
          fail(409, "Idempotency key was already used for another request.");
        return old.rows[0].result;
      }
      const result = await run(tx);
      await tx.query(
        "INSERT INTO creation_requests(user_id,request_id,kind,fingerprint,result) VALUES($1,$2,$3,$4,$5)",
        [req.user.id, key, kind, fingerprint, result],
      );
      return result;
    });
  };
  app.get("/api/workspaces/:id/collections", auth, async (req, res) => {
    await permit(req.user, req.params.id, "collection.read");
    const { rows } = await db.query(
      `SELECT c.*,count(s.id)::int AS scene_count FROM collections c
   LEFT JOIN collection_drawings cd ON cd.collection_id=c.id
   LEFT JOIN scenes s ON s.id=cd.drawing_id AND s.deleted_at IS NULL AND ${visibility}
   WHERE c.workspace_id=$3 AND c.deleted_at IS NULL AND (NOT c.is_private OR c.created_by=$1 OR $2) AND ${collectionTeamVisibility}
   GROUP BY c.id ORDER BY c.position,c.created_at LIMIT 100 OFFSET $4`,
      [
        req.user.id,
        req.user.is_superadmin,
        req.params.id,
        Math.max(0, Number(req.query.page) || 0) * 100,
      ],
    );
    res.json(rows);
  });
  app.post("/api/workspaces/:id/collections", auth, async (req, res) => {
    await permit(req.user, req.params.id, "collection.create");
    const name = title(req.body?.name);
    const result = await idempotent(req, "collection", async (tx) => {
      const { rows } = await tx.query(
        `INSERT INTO collections(workspace_id,name,normalized_name,created_by,icon) VALUES($1,$2,lower(normalize($2,NFKC)),$3,$4) RETURNING *`,
        [req.params.id, name, req.user.id, collectionIcon(req.body.icon)],
      );
      return rows[0];
    });
    res.status(201).json(result);
  });
  app.patch("/api/collections/:id", auth, async (req, res) => {
    await collectionAccess(req.user, req.params.id, "collection.rename");
    const { rows } = await db.query(
      `UPDATE collections SET name=$2,normalized_name=lower(normalize($2,NFKC)),version=version+1,icon=$4 WHERE id=$1 AND version=$3 AND deleted_at IS NULL RETURNING *`,
      [
        req.params.id,
        title(req.body?.name),
        req.body?.version,
        collectionIcon(req.body.icon),
      ],
    );
    if (!rows[0]) fail(409, "This collection changed. Reload before renaming.");
    res.json(rows[0]);
  });
  app.delete("/api/collections/:id", auth, async (req, res) => {
    await transaction(db, async (tx) => {
      await collectionAccess(
        req.user,
        req.params.id,
        "collection.delete",
        tx,
        true,
      );
      await tx.query("UPDATE collections SET deleted_at=now() WHERE id=$1", [
        req.params.id,
      ]);
    });
    res.json({ ok: true });
  });
  app.post("/api/collections/:id/restore", auth, async (req, res) => {
    const { rows } = await db.query(
      `SELECT c.* FROM collections c WHERE c.id=$3 AND ${collectionTeamVisibility}`,
      [req.user.id, req.user.is_superadmin, req.params.id],
    );
    const col = rows[0];
    if (
      !col ||
      (col.is_private &&
        col.created_by !== req.user.id &&
        !req.user.is_superadmin)
    )
      fail(404, "Collection not found.");
    await permit(req.user, col.workspace_id, "collection.delete");
    await db.query("UPDATE collections SET deleted_at=NULL WHERE id=$1", [
      col.id,
    ]);
    res.json({ ok: true });
  });
  app.get("/api/workspaces/:id/trashed-collections", auth, async (req, res) => {
    await permit(req.user, req.params.id, "trash.read");
    const { rows } = await db.query(
      `SELECT c.id,c.name,c.icon,c.deleted_at FROM collections c WHERE c.workspace_id=$3 AND c.deleted_at IS NOT NULL AND (NOT c.is_private OR c.created_by=$1 OR $2) AND ${collectionTeamVisibility} ORDER BY c.deleted_at DESC`,
      [req.user.id, req.user.is_superadmin, req.params.id],
    );
    res.json(rows);
  });
  app.put("/api/collections/:id/drawings", auth, async (req, res) => {
    const { drawing_ids, remove = false } = req.body || {};
    if (
      !Array.isArray(drawing_ids) ||
      drawing_ids.length > 100 ||
      drawing_ids.some((id) => !uuid(id))
    )
      fail(400, "Select up to 100 valid drawings.");
    await transaction(db, async (tx) => {
      const col = await collectionAccess(
        req.user,
        req.params.id,
        remove ? "collection.remove" : "collection.add",
        tx,
        true,
      );
      for (const id of [...new Set(drawing_ids)].sort()) {
        const { scene } = await sceneAccess(req.user, id, "drawing.read", tx);
        if (scene.workspace_id !== col.workspace_id)
          fail(404, "Drawing not found in this workspace.");
        if (remove)
          await tx.query(
            "DELETE FROM collection_drawings WHERE collection_id=$1 AND drawing_id=$2",
            [col.id, id],
          );
        else
          await tx.query(
            "INSERT INTO collection_drawings(workspace_id,collection_id,drawing_id,added_by) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
            [col.workspace_id, col.id, id, req.user.id],
          );
      }
    });
    res.json({ ok: true });
  });
  app.get("/api/scenes", auth, async (req, res) => {
    const workspace = req.query.workspace,
      trash = req.query.trashed === "1";
    const permissions = await permit(
      req.user,
      workspace,
      trash ? "trash.read" : "drawing.read",
    );
    if (req.query.collection)
      await collectionAccess(req.user, req.query.collection, "collection.read");
    const sort =
      {
        updated: "s.updated_at DESC,s.id",
        created: "s.created_at DESC,s.id",
        visited: "v.visited_at DESC NULLS LAST,s.id",
        title: "lower(s.name),s.id",
      }[req.query.sort] || "s.updated_at DESC,s.id";
    const page = Math.max(0, Number(req.query.page) || 0),
      limit = Math.min(100, Math.max(1, Number(req.query.limit) || 24));
    const { rows } = await db.query(
      `SELECT s.id,s.name,s.workspace_id,s.updated_at,s.created_at,s.scene_version,s.metadata_version,s.thumb_s3_key,s.owner_id,s.pinned,s.private_owner_id,s.deleted_at,v.visited_at,u.username AS owner_name,
   coalesce((SELECT jsonb_agg(jsonb_build_object('id',c.id,'name',c.name)) FROM collection_drawings cd JOIN collections c ON c.id=cd.collection_id WHERE cd.drawing_id=s.id AND c.deleted_at IS NULL AND (NOT c.is_private OR c.created_by=$1 OR $2) AND ${collectionTeamVisibility}),'[]') AS collections,
   count(*) OVER() AS total FROM scenes s JOIN users u ON u.id=s.owner_id LEFT JOIN scene_visits v ON v.scene_id=s.id AND v.user_id=$1 WHERE s.workspace_id=$3 AND ${visibility}
   AND (($4 AND s.deleted_at IS NOT NULL) OR (NOT $4 AND s.deleted_at IS NULL))
   AND ($5::uuid IS NULL OR EXISTS(SELECT 1 FROM collection_drawings cd WHERE cd.drawing_id=s.id AND cd.collection_id=$5))
   AND (NOT $6 OR NOT EXISTS(SELECT 1 FROM collection_drawings cd JOIN collections c ON c.id=cd.collection_id WHERE cd.drawing_id=s.id AND c.deleted_at IS NULL))
   AND (NOT $10 OR s.private_owner_id=$1) AND (NOT $11 OR coalesce(s.updated_by,s.owner_id)=$1) AND (NOT $12 OR v.visited_at IS NOT NULL)
   AND s.name ILIKE $7 ORDER BY s.pinned DESC,${sort} LIMIT $8 OFFSET $9`,
      [
        req.user.id,
        req.user.is_superadmin,
        workspace,
        trash,
        req.query.collection || null,
        req.query.unorganized === "1",
        `%${String(req.query.search || "").slice(0, 100)}%`,
        limit,
        page * limit,
        req.query.private === "1",
        req.query.mine === "1",
        req.query.sort === "visited",
      ],
    );
    res.json({
      items: rows,
      total: Number(rows[0]?.total || 0),
      page,
      limit,
      permissions,
    });
  });
  const empty = {
    type: "excalidraw",
    version: 2,
    elements: [],
    appState: {},
    files: {},
  };
  const validateScene = (payload) => {
    if (
      !payload ||
      !Array.isArray(payload.elements) ||
      typeof payload.appState !== "object" ||
      payload.appState === null ||
      typeof payload.files !== "object" ||
      payload.files === null ||
      Array.isArray(payload.files)
    )
      fail(400, "Invalid Excalidraw scene.");
    for (const element of payload.elements)
      if (
        element.type === "image" &&
        !element.isDeleted &&
        (!payload.files[element.fileId]?.dataURL ||
          !/^data:image\//.test(payload.files[element.fileId].dataURL))
      )
        fail(
          400,
          "A referenced image is missing. Include every image before saving.",
        );
    return {
      type: "excalidraw",
      version: 2,
      source: "self-hosted",
      elements: payload.elements,
      appState: {
        viewBackgroundColor: payload.appState.viewBackgroundColor,
        gridSize: payload.appState.gridSize,
        gridStep: payload.appState.gridStep,
      },
      files: payload.files,
    };
  };
  const readScene = async (scene) => {
    const body = await storage.read(scene.s3_key);
    if (body === null && scene.scene_version === 0) return empty;
    if (body === null)
      fail(
        503,
        "Saved drawing data is unavailable. Try again; do not overwrite it.",
      );
    try {
      return JSON.parse(body.toString("utf8"));
    } catch {
      fail(
        409,
        "This legacy drawing is encrypted. Open its authorized collaboration room.",
      );
    }
  };
  const create = async (req, tx, payload = empty) => {
    const workspace = req.body.workspace_id;
    await permit(req.user, workspace, "drawing.create", tx);
    const collection = req.body.collection_id;
    if (collection && req.body.private === true)
      fail(400, "Choose Private or a collection, not both.");
    if (collection) {
      const col = await collectionAccess(
        req.user,
        collection,
        "collection.add",
        tx,
        true,
      );
      if (col.workspace_id !== workspace)
        fail(400, "Collection belongs to another workspace.");
    }
    const id = crypto.randomUUID(),
      key = `scenes/${id}/${crypto.randomUUID()}.json`;
    await storage.put(
      key,
      Buffer.from(JSON.stringify(payload)),
      "application/json",
    );
    const { rows } = await tx.query(
      "INSERT INTO scenes(id,workspace_id,owner_id,name,s3_key,scene_version,private_owner_id) VALUES($1,$2,$3,$4,$5,1,$6) RETURNING *",
      [
        id,
        workspace,
        req.user.id,
        title(req.body.name || "Untitled scene"),
        key,
        req.body.private === true ? req.user.id : null,
      ],
    );
    if (collection)
      await tx.query(
        "INSERT INTO collection_drawings(workspace_id,collection_id,drawing_id,added_by) VALUES($1,$2,$3,$4)",
        [workspace, collection, id, req.user.id],
      );
    await tx.query(
      "INSERT INTO scene_versions(scene_id,s3_key,scene_version,created_by) VALUES($1,$2,1,$3)",
      [id, key, req.user.id],
    );
    await activity(tx, req.user, rows[0], "created");
    return rows[0];
  };
  app.post("/api/scenes", auth, async (req, res) => {
    if (req.body?.scene)
      await permit(req.user, req.body.workspace_id, "drawing.import");
    const result = await idempotent(req, "drawing", (tx) =>
      create(req, tx, req.body.scene ? validateScene(req.body.scene) : empty),
    );
    res.status(201).json(result);
  });
  app.get("/api/scenes/:id/data", auth, async (req, res) => {
    const { scene, permissions } = await sceneAccess(req.user, req.params.id);
    await db.query(
      "INSERT INTO scene_visits(user_id,scene_id) VALUES($1,$2) ON CONFLICT(user_id,scene_id) DO UPDATE SET visited_at=now()",
      [req.user.id, scene.id],
    );
    const savedRoom = await transaction(db, async (tx) => {
      const locked = (
        await tx.query("SELECT room_id FROM scenes WHERE id=$1 FOR UPDATE", [
          scene.id,
        ])
      ).rows[0];
      if (locked.room_id) {
        return (
          await tx.query(
            "SELECT room_id,encrypted_key FROM scene_room_keys WHERE scene_id=$1 AND room_id=$2",
            [scene.id, locked.room_id],
          )
        ).rows[0];
      }
      // Match the editor's own format (excalidraw-app/data/index.ts): a room id
      // of 10 random bytes as hex, and a 128-bit AES-GCM key as the 22-character
      // base64url JWK `k` value. The editor rejects any other key length with
      // "Encryption key must be of 22 characters".
      const roomId = crypto.randomBytes(10).toString("hex"),
        roomKey = crypto.randomBytes(16).toString("base64url"),
        encryptedKey = protectSecret(roomKey);
      await tx.query("UPDATE scenes SET room_id=$2 WHERE id=$1", [
        scene.id,
        roomId,
      ]);
      await tx.query(
        "INSERT INTO scene_room_keys(scene_id,room_id,encrypted_key) VALUES($1,$2,$3)",
        [scene.id, roomId, encryptedKey],
      );
      return { room_id: roomId, encrypted_key: encryptedKey };
    });
    const roomId = savedRoom?.room_id || scene.room_id;
    res.json({
      id: scene.id,
      name: scene.name,
      metadata_version: scene.metadata_version,
      room_id: roomId,
      collaboration: savedRoom
        ? {
            roomId: savedRoom.room_id,
            roomKey: revealSecret(savedRoom.encrypted_key),
          }
        : null,
      workspace_id: scene.workspace_id,
      // imported drawings have no preview until the editor renders one
      has_thumbnail: Boolean(scene.thumb_s3_key),
      version: scene.scene_version,
      permissions: {
        ...permissions,
        "drawing.edit":
          permissions["drawing.edit"] &&
          (req.user.is_superadmin || scene.explicit_permission !== "view"),
      },
      scene: await readScene(scene),
    });
  });
  app.put("/api/scenes/:id/data", auth, async (req, res) => {
    let payload = validateScene(req.body?.scene);
    const expected = req.body?.version;
    if (!Number.isSafeInteger(expected) || expected < 0)
      fail(400, "Expected scene version is required.");
    const result = await transaction(db, async (tx) => {
      await tx.query("SELECT id FROM scenes WHERE id=$1 FOR UPDATE", [
        req.params.id,
      ]);
      const { scene } = await sceneAccess(
        req.user,
        req.params.id,
        "drawing.edit",
        tx,
      );
      const collaborative = Boolean(
        scene.room_id && req.body.room_id === scene.room_id,
      );
      if (
        expected > scene.scene_version ||
        (scene.scene_version !== expected && !collaborative)
      )
        fail(
          409,
          "Drawing changed on the server. Reload or save your draft as a copy.",
        );
      if (collaborative)
        payload = validateScene(
          mergeSceneSnapshots(await readScene(scene), payload),
        );
      const nextVersion = scene.scene_version + 1;
      const key = `scenes/${scene.id}/${crypto.randomUUID()}.json`,
        body = Buffer.from(JSON.stringify(payload));
      // Immutable object first, pointer/version second. Failed transactions never damage the old object.
      await storage.put(key, body, "application/json");
      await tx.query(
        "UPDATE scenes SET s3_key=$2,scene_version=scene_version+1,size_bytes=$3,updated_by=$4 WHERE id=$1",
        [scene.id, key, body.length, req.user.id],
      );
      await tx.query(
        "INSERT INTO scene_versions(scene_id,s3_key,scene_version,size_bytes,created_by) VALUES($1,$2,$3,$4,$5)",
        [scene.id, key, nextVersion, body.length, req.user.id],
      );
      await activity(tx, req.user, scene, "edited");
      return {
        version: nextVersion,
        ...(collaborative ? { scene: payload } : {}),
      };
    });
    res.json(result);
  });
  app.get("/api/scenes/:id/versions", auth, async (req, res) => {
    const { scene } = await sceneAccess(req.user, req.params.id);
    const { rows } = await db.query(
      "SELECT v.id,v.scene_version,v.created_at,u.username FROM scene_versions v LEFT JOIN users u ON u.id=v.created_by WHERE v.scene_id=$1 ORDER BY v.scene_version DESC LIMIT 100",
      [scene.id],
    );
    res.json({ current: scene.scene_version, items: rows });
  });
  app.post(
    "/api/scenes/:id/versions/:version/restore",
    auth,
    async (req, res) => {
      const result = await transaction(db, async (tx) => {
        await tx.query("SELECT id FROM scenes WHERE id=$1 FOR UPDATE", [
          req.params.id,
        ]);
        const { scene } = await sceneAccess(
          req.user,
          req.params.id,
          "drawing.edit",
          tx,
        );
        if (scene.scene_version !== req.body?.version)
          fail(409, "Scene changed. Reload version history and try again.");
        const { rows } = await tx.query(
          "SELECT * FROM scene_versions WHERE scene_id=$1 AND id=$2",
          [scene.id, req.params.version],
        );
        if (!rows[0]) fail(404, "Version not found.");
        await tx.query("DELETE FROM scene_room_keys WHERE scene_id=$1", [
          scene.id,
        ]);
        if (!(await storage.read(rows[0].s3_key)))
          fail(503, "This saved version is unavailable.");
        await tx.query(
          "UPDATE scenes SET s3_key=$2,scene_version=scene_version+1,thumb_s3_key=NULL,room_id=NULL,collab_s3_key=NULL,updated_by=$3 WHERE id=$1",
          [scene.id, rows[0].s3_key, req.user.id],
        );
        await tx.query(
          "INSERT INTO scene_versions(scene_id,s3_key,scene_version,created_by) VALUES($1,$2,$3,$4)",
          [scene.id, rows[0].s3_key, scene.scene_version + 1, req.user.id],
        );
        await activity(tx, req.user, scene, "restored");
        return { version: scene.scene_version + 1 };
      });
      res.json(result);
    },
  );
  app.patch("/api/scenes/:id", auth, async (req, res) => {
    await sceneAccess(req.user, req.params.id, "drawing.rename");
    if (typeof req.body.pinned === "boolean") {
      const { rows } = await db.query(
        "UPDATE scenes SET pinned=$2,metadata_version=metadata_version+1 WHERE id=$1 AND metadata_version=$3 RETURNING *",
        [req.params.id, req.body.pinned, req.body.version],
      );
      if (!rows[0]) fail(409, "Drawing changed. Reload and try again.");
      return res.json(rows[0]);
    }
    const { rows } = await db.query(
      "UPDATE scenes SET name=$2,metadata_version=metadata_version+1 WHERE id=$1 AND metadata_version=$3 RETURNING *",
      [req.params.id, title(req.body?.name), req.body?.version],
    );
    if (!rows[0])
      fail(409, "Drawing metadata changed. Reload before renaming.");
    res.json(rows[0]);
  });
  app.delete("/api/scenes/:id", auth, async (req, res) => {
    await sceneAccess(req.user, req.params.id, "drawing.trash");
    await db.query("UPDATE scenes SET deleted_at=now() WHERE id=$1", [
      req.params.id,
    ]);
    res.json({ ok: true });
  });
  app.post("/api/scenes/:id/restore", auth, async (req, res) => {
    await sceneAccess(req.user, req.params.id, "drawing.restore", db, true);
    await db.query("UPDATE scenes SET deleted_at=NULL WHERE id=$1", [
      req.params.id,
    ]);
    res.json({ ok: true });
  });
  app.post("/api/scenes/:id/duplicate", auth, async (req, res) => {
    const { scene } = await sceneAccess(
      req.user,
      req.params.id,
      "drawing.duplicate",
    );
    req.body.workspace_id = scene.workspace_id;
    const result = await idempotent(req, "duplicate", async (tx) =>
      create(req, tx, await readScene(scene)),
    );
    res.status(201).json(result);
  });
  app.get("/api/scenes/:id/export", auth, async (req, res) => {
    const { scene } = await sceneAccess(
      req.user,
      req.params.id,
      "drawing.export",
    );
    res.set(
      "Content-Disposition",
      `attachment; filename="drawing-${scene.id}.excalidraw"`,
    );
    res.json(await readScene(scene));
  });
  app.post("/api/scenes/:id/thumbnail", auth, async (req, res) => {
    await sceneAccess(req.user, req.params.id, "drawing.edit");
    const version = Number(req.query.version);
    if (
      !Number.isSafeInteger(version) ||
      !Buffer.isBuffer(req.body) ||
      !req.body.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
    )
      fail(400, "Invalid PNG thumbnail.");
    const key = `thumbnails/${
      req.params.id
    }/${version}-${crypto.randomUUID()}.png`;
    await storage.put(key, req.body, "image/png");
    await db.query(
      "UPDATE scenes SET thumb_s3_key=$2 WHERE id=$1 AND scene_version=$3",
      [req.params.id, key, version],
    );
    res.json({ ok: true });
  });
  app.get("/api/scenes/:id/thumbnail", auth, async (req, res) => {
    const { scene } = await sceneAccess(
      req.user,
      req.params.id,
      "drawing.read",
      db,
      true,
    );
    if (scene.deleted_at)
      await permit(req.user, scene.workspace_id, "trash.read");
    if (!scene.thumb_s3_key) return res.sendStatus(404);
    res.type("png");
    if (!(await storage.pipe(scene.thumb_s3_key, res))) res.sendStatus(404);
  });

  app.post("/api/scenes/bulk", auth, async (req, res) => {
    const { ids, action } = req.body || {};
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 100 ||
      ids.some((id) => !uuid(id)) ||
      !["trash", "restore"].includes(action)
    )
      fail(400, "Select 1–100 scenes and a valid action.");
    await transaction(db, async (tx) => {
      for (const id of [...new Set(ids)].sort()) {
        await tx.query("SELECT id FROM scenes WHERE id=$1 FOR UPDATE", [id]);
        await sceneAccess(
          req.user,
          id,
          action === "trash" ? "drawing.trash" : "drawing.restore",
          tx,
          action === "restore",
        );
      }
      await tx.query(
        `UPDATE scenes SET deleted_at=${
          action === "trash" ? "now()" : "NULL"
        } WHERE id=ANY($1::uuid[])`,
        [ids],
      );
    });
    res.json({ ok: true });
  });
  app.post("/api/scenes/:id/move", auth, async (req, res) => {
    await transaction(db, async (tx) => {
      await tx.query("SELECT id FROM scenes WHERE id=$1 FOR UPDATE", [
        req.params.id,
      ]);
      const { scene } = await sceneAccess(
        req.user,
        req.params.id,
        "drawing.edit",
        tx,
      );
      await permit(req.user, scene.workspace_id, "collection.remove", tx);
      if (scene.metadata_version !== req.body.version)
        fail(409, "Drawing changed. Reload before moving.");
      const destination = req.body.collection_id;
      if (destination && req.body.private === true)
        fail(400, "Choose Private or a collection, not both.");
      if (destination) {
        const col = await collectionAccess(
          req.user,
          destination,
          "collection.add",
          tx,
          true,
        );
        if (col.workspace_id !== scene.workspace_id)
          fail(404, "Collection not found.");
      } else if (req.body.private !== true)
        fail(400, "Select a target collection.");
      if (req.body.private === true && scene.owner_id !== req.user.id)
        fail(403, "Only the owner can move this drawing to Private.");
      await tx.query("DELETE FROM collection_drawings WHERE drawing_id=$1", [
        scene.id,
      ]);
      if (destination)
        await tx.query(
          "INSERT INTO collection_drawings(workspace_id,collection_id,drawing_id,added_by) VALUES($1,$2,$3,$4)",
          [scene.workspace_id, destination, scene.id, req.user.id],
        );
      await tx.query(
        "UPDATE scenes SET collection_id=$2,private_owner_id=$3,metadata_version=metadata_version+1 WHERE id=$1",
        [
          scene.id,
          destination || null,
          req.body.private === true ? req.user.id : null,
        ],
      );
      await activity(tx, req.user, scene, "moved");
    });
    res.json({ ok: true });
  });
  app.get("/api/workspaces/:id/activity", auth, async (req, res) => {
    await permit(req.user, req.params.id, "drawing.read");
    const { rows } = await db.query(
      `SELECT a.id,a.action,a.created_at,s.id AS scene_id,s.name,u.display_name,u.username FROM workspace_activity a JOIN scenes s ON s.id=a.scene_id JOIN users u ON u.id=a.actor_id WHERE a.workspace_id=$3 AND s.deleted_at IS NULL AND ${visibility} ORDER BY a.created_at DESC LIMIT 30`,
      [req.user.id, req.user.is_superadmin, req.params.id],
    );
    res.json(rows);
  });
  return { sceneAccess, readScene, create, validateScene, collectionAccess };
}
