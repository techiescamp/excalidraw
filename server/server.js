import { installWorkspaceDeletion } from "./lib/workspace-deletion.js";
import { installWorkspaceTransfer } from "./lib/workspace-transfer.js";
import { installTeams } from "./lib/teams.js";
import { createServer } from "node:http";
import { installCollaboration } from "./lib/collaboration.js";
import { installAuth } from "./lib/auth.js";
import { installDrawings } from "./lib/drawings.js";
import express from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  PutBucketCorsCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const {
  PORT = 4000,
  DATABASE_URL,
  JWT_SECRET,
  APP_ORIGIN,
  S3_BUCKET,
  AWS_REGION,
  S3_ENDPOINT,
  S3_FORCE_PATH_STYLE,
  PRESIGN_TTL_SECONDS = 300,
  COOKIE_SECURE = "true",
} = process.env;

const db = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });

// ── storage driver ───────────────────────────────────────────────────────────
// S3/Spaces when credentials are present; local disk otherwise, so the instance
// is fully functional before object storage is provisioned. Both drivers expose
// presigned PUT/GET so the browser upload path is identical either way.
const LOCAL_ROOT = process.env.LOCAL_STORAGE_ROOT || "/opt/excalidraw/storage";

const realKey = (k) => Boolean(k && !/^REPLACE_ME$|^<.*>$/.test(k));

// Secrets at rest: AES-256-GCM under a key derived from JWT_SECRET, so a
// database dump alone does not hand over the object-store credentials.
const secretKey = () => crypto.createHash("sha256").update(JWT_SECRET).digest();
const encryptSecret = (plain) => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", secretKey(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
};
const decryptSecret = (blob) => {
  const raw = Buffer.from(blob, "base64");
  const d = crypto.createDecipheriv(
    "aes-256-gcm",
    secretKey(),
    raw.subarray(0, 12),
  );
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString(
    "utf8",
  );
};

// Current backend. Starts from the environment, then whatever the dashboard
// has saved takes precedence.
const store = {
  driver: "local",
  client: null,
  bucket: null,
  region: null,
  endpoint: null,
  keyId: null,
};

const buildClient = (cfg) =>
  new S3Client({
    region: cfg.region,
    ...(cfg.endpoint
      ? { endpoint: cfg.endpoint, forcePathStyle: cfg.forcePathStyle === true }
      : {}),
    credentials: { accessKeyId: cfg.keyId, secretAccessKey: cfg.secret },
  });

const applyStorage = (cfg) => {
  if (!cfg || !realKey(cfg.keyId) || !cfg.secret || !cfg.bucket) {
    store.driver = "local";
    store.client = null;
    store.bucket = store.region = store.endpoint = store.keyId = null;
    return;
  }
  store.driver = "s3";
  store.client = buildClient(cfg);
  store.bucket = cfg.bucket;
  store.region = cfg.region;
  store.endpoint = cfg.endpoint ?? null;
  store.keyId = cfg.keyId;
};

const envStorage = () => ({
  keyId: process.env.AWS_ACCESS_KEY_ID,
  secret: process.env.AWS_SECRET_ACCESS_KEY,
  bucket: process.env.S3_BUCKET,
  region: process.env.AWS_REGION,
  endpoint: process.env.S3_ENDPOINT || null,
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
});

const loadStorageFromDb = async () => {
  try {
    const { rows } = await db.query(
      `SELECT value FROM app_settings WHERE key = 'storage'`,
    );
    const saved = rows[0]?.value;
    if (saved?.keyId && saved?.secret_enc) {
      applyStorage({ ...saved, secret: decryptSecret(saved.secret_enc) });
      return;
    }
  } catch (e) {
    console.error("could not read storage settings", e.message);
  }
  applyStorage(envStorage());
};

const hasObjectStore = () => store.driver === "s3";

const localPath = (key) => {
  const safe = path.normalize(key).replace(/^(\.\.(\/|\\|$))+/, "");
  const full = path.join(LOCAL_ROOT, safe);
  if (!full.startsWith(path.resolve(LOCAL_ROOT) + path.sep)) {
    throw new Error("path escapes storage root");
  }
  return full;
};

const signBlob = (key, method, expiresAt) =>
  crypto
    .createHmac("sha256", JWT_SECRET)
    .update(`${method}:${key}:${expiresAt}`)
    .digest("hex");

const localPresign = (key, method) => {
  const exp = Date.now() + TTL * 1000;
  const sig = signBlob(key, method, exp);
  return `${APP_ORIGIN}/api/blob/${key}?exp=${exp}&sig=${sig}`;
};
const TTL = Number(PRESIGN_TTL_SECONDS);

const storage = {
  kind: () => store.driver,

  async read(key) {
    if (hasObjectStore()) {
      try {
        const obj = await store.client.send(
          new GetObjectCommand({ Bucket: store.bucket, Key: key }),
        );
        return Buffer.from(await obj.Body.transformToByteArray());
      } catch (e) {
        if (e.name === "NoSuchKey") return null;
        throw e;
      }
    }
    try {
      return await fsp.readFile(localPath(key));
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  },
  async remove(key) {
    if (hasObjectStore())
      await store.client.send(
        new DeleteObjectCommand({ Bucket: store.bucket, Key: key }),
      );
    else await fsp.rm(localPath(key), { force: true });
  },
  async put(key, body, contentType = "application/octet-stream") {
    if (hasObjectStore()) {
      await store.client.send(
        new PutObjectCommand({
          Bucket: store.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
      return;
    }
    const full = localPath(key);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    const temp = `${full}.${crypto.randomUUID()}.tmp`;
    await fsp.writeFile(temp, body);
    await fsp.rename(temp, full);
  },

  async presignPut(key, contentType = "application/octet-stream") {
    return hasObjectStore()
      ? getSignedUrl(
          store.client,
          new PutObjectCommand({
            Bucket: store.bucket,
            Key: key,
            ContentType: contentType,
          }),
          { expiresIn: TTL },
        )
      : localPresign(key, "PUT");
  },

  async presignGet(key) {
    return hasObjectStore()
      ? getSignedUrl(
          store.client,
          new GetObjectCommand({ Bucket: store.bucket, Key: key }),
          { expiresIn: TTL },
        )
      : localPresign(key, "GET");
  },

  // pipe an object to the response; returns false when it does not exist
  async pipe(key, res) {
    if (hasObjectStore()) {
      try {
        const obj = await store.client.send(
          new GetObjectCommand({ Bucket: store.bucket, Key: key }),
        );
        res.set("Content-Type", obj.ContentType ?? "application/octet-stream");
        obj.Body.pipe(res);
        return true;
      } catch {
        return false;
      }
    }
    const full = localPath(key);
    if (!fs.existsSync(full)) {
      return false;
    }
    res.set("Content-Type", "application/octet-stream");
    fs.createReadStream(full).pipe(res);
    return true;
  },
};
const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");

const app = express();
app.set("trust proxy", "loopback");
app.use(helmet());
app.use(cookieParser());
const notBlob = (req) => !req.path.startsWith("/api/blob/");
app.use(
  express.json({
    limit: "25mb",
    type: (req) => notBlob(req) && Boolean(req.is("application/json")),
  }),
);
app.use(
  express.raw({
    limit: "25mb",
    type: (req) => notBlob(req) && Boolean(req.is("application/octet-stream")),
  }),
);
// blob uploads are opaque bytes whatever content-type the client declares
const rawBlob = express.raw({ type: "*/*", limit: "25mb" });

const security = installAuth(app, db, APP_ORIGIN);
const { auth, admin: requireSuperadmin, recent } = security;
installTeams(app, db, security);
const drawings = installDrawings(app, db, storage, security);
const httpServer = createServer(app);
await installCollaboration(
  app,
  httpServer,
  db,
  storage,
  security,
  drawings,
  APP_ORIGIN,
);
// All private scene/asset reads go through authorization, never bearer presigned URLs.
app.use("/api/admin", (req, res, next) =>
  ["GET", "HEAD"].includes(req.method)
    ? next()
    : auth(req, res, () =>
        requireSuperadmin(req, res, () => recent(req, res, next)),
      ),
);
const audit = (actor, action, type, id, meta = {}) =>
  db.query(
    "INSERT INTO audit_log(actor_id,action,target_type,target_id,metadata) VALUES($1,$2,$3,$4,$5)",
    [actor, action, type, String(id), { ...meta, outcome: "success" }],
  );

installWorkspaceTransfer(app, db, storage, security, drawings);
installWorkspaceDeletion(app, db, storage, security);

// Workspace management uses the same administrator and recent-password gates.
app.get("/api/admin/workspaces", auth, requireSuperadmin, async (_req, res) => {
  const { rows } =
    await db.query(`SELECT w.*, (SELECT count(*)::int FROM workspace_members m WHERE m.workspace_id=w.id) AS members,
 (SELECT count(*)::int FROM scenes s WHERE s.workspace_id=w.id) AS scenes,
 (SELECT count(*)::int FROM collections c WHERE c.workspace_id=w.id) AS collections FROM workspaces w ORDER BY w.created_at`);
  res.json(rows);
});
const workspaceName = (value) =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  [...value.trim()].length <= 80
    ? value.trim()
    : null;
app.post("/api/admin/workspaces", auth, requireSuperadmin, async (req, res) => {
  const name = workspaceName(req.body?.name);
  if (!name)
    return res
      .status(400)
      .json({ error: "Use a workspace name of 1–80 characters." });
  const { rows } = await db.query(
    "INSERT INTO workspaces(name,slug,owner_id) VALUES($1,$2,$3) RETURNING *",
    [name, crypto.randomUUID(), req.user.id],
  );
  await audit(req.user.id, "workspace.create", "workspace", rows[0].id);
  res.status(201).json(rows[0]);
});
app.patch(
  "/api/admin/workspaces/:id",
  auth,
  requireSuperadmin,
  async (req, res) => {
    const name = workspaceName(req.body?.name);
    if (!name)
      return res
        .status(400)
        .json({ error: "Use a workspace name of 1–80 characters." });
    const { rows } = await db.query(
      "UPDATE workspaces SET name=$2 WHERE id=$1 AND deleted_at IS NULL RETURNING *",
      [req.params.id, name],
    );
    if (!rows[0])
      return res.status(404).json({ error: "Workspace not found." });
    await audit(req.user.id, "workspace.rename", "workspace", req.params.id);
    res.json(rows[0]);
  },
);

// ── object storage configuration (superadmin) ───────────────────────────────
app.get("/api/admin/storage", auth, requireSuperadmin, async (_req, res) => {
  const { rows } = await db.query(
    `SELECT value, updated_at FROM app_settings WHERE key = 'storage'`,
  );
  const saved = rows[0]?.value ?? {};
  res.json({
    driver: store.driver,
    bucket: store.bucket ?? saved.bucket ?? "",
    region: store.region ?? saved.region ?? "",
    endpoint: store.endpoint ?? saved.endpoint ?? "",
    keyId: store.keyId ?? saved.keyId ?? "",
    // the secret is never returned, only whether one is held
    hasSecret:
      Boolean(saved.secret_enc) || realKey(process.env.AWS_ACCESS_KEY_ID),
    forcePathStyle: saved.forcePathStyle === true,
    updated_at: rows[0]?.updated_at ?? null,
  });
});

// Validate against the real bucket before persisting: a config that cannot
// round-trip an object would silently break every future save.
const probeStorage = async (cfg) => {
  const client = buildClient(cfg);
  const Key = `_healthcheck-${crypto.randomBytes(6).toString("hex")}`;
  await client.send(
    new PutObjectCommand({
      Bucket: cfg.bucket,
      Key,
      Body: "ok",
      ContentType: "text/plain",
    }),
  );
  const got = await client.send(
    new GetObjectCommand({ Bucket: cfg.bucket, Key }),
  );
  const body = await got.Body.transformToString();
  await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key }));
  if (body !== "ok") {
    throw new Error("round-trip returned unexpected content");
  }
  return client;
};

app.put("/api/admin/storage", auth, requireSuperadmin, async (req, res) => {
  const { bucket, region, endpoint, keyId, secret, forcePathStyle } =
    req.body ?? {};

  if (!bucket || !region || !keyId) {
    return res
      .status(400)
      .json({ error: "bucket, region and key id are required" });
  }

  // allow updating other fields without re-entering the secret
  let effectiveSecret = secret;
  if (!effectiveSecret) {
    const { rows } = await db.query(
      `SELECT value FROM app_settings WHERE key = 'storage'`,
    );
    if (rows[0]?.value?.secret_enc) {
      effectiveSecret = decryptSecret(rows[0].value.secret_enc);
    }
  }
  if (!effectiveSecret) {
    return res.status(400).json({ error: "secret is required" });
  }

  const cfg = {
    bucket: bucket.trim(),
    region: region.trim(),
    endpoint: endpoint?.trim() || null,
    keyId: keyId.trim(),
    secret: effectiveSecret,
    forcePathStyle: forcePathStyle === true,
  };

  try {
    await probeStorage(cfg);
  } catch (e) {
    const hint =
      e.name === "InvalidAccessKeyId"
        ? "That access key ID does not exist. DigitalOcean truncates it in the console list — use the copy button; the full ID is 20 characters."
        : e.name === "SignatureDoesNotMatch"
        ? "The secret does not match that key ID."
        : e.name === "NoSuchBucket"
        ? "No bucket with that name in this region."
        : e.name === "AccessDenied"
        ? "The key exists but is not allowed to write to this bucket."
        : e.message;
    return res.status(400).json({ error: hint, code: e.name ?? "error" });
  }

  await db.query(
    `INSERT INTO app_settings (key, value, updated_by, updated_at)
     VALUES ('storage', $1, $2, now())
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by,
           updated_at = now()`,
    [
      {
        bucket: cfg.bucket,
        region: cfg.region,
        endpoint: cfg.endpoint,
        keyId: cfg.keyId,
        forcePathStyle: cfg.forcePathStyle,
        secret_enc: encryptSecret(cfg.secret),
      },
      req.user.sub,
    ],
  );

  applyStorage(cfg);
  await audit(req.user.sub, "storage.configure", "settings", "storage", {
    bucket: cfg.bucket,
    region: cfg.region,
    endpoint: cfg.endpoint,
  });

  // best-effort: the browser PUTs straight to presigned URLs, so without CORS
  // every upload from the editor fails
  let cors = "applied";
  try {
    await store.client.send(
      new PutBucketCorsCommand({
        Bucket: cfg.bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: [APP_ORIGIN],
              AllowedMethods: ["GET", "PUT", "HEAD"],
              AllowedHeaders: ["*"],
              ExposeHeaders: ["ETag", "Content-Length"],
              MaxAgeSeconds: 3000,
            },
          ],
        },
      }),
    );
  } catch (e) {
    cors = `could not set automatically (${e.name}) — set it in the provider console`;
  }

  res.json({ ok: true, driver: store.driver, cors });
});

// Copy anything written while the local driver was active into the bucket.
app.post(
  "/api/admin/storage/migrate",
  auth,
  requireSuperadmin,
  async (_req, res) => {
    if (!hasObjectStore()) {
      return res
        .status(400)
        .json({ error: "object storage is not configured" });
    }
    const walk = (dir) => {
      const out = [];
      if (!fs.existsSync(dir)) {
        return out;
      }
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          out.push(...walk(full));
        } else {
          out.push(full);
        }
      }
      return out;
    };
    const files = walk(LOCAL_ROOT);
    let copied = 0;
    const failed = [];
    for (const full of files) {
      const key = path.relative(LOCAL_ROOT, full).split(path.sep).join("/");
      try {
        await store.client.send(
          new PutObjectCommand({
            Bucket: store.bucket,
            Key: key,
            Body: await fsp.readFile(full),
          }),
        );
        copied += 1;
      } catch (e) {
        failed.push({ key, error: e.name ?? e.message });
      }
    }
    await audit(_req.user.sub, "storage.migrate", "settings", "storage", {
      copied,
      failed: failed.length,
    });
    res.json({ copied, failed, total: files.length });
  },
);

app.get(["/healthz", "/api/healthz"], async (_req, res) => {
  try {
    await db.query("SELECT 1");
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.get("/", (req, res, next) =>
  /^[0-9a-f-]{36}$/i.test(String(req.query.scene || ""))
    ? res.redirect("/editor?scene=" + req.query.scene)
    : next(),
);
// Static dashboard routes contain no protected data. Tokens stay in URL fragments.
const dashboardRoot = path.resolve(import.meta.dirname, "../dashboard");
app.use(
  "/dashboard",
  express.static(dashboardRoot, { index: false, redirect: false }),
);
app.get(
  [
    "/",
    "/login",
    "/forgot-password",
    "/reset-password",
    "/set-password",
    "/dashboard",
    "/dashboard/",
    "/account/change-password",
    "/admin/users",
    "/admin/reset-requests",
    "/admin/audit-log",
    "/admin/storage",
    "/admin/workspace-export",
    "/admin/workspace-import",
    "/admin/workspaces",
    "/admin/teams",
  ],
  (_req, res) => res.sendFile(path.join(dashboardRoot, "index.html")),
);
const editorRoot = path.resolve(import.meta.dirname, "../excalidraw-app/build");
app.get("/editor", (_req, res, next) =>
  fs.existsSync(path.join(editorRoot, "index.html"))
    ? res.sendFile(path.join(editorRoot, "index.html"))
    : next(),
);
app.use(express.static(editorRoot, { index: false }));
app.use("/api", (_req, res) => res.status(404).json({ error: "Not found." }));
app.use((error, req, res, _next) => {
  if (res.headersSent) return res.end();
  // Never swallow an unexpected failure: the client gets a generic message, but
  // the operator needs the cause. Secrets are not part of an error object here.
  if (!error.status || error.status >= 500) {
    console.error(
      "[api]",
      req.method,
      req.originalUrl,
      error?.code ?? "",
      error?.message ?? error,
      error?.stack ?? "",
    );
  }
  const status =
    error.status ||
    (error.code === "23505"
      ? 409
      : ["23503", "23514", "22P02"].includes(error.code)
      ? 400
      : 500);
  res.status(status).json({
    error:
      status === 500
        ? "Server error. Please try again."
        : error.code === "23505"
        ? "That name is already in use."
        : error.code
        ? "Invalid request."
        : error.message,
  });
});
await loadStorageFromDb();
httpServer.listen(Number(PORT), "127.0.0.1", () =>
  console.log(
    `excalidraw-api listening on 127.0.0.1:${PORT} (storage: ${store.driver})`,
  ),
);
