import crypto from "node:crypto";

// A scene used to carry every image inside it as base64. A drawing with 109
// images was 27 MB, each save rewrote all of it, and a collaborative save read
// it back first, blocking the event loop while it parsed. The bytes now live
// once per workspace under their own digest and the scene keeps references.
//
// Both shapes are readable. A scene with no blobRefs and dataURLs in files is
// an older one and is returned unchanged, which is what lets the backfill run
// against a live workspace and stop halfway without harm.

const DATA_URL = /^data:([^;,]+);base64,(.+)$/s;
// The same icons recur across a workspace, so a small cache turns most reads of
// a shared drawing into no object reads at all.
const FETCH_CONCURRENCY = Math.max(1, Number(process.env.BLOB_FETCH_CONCURRENCY) || 24);
const CACHE_BYTES = Math.max(
  16 * 1024 * 1024,
  Number(process.env.BLOB_CACHE_BYTES) || 192 * 1024 * 1024,
);

export function installSceneBlobs(db, storage, { cacheBytes = CACHE_BYTES } = {}) {
  const cache = new Map();
  const limit = Math.max(1, cacheBytes);
  let held = 0;

  const remember = (sha256, dataURL) => {
    if (dataURL.length > limit) return;
    if (cache.has(sha256)) cache.delete(sha256);
    cache.set(sha256, dataURL);
    held += dataURL.length;
    // Least recently used first; Map preserves insertion order.
    for (const key of cache.keys()) {
      if (held <= limit) break;
      held -= cache.get(key).length;
      cache.delete(key);
    }
  };
  const recall = (sha256) => {
    const hit = cache.get(sha256);
    if (hit === undefined) return undefined;
    cache.delete(sha256);
    cache.set(sha256, hit);
    return hit;
  };

  // Returns the scene as it should be stored, plus the references to record.
  // Uploading happens here and must stay outside any database transaction: an
  // upload takes seconds, and holding a row lock across it made every other
  // save of the same drawing queue behind it. Writing a blob that a failed save
  // never references is harmless, because the key is the digest and an unused
  // one is simply collectable.
  const split = async (workspace, scene, { mayUpload = true } = {}) => {
    const files = scene.files || {};
    const blobRefs = { ...(scene.blobRefs || {}) };
    const stored = [];
    for (const [fileId, file] of Object.entries(files)) {
      const match = typeof file?.dataURL === "string" && DATA_URL.exec(file.dataURL);
      if (!match) continue;
      const mime = match[1];
      const bytes = Buffer.from(match[2], "base64");
      const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
      const key = `blobs/${workspace}/${sha256}`;
      const { rowCount } = await db.query(
        `INSERT INTO workspace_blobs(workspace_id,sha256,mime,size_bytes,s3_key)
         VALUES($1,$2,$3,$4,$5) ON CONFLICT (workspace_id,sha256) DO NOTHING`,
        [workspace, sha256, mime, bytes.length, key],
      );
      // The key is the digest, so writing the same bytes twice is harmless and
      // needs no coordination between concurrent saves.
      if (rowCount) {
        // Callers inside a transaction hold a row lock, and an upload there
        // once blocked every other save of the drawing for minutes. Refuse
        // rather than do it quietly, so the mistake cannot be reintroduced.
        if (!mayUpload)
          throw new Error(
            "an image reached storage inside a transaction; upload before it opens",
          );
        await storage.put(key, bytes, mime);
      }
      remember(sha256, file.dataURL);
      // Everything except the bytes is kept, so a reader gets back the entry it
      // saved rather than one rebuilt from guesses.
      const { dataURL, ...rest } = file;
      blobRefs[fileId] = { ...rest, sha256, mimeType: mime };
      stored.push({ fileId, sha256 });
    }
    // Anything that was already a reference stays one.
    for (const [fileId, ref] of Object.entries(scene.blobRefs || {}))
      if (!blobRefs[fileId]) blobRefs[fileId] = ref;
    return {
      payload: { ...scene, files: {}, blobRefs },
      refs: Object.entries(blobRefs).map(([fileId, ref]) => ({
        fileId,
        sha256: ref.sha256,
      })),
      splitCount: stored.length,
    };
  };

  // Records which blobs a scene uses. Replaces the set, so a removed image
  // stops being referenced and becomes collectable.
  const record = async (tx, scene, workspace, refs) => {
    await tx.query("DELETE FROM scene_blob_refs WHERE scene_id=$1", [scene]);
    if (!refs.length) return;
    await tx.query(
      `INSERT INTO scene_blob_refs(scene_id,workspace_id,file_id,sha256)
       SELECT $1,$2,f.file_id,f.sha256
       FROM unnest($3::text[],$4::text[]) AS f(file_id,sha256)
       ON CONFLICT (scene_id,file_id) DO UPDATE SET sha256=EXCLUDED.sha256`,
      [scene, workspace, refs.map((r) => r.fileId), refs.map((r) => r.sha256)],
    );
  };

  // Rebuilds the files map a reader expects. A reference that cannot be
  // resolved is an error, never a silently missing image.
  const hydrate = async (workspace, scene) => {
    const refs = scene?.blobRefs;
    if (!refs || !Object.keys(refs).length) return scene;
    const files = { ...(scene.files || {}) };
    // What this read needs is held here, not in the shared cache. The cache can
    // evict at any time, including an image this same read fetched a moment
    // ago, which showed up as a drawing refusing to open.
    const resolved = new Map();
    const wanted = [];
    for (const sha of new Set(Object.values(refs).map((r) => r.sha256))) {
      const cached = recall(sha);
      if (cached === undefined) wanted.push(sha);
      else resolved.set(sha, cached);
    }
    if (wanted.length) {
      const { rows } = await db.query(
        "SELECT sha256,mime,s3_key FROM workspace_blobs WHERE workspace_id=$1 AND sha256 = ANY($2::text[])",
        [workspace, wanted],
      );
      const known = new Map(rows.map((r) => [r.sha256, r]));
      // A drawing can reference a hundred images. Read them together: one at a
      // time costs a round trip each, which on a cold cache was slower than
      // carrying the images inside the scene ever was.
      const queue = [...wanted];
      const workers = Array.from(
        { length: Math.min(FETCH_CONCURRENCY, queue.length) },
        async () => {
          for (;;) {
            const sha256 = queue.shift();
            if (!sha256) return;
            const row = known.get(sha256);
            if (!row) throw new Error(`image ${sha256.slice(0, 12)} is not stored`);
            const body = await storage.read(row.s3_key);
            if (body === null)
              throw new Error(`image ${sha256.slice(0, 12)} is missing from storage`);
            const dataURL = `data:${row.mime};base64,${body.toString("base64")}`;
            resolved.set(sha256, dataURL);
            remember(sha256, dataURL);
          }
        },
      );
      await Promise.all(workers);
    }
    for (const [fileId, ref] of Object.entries(refs)) {
      const dataURL = resolved.get(ref.sha256);
      if (dataURL === undefined)
        throw new Error(`image ${ref.sha256.slice(0, 12)} could not be read`);
      const { sha256, ...rest } = ref;
      files[fileId] = { ...rest, dataURL };
    }
    const { blobRefs, ...rest } = scene;
    return { ...rest, files };
  };

  // Resolves one image for a reader, returning only what is needed to serve it.
  // Deliberately a single indexed query: a drawing can reference a hundred
  // images, so the editor asks for a hundred of these at once, and anything
  // slower here becomes a queue on the connection pool.
  const locate = async (user, workspace, sha256) => {
    if (!/^[0-9a-f]{64}$/.test(String(sha256 || ""))) return null;
    const { rows } = await db.query(
      `SELECT b.s3_key, b.mime
         FROM workspace_blobs b
         JOIN scene_blob_refs r
           ON r.workspace_id = b.workspace_id AND r.sha256 = b.sha256
         JOIN scenes s ON s.id = r.scene_id
         -- an administrator reaches a workspace without a membership row, the
         -- same way every other read here does
         LEFT JOIN workspace_members m
           ON m.workspace_id = s.workspace_id AND m.user_id = $1
        WHERE b.workspace_id = $2
          AND (m.user_id IS NOT NULL OR $4::boolean)
          AND b.sha256 = $3
          AND s.deleted_at IS NULL
          -- a private drawing is readable only by its owner, so holding the
          -- digest of its image is not enough to be shown it
          AND (s.private_owner_id IS NULL OR s.private_owner_id = $1 OR $4::boolean)
        LIMIT 1`,
      [user.id, workspace, sha256, Boolean(user.is_superadmin)],
    );
    return rows[0] || null;
  };

  return {
    split,
    record,
    hydrate,
    locate,
    stats: () => ({ entries: cache.size, bytes: held }),
  };
}
