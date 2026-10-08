import { cleanupWorkspaceTrash } from "../lib/workspace-deletion.js";
import { renderWorkspaceTransfer } from "../../dashboard/workspace-transfer.js";
import { zipSync, unzipSync } from "fflate";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { io as socketClient } from "socket.io-client";
import { JSDOM } from "jsdom";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { hashPassword } from "../lib/passwords.js";
import { sha256 } from "../lib/core.js";
const base = process.env.TEST_DATABASE_URL;
if (!base)
  throw new Error(
    "Set TEST_DATABASE_URL to an isolated PostgreSQL instance with CREATE DATABASE permission.",
  );
const control = new pg.Pool({ connectionString: base });
const database = "excalidraw_test_" + process.pid;
const origin = "http://127.0.0.1:55440";
const password = "A private orchard under moonlight 742!";
let db, server, storage, admin, workspace, otherWorkspace, editor, viewer;
async function call(
  endpoint,
  {
    cookie,
    method = "GET",
    body,
    key,
    originHeader = origin,
    headers = {},
  } = {},
) {
  const response = await fetch(origin + "/api" + endpoint, {
    method,
    headers: {
      Origin: originHeader,
      "X-Excalidraw-Request": "1",
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json().catch(() => null);
  return {
    status: response.status,
    body: result,
    cookie: response.headers
      .getSetCookie()
      .find((c) => c.startsWith("ex_session=") && !c.startsWith("ex_session=;"))
      ?.split(";")[0],
  };
}
async function login(name, pw = password) {
  const result = await call("/auth/login", {
    method: "POST",
    body: { username: name, password: pw },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.cookie;
}
async function makeUser(name, role = "editor", overrides = {}) {
  const result = await call("/admin/users", {
    cookie: admin,
    method: "POST",
    body: {
      username: name,
      assignments: [{ workspace_id: workspace, role, overrides }],
    },
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  const token = new URL(result.body.url).hash.slice(7);
  assert.equal(
    (
      await call("/auth/reset-password", {
        method: "POST",
        body: { token, purpose: "setup", password, confirmation: password },
      })
    ).status,
    200,
  );
  return { id: result.body.id, cookie: await login(name) };
}
const createDrawing = async (
  cookie = admin,
  collection_id = null,
  extra = {},
) => {
  const result = await call("/scenes", {
    method: "POST",
    cookie,
    key: crypto.randomUUID(),
    body: {
      workspace_id: workspace,
      name: "A drawing",
      collection_id,
      ...extra,
    },
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body;
};
const createCollection = async (name, cookie = admin) => {
  const result = await call(`/workspaces/${workspace}/collections`, {
    method: "POST",
    cookie,
    key: crypto.randomUUID(),
    body: { name },
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body;
};
before(async () => {
  await control.query(`CREATE DATABASE ${database}`);
  const url = new URL(base);
  url.pathname = "/" + database;
  db = new pg.Pool({ connectionString: url.href });
  await db.query(
    "DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='excalidraw') THEN CREATE ROLE excalidraw; END IF; END $$;",
  );
  await db.query("CREATE EXTENSION citext");
  for (const file of [
    "schema.sql",
    "migration-002-collections.sql",
    "migration-003-settings.sql",
    "migration-004-username.sql",
    "migration-005-private-workspaces.sql",
    "migration-006-workspace-experience.sql",
    "migration-007-team-access.sql",
    "migration-008-collaboration-keys.sql",
    "migration-009-workspace-transfer.sql",
    "migration-010-workspace-trash.sql",
    "migration-011-mcp-keys.sql",
    "migration-012-oauth.sql",
    "migration-013-icons.sql",
  ])
    await db.query(
      await readFile(new URL("../" + file, import.meta.url), "utf8"),
    );
  const user = await db.query(
    "INSERT INTO users(username,password_hash,is_superadmin) VALUES('admin',$1,true) RETURNING id",
    [await hashPassword(password)],
  );
  const workspaces = await db.query(
    "INSERT INTO workspaces(name,slug,owner_id) VALUES('Test','test',$1),('Other','other',$1) RETURNING id",
    [user.rows[0].id],
  );
  workspace = workspaces.rows[0].id;
  otherWorkspace = workspaces.rows[1].id;
  storage = await mkdtemp(path.join(tmpdir(), "excalidraw-storage-"));
  server = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      DATABASE_URL: url.href,
      PORT: "55440",
      APP_ORIGIN: origin,
      COOKIE_SECURE: "false",
      JWT_SECRET: crypto.randomBytes(32).toString("hex"),
      LOCAL_STORAGE_ROOT: storage,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errors = "";
  server.stderr.on("data", (d) => (errors += d.toString()));
  await Promise.race([
    once(server.stdout, "data"),
    once(server, "exit").then(() => {
      throw new Error(errors);
    }),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Server start timed out: " + errors)),
        15000,
      ),
    ),
  ]);
  admin = await login("ADMIN");
  editor = await makeUser("editor");
  viewer = await makeUser("viewer", "viewer");
});
after(async () => {
  if (server) {
    server.kill();
    await once(server, "exit");
  }
  if (db) await db.end();
  await control.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await control.end();
  if (storage) await rm(storage, { recursive: true, force: true });
});
test("private workspace backend", async (t) => {
  await t.test(
    "workspace deletion confirms counts, revokes access, restores, and retries object cleanup",
    async () => {
      const made = await call("/admin/workspaces", {
        cookie: admin,
        method: "POST",
        body: { name: "Disposable deletion test" },
      });
      assert.equal(made.status, 201);
      const id = made.body.id,
        endpoint = "/admin/workspaces/" + id;
      const collection = await call("/workspaces/" + id + "/collections", {
        cookie: admin,
        method: "POST",
        key: crypto.randomUUID(),
        body: { name: "Deletion collection" },
      });
      const scene = await call("/scenes", {
        cookie: admin,
        method: "POST",
        key: crypto.randomUUID(),
        body: {
          workspace_id: id,
          collection_id: collection.body.id,
          name: "Deletion scene",
        },
      });
      assert.equal(scene.status, 201);
      assert.equal(
        (await call(endpoint + "/delete-preview", { cookie: editor.cookie }))
          .status,
        403,
      );
      let preview = (
        await call(endpoint + "/delete-preview", { cookie: admin })
      ).body;
      assert.equal(preview.collections, 1);
      assert.equal(preview.scenes, 1);
      assert.equal(
        (
          await call(endpoint, {
            cookie: admin,
            method: "DELETE",
            body: { ...preview, name: "wrong" },
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await call(endpoint, {
            cookie: admin,
            method: "DELETE",
            body: { ...preview, scenes: 0 },
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await call(endpoint, {
            cookie: admin,
            method: "DELETE",
            body: preview,
          })
        ).status,
        200,
      );
      assert.equal(
        (await call("/scenes/" + scene.body.id + "/data", { cookie: admin }))
          .status,
        404,
      );
      assert.equal(
        (await call("/workspaces", { cookie: admin })).body.some(
          (w) => w.id === id,
        ),
        false,
      );
      assert.equal(
        (
          await call(endpoint, {
            cookie: admin,
            method: "PATCH",
            body: { name: "Forbidden rename" },
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await call(endpoint + "/restore", {
            cookie: editor.cookie,
            method: "POST",
          })
        ).status,
        403,
      );
      assert.equal(
        (await call(endpoint + "/restore", { cookie: admin, method: "POST" }))
          .status,
        200,
      );
      assert.equal(
        (await call("/scenes/" + scene.body.id + "/data", { cookie: admin }))
          .status,
        200,
      );
      preview = (await call(endpoint + "/delete-preview", { cookie: admin }))
        .body;
      const owned = scene.body.s3_key;
      await db.query(
        "UPDATE scenes SET thumb_s3_key='delete-test/thumb',collab_s3_key='delete-test/collab' WHERE id=$1",
        [scene.body.id],
      );
      await db.query(
        "INSERT INTO scene_files(file_id,scene_id,s3_key) VALUES('delete-image',$1,'delete-test/image')",
        [scene.body.id],
      );
      await db.query(
        "INSERT INTO scene_versions(scene_id,s3_key,scene_version,created_by) VALUES($1,'delete-test/version',2,$2)",
        [scene.body.id, scene.body.owner_id],
      );
      await db.query(
        "INSERT INTO workspace_exports(workspace_id,requested_by,scope,status,object_key) VALUES($1,$2,'all','ready','delete-test/export')",
        [id, scene.body.owner_id],
      );
      // A file also referenced by another workspace must survive cleanup.
      await db.query(
        "INSERT INTO scene_files(file_id,scene_id,s3_key) VALUES('shared-reference',$1,'delete-test/shared')",
        [scene.body.id],
      );
      await db.query(
        "INSERT INTO shared_scenes(id,s3_key) VALUES('delete-test-shared','delete-test/shared')",
      );
      assert.equal(
        (
          await call(endpoint, {
            cookie: admin,
            method: "DELETE",
            body: preview,
          })
        ).status,
        200,
      );
      const removed = [];
      await cleanupWorkspaceTrash(db, {
        remove: async (key) => removed.push(key),
      });
      assert.equal(removed.length, 0, "retention period must protect objects");
      await db.query(
        "UPDATE workspaces SET purge_after=now()-interval '1 second' WHERE id=$1",
        [id],
      );
      assert.equal(
        (await call(endpoint + "/restore", { cookie: admin, method: "POST" }))
          .status,
        409,
      );
      await assert.rejects(
        () =>
          cleanupWorkspaceTrash(db, {
            remove: async () => {
              throw new Error("temporary storage failure");
            },
          }),
        /temporary storage failure/,
      );
      assert.equal(
        (
          await db.query(
            "SELECT 1 FROM workspaces WHERE id=$1 AND purging_at IS NOT NULL",
            [id],
          )
        ).rowCount,
        1,
      );
      await cleanupWorkspaceTrash(db, {
        remove: async (key) => removed.push(key),
      });
      assert.deepEqual(
        removed.sort(),
        [
          owned,
          "delete-test/thumb",
          "delete-test/collab",
          "delete-test/image",
          "delete-test/version",
          "delete-test/export",
        ].sort(),
      );
      assert.equal(
        (await db.query("SELECT 1 FROM workspaces WHERE id=$1", [id])).rowCount,
        0,
      );
      const actions = (
        await db.query(
          "SELECT action FROM audit_log WHERE target_id=$1 ORDER BY created_at",
          [id],
        )
      ).rows.map((r) => r.action);
      for (const action of [
        "workspace.trash",
        "workspace.restore",
        "workspace.purge.start",
        "workspace.purge.complete",
      ])
        assert.ok(actions.includes(action), action);
    },
  );

  await t.test(
    "import UI submits ZIPs and displays the backend summary",
    async () => {
      const dom = new JSDOM('<div id="host"></div>', {
        url: origin + "/admin/workspace-import",
      });
      const win = dom.window,
        host = win.document.getElementById("host");
      win.fetch = (url, options) =>
        fetch(origin + url, {
          ...options,
          headers: { ...options.headers, Cookie: admin, Origin: origin },
        });
      const api = async (endpoint) => {
        const result = await call(endpoint, { cookie: admin });
        assert.equal(result.status, 200);
        return result.body;
      };
      await renderWorkspaceTransfer({
        host,
        state: { workspace: { id: workspace }, collections: [], generation: 1 },
        api,
        escape: (value) => String(value),
        reauthenticate: async () => true,
        kind: "workspace-import",
        generation: 1,
      });
      const payload = {
        type: "excalidraw",
        elements: [],
        appState: {},
        files: {},
      };
      const file = new File(
        [
          zipSync({
            "UI import/Browser scene.excalidraw": Buffer.from(
              JSON.stringify(payload),
            ),
          }),
        ],
        "ui.zip",
        { type: "application/zip" },
      );
      const input = host.querySelector("#import-files");
      Object.defineProperty(input, "files", { value: [file] });
      input.dispatchEvent(new win.Event("change"));
      for (
        let i = 0;
        i < 100 && !host.textContent.includes("Import complete");
        i++
      )
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.match(host.textContent, /1 imported · 0 skipped · 0 errors/);
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM collections WHERE workspace_id=$1 AND name='UI import'",
            [workspace],
          )
        ).rows[0].n,
        1,
      );
      dom.window.close();
    },
  );

  await t.test(
    "workspace transfer preserves images, collections and privacy; checks scope and retries",
    async () => {
      const prefix = `/admin/workspaces/${workspace}`;
      assert.equal(
        (await call(prefix + "/transfers", { cookie: editor.cookie })).status,
        403,
      );
      const image = {
        type: "excalidraw",
        version: 2,
        elements: [
          { id: "image-1", type: "image", fileId: "asset", isDeleted: false },
        ],
        appState: { viewBackgroundColor: "#ffffff" },
        files: {
          asset: {
            id: "asset",
            dataURL: "data:image/png;base64,aGVsbG8=",
            mimeType: "image/png",
            created: 1,
          },
        },
      };
      const upload = async (
        bytes,
        key,
        file = "Drawing.zip",
        cookie = admin,
      ) => {
        const response = await fetch(origin + "/api" + prefix + "/imports", {
          method: "POST",
          headers: {
            Cookie: cookie,
            Origin: origin,
            "X-Excalidraw-Request": "1",
            "Idempotency-Key": key,
            "Content-Type": "application/zip",
            "X-File-Path": encodeURIComponent(file),
          },
          body: bytes,
        });
        return { status: response.status, body: await response.json() };
      };
      const bytes = zipSync({
        "Architecture/Diagram.excalidraw": Buffer.from(JSON.stringify(image)),
        "Private/Personal.excalidraw": Buffer.from(JSON.stringify(image)),
      });
      const key = crypto.randomUUID();
      assert.equal(
        (await upload(bytes, key, "Drawing.zip", editor.cookie)).status,
        403,
      );
      const imported = await upload(bytes, key);
      assert.equal(imported.status, 200, JSON.stringify(imported.body));
      assert.deepEqual(imported.body, { imported: 2, skipped: 0, errors: [] });
      assert.deepEqual((await upload(bytes, key)).body, {
        imported: 0,
        skipped: 2,
        errors: [],
      });
      const privateOther = await createDrawing(editor.cookie, null, {
        private: true,
        name: "Other user private",
      });
      const request = await call(prefix + "/exports", {
        cookie: admin,
        method: "POST",
        body: { scope: "accessible" },
      });
      assert.equal(request.status, 202, JSON.stringify(request.body));
      assert.equal(
        (
          await call(prefix + "/exports", {
            cookie: admin,
            method: "POST",
            body: { scope: "all" },
          })
        ).status,
        429,
      );
      let job;
      for (let i = 0; i < 100; i++) {
        job = (
          await db.query("SELECT * FROM workspace_exports WHERE id=$1", [
            request.body.id,
          ])
        ).rows[0];
        if (["ready", "failed"].includes(job.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(job.status, "ready", job.error);
      const download = await fetch(
        origin + "/api" + prefix + "/exports/" + job.id + "/download",
        { headers: { Cookie: admin } },
      );
      assert.equal(download.status, 200);
      const archive = unzipSync(new Uint8Array(await download.arrayBuffer()));
      const manifest = JSON.parse(
        Buffer.from(archive["manifest.json"]).toString(),
      );
      assert.equal(
        manifest.scenes.some((s) => s.name === privateOther.name),
        false,
      );
      const diagram = manifest.scenes.find((s) => s.name === "Diagram");
      assert.equal(diagram.collections[0].name, "Architecture");
      assert.deepEqual(
        JSON.parse(Buffer.from(archive[diagram.path]).toString()).files,
        image.files,
      );
      const restored = await upload(zipSync(archive), crypto.randomUUID());
      assert.equal(
        restored.body.errors.length,
        0,
        JSON.stringify(restored.body),
      );
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM collections WHERE workspace_id=$1 AND name='Architecture'",
            [workspace],
          )
        ).rows[0].n,
        1,
      );
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM scenes WHERE workspace_id=$1 AND name='Personal' AND private_owner_id IS NOT NULL",
            [workspace],
          )
        ).rows[0].n,
        2,
      );
      await db.query(
        "UPDATE workspace_exports SET created_at=now()-interval '2 hours' WHERE id=$1",
        [job.id],
      );
      const full = await call(prefix + "/exports", {
        cookie: admin,
        method: "POST",
        body: { scope: "member", member_id: editor.id },
      });
      assert.equal(full.status, 202);
      for (let i = 0; i < 100; i++) {
        job = (
          await db.query("SELECT * FROM workspace_exports WHERE id=$1", [
            full.body.id,
          ])
        ).rows[0];
        if (["ready", "failed"].includes(job.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(job.status, "ready", job.error);
      const memberArchive = unzipSync(
        await readFile(path.join(storage, job.object_key)),
      );
      const memberManifest = JSON.parse(
        Buffer.from(memberArchive["manifest.json"]).toString(),
      );
      assert.deepEqual(
        memberManifest.scenes.map((s) => s.name),
        [privateOther.name],
      );
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM audit_log WHERE action='workspace.export.request'",
          )
        ).rows[0].n,
        2,
      );
      await db.query(
        "UPDATE workspace_exports SET expires_at=now()-interval '1 second' WHERE id=$1",
        [job.id],
      );
      assert.equal(
        (
          await fetch(
            origin + "/api" + prefix + "/exports/" + job.id + "/download",
            { headers: { Cookie: admin } },
          )
        ).status,
        404,
      );
      const unsafe = zipSync({
        "../escape.excalidraw": Buffer.from(JSON.stringify(image)),
      });
      assert.equal((await upload(unsafe, crypto.randomUUID())).status, 400);
    },
  );

  await t.test(
    "password policy accepts eight characters and rejects seven",
    async () => {
      await assert.doesNotReject(() => hashPassword("K7!mQ2#z"));
      assert.throws(() => hashPassword("K7!mQ2#"), /Use 8–128 characters/);
    },
  );
  await t.test(
    "signed-out APIs and old public routes expose no scene data",
    async () => {
      for (const endpoint of [
        "/me",
        "/scenes?workspace=" + workspace,
        `/workspaces/${workspace}/collections`,
      ])
        assert.equal((await call(endpoint)).status, 401);
      for (const endpoint of [
        "/setup-status",
        "/v2/secret",
        "/files/rooms/test/file",
        "/rooms/test/scene",
        "/blob/secret",
      ])
        assert.ok([401, 404].includes((await call(endpoint)).status));
      assert.equal(
        (await call("/setup", { method: "POST", body: {} })).status,
        404,
      );
    },
  );
  await t.test("generic credentials, CSRF, and revocable logout", async () => {
    for (const username of ["missing", "viewer"]) {
      const result = await call("/auth/login", {
        method: "POST",
        body: { username, password: "wrong" },
      });
      assert.equal(result.status, 401);
      assert.equal(result.body.error, "Invalid username or password.");
    }
    assert.equal(
      (
        await call("/auth/login", {
          method: "POST",
          originHeader: "https://evil.example",
          body: { username: "admin", password },
        })
      ).status,
      403,
    );
    const cookie = await login("viewer");
    await call("/auth/logout", { method: "POST", cookie });
    assert.equal((await call("/me", { cookie })).status, 401);
  });
  await t.test(
    "regular users cannot administer, access other workspaces, or escalate",
    async () => {
      assert.equal(
        (await call("/admin/users", { cookie: editor.cookie })).status,
        403,
      );
      assert.equal(
        (
          await call("/scenes?workspace=" + otherWorkspace, {
            cookie: editor.cookie,
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await call("/workspaces", {
            cookie: editor.cookie,
            method: "POST",
            body: { name: "Illicit" },
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await call("/me", {
            cookie: editor.cookie,
            method: "PATCH",
            body: { is_superadmin: true },
          })
        ).status,
        404,
      );
    },
  );
  await t.test(
    "normalized collection names and concurrent uniqueness",
    async () => {
      for (const name of [" ", "x".repeat(81)])
        assert.equal(
          (
            await call(`/workspaces/${workspace}/collections`, {
              cookie: admin,
              method: "POST",
              key: crypto.randomUUID(),
              body: { name },
            })
          ).status,
          400,
        );
      const results = await Promise.all(
        ["  Café  ", "CAFE\u0301"].map((name) =>
          call(`/workspaces/${workspace}/collections`, {
            cookie: admin,
            method: "POST",
            key: crypto.randomUUID(),
            body: { name },
          }),
        ),
      );
      assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    },
  );
  await t.test(
    "multiple memberships, idempotency, atomic invalid batch, unorganized and deletion",
    async () => {
      const a = await createCollection("Alpha"),
        b = await createCollection("Beta"),
        s = await createDrawing(admin, a.id);
      for (let i = 0; i < 2; i++)
        assert.equal(
          (
            await call(`/collections/${b.id}/drawings`, {
              cookie: admin,
              method: "PUT",
              body: { drawing_ids: [s.id] },
            })
          ).status,
          200,
        );
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM collection_drawings WHERE drawing_id=$1",
            [s.id],
          )
        ).rows[0].n,
        2,
      );
      const second = await createDrawing();
      assert.equal(
        (
          await call(`/collections/${b.id}/drawings`, {
            cookie: admin,
            method: "PUT",
            body: { drawing_ids: [second.id, crypto.randomUUID()] },
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await db.query(
            "SELECT 1 FROM collection_drawings WHERE drawing_id=$1",
            [second.id],
          )
        ).rowCount,
        0,
      );
      await call(`/collections/${a.id}`, { cookie: admin, method: "DELETE" });
      assert.equal(
        (await call(`/scenes/${s.id}/data`, { cookie: admin })).status,
        200,
      );
      await call(`/collections/${b.id}/drawings`, {
        cookie: admin,
        method: "PUT",
        body: { drawing_ids: [s.id], remove: true },
      });
      assert.ok(
        (
          await call(`/scenes?workspace=${workspace}&unorganized=1`, {
            cookie: admin,
          })
        ).body.items.some((item) => item.id === s.id),
      );
    },
  );
  await t.test(
    "creation retries return one drawing, mismatched reuse rejects",
    async () => {
      const key = crypto.randomUUID(),
        body = { workspace_id: workspace, name: "Retry" };
      const results = await Promise.all(
        [1, 2].map(() =>
          call("/scenes", { cookie: admin, method: "POST", key, body }),
        ),
      );
      assert.equal(results[0].body.id, results[1].body.id);
      assert.equal(
        (
          await call("/scenes", {
            cookie: admin,
            method: "POST",
            key,
            body: { ...body, name: "Other" },
          })
        ).status,
        409,
      );
    },
  );
  await t.test(
    "viewer cannot bypass editing and editor cannot trash by default",
    async () => {
      const s = await createDrawing();
      const loaded = await call(`/scenes/${s.id}/data`, {
        cookie: viewer.cookie,
      });
      assert.equal(loaded.status, 200);
      assert.equal(
        (
          await call(`/scenes/${s.id}/data`, {
            cookie: viewer.cookie,
            method: "PUT",
            body: { version: 1, scene: loaded.body.scene },
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await call(`/scenes/${s.id}`, {
            cookie: editor.cookie,
            method: "DELETE",
          })
        ).status,
        403,
      );
    },
  );
  await t.test(
    "images persist and simultaneous stale saves cannot overwrite",
    async () => {
      const s = await createDrawing(),
        data = {
          type: "excalidraw",
          version: 2,
          elements: [
            { id: "image", type: "image", fileId: "image1", isDeleted: false },
          ],
          appState: { viewBackgroundColor: "#fff" },
          files: {
            image1: {
              id: "image1",
              dataURL: "data:image/png;base64,iVBORw0KGgo=",
              mimeType: "image/png",
              created: 1,
            },
          },
        };
      const results = await Promise.all(
        [1, 2].map(() =>
          call(`/scenes/${s.id}/data`, {
            cookie: admin,
            method: "PUT",
            body: { version: 1, scene: data },
          }),
        ),
      );
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
      const loaded = await call(`/scenes/${s.id}/data`, { cookie: admin });
      assert.equal(loaded.body.version, 2);
      assert.deepEqual(loaded.body.scene.files, data.files);
      assert.equal(
        (
          await call(`/scenes/${s.id}/data`, {
            cookie: admin,
            method: "PUT",
            body: { version: 2, scene: { ...data, files: {} } },
          })
        ).status,
        400,
      );
      const duplicate = await call(`/scenes/${s.id}/duplicate`, {
        cookie: admin,
        method: "POST",
        key: crypto.randomUUID(),
        body: { name: "Copy" },
      });
      assert.equal(duplicate.status, 201);
      assert.deepEqual(
        (await call(`/scenes/${duplicate.body.id}/export`, { cookie: admin }))
          .body.files,
        data.files,
      );
    },
  );
  await t.test(
    "trash preserves memberships for collection restoration",
    async () => {
      const c = await createCollection("Trash collection"),
        s = await createDrawing(admin, c.id);
      await call(`/scenes/${s.id}`, { cookie: admin, method: "DELETE" });
      await call(`/collections/${c.id}`, { cookie: admin, method: "DELETE" });
      await call(`/scenes/${s.id}/restore`, { cookie: admin, method: "POST" });
      assert.equal(
        (
          await db.query(
            "SELECT 1 FROM collection_drawings WHERE drawing_id=$1",
            [s.id],
          )
        ).rowCount,
        1,
      );
      assert.equal(
        (await call(`/scenes/${s.id}/data`, { cookie: admin })).status,
        200,
      );
    },
  );
  await t.test(
    "private scenes isolate owners; moves are atomic and expose only the chosen destination",
    async () => {
      const s = await createDrawing(editor.cookie, null, { private: true });
      assert.equal(
        (await call(`/scenes/${s.id}/data`, { cookie: viewer.cookie })).status,
        404,
      );
      // administrators are trusted with every drawing in the workspace
      assert.equal(
        (await call(`/scenes/${s.id}/data`, { cookie: admin })).status,
        200,
      );
      const list = await call(`/scenes?workspace=${workspace}&private=1`, {
        cookie: editor.cookie,
      });
      assert.ok(list.body.items.some((x) => x.id === s.id));
      const c = await createCollection("Move target");
      assert.equal(
        (
          await call(`/scenes/${s.id}/move`, {
            cookie: editor.cookie,
            method: "POST",
            body: { collection_id: c.id, version: s.metadata_version },
          })
        ).status,
        200,
      );
      assert.equal(
        (await call(`/scenes/${s.id}/data`, { cookie: viewer.cookie })).status,
        200,
      );
      assert.equal(
        (
          await call(`/scenes/${s.id}/move`, {
            cookie: editor.cookie,
            method: "POST",
            body: {
              collection_id: crypto.randomUUID(),
              version: s.metadata_version + 1,
            },
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await db.query(
            "SELECT collection_id FROM collection_drawings WHERE drawing_id=$1",
            [s.id],
          )
        ).rows[0].collection_id,
        c.id,
      );
      assert.equal(
        (
          await call(`/scenes/${s.id}/move`, {
            cookie: editor.cookie,
            method: "POST",
            body: { private: true, version: s.metadata_version + 1 },
          })
        ).status,
        200,
      );
      assert.equal(
        (await call(`/scenes/${s.id}/data`, { cookie: viewer.cookie })).status,
        404,
      );
      assert.equal(
        (
          await call(`/scenes?workspace=${workspace}&sort=visited`, {
            cookie: viewer.cookie,
          })
        ).body.items.some((x) => x.id === s.id),
        false,
      );
    },
  );
  await t.test(
    "rapid autosaves share one restore point instead of piling up copies",
    async () => {
      const scene = await createDrawing();
      const paint = async (version, colour) => {
        const saved = await call(`/scenes/${scene.id}/data`, {
          cookie: admin,
          method: "PUT",
          body: {
            version,
            scene: {
              type: "excalidraw",
              version: 2,
              elements: [],
              appState: { viewBackgroundColor: colour },
              files: {},
            },
          },
        });
        assert.equal(saved.status, 200, JSON.stringify(saved.body));
        return saved.body.version;
      };
      const points = () =>
        db.query(
          "SELECT s3_key,scene_version FROM scene_versions WHERE scene_id=$1 ORDER BY scene_version",
          [scene.id],
        );
      let version = scene.scene_version;
      for (const colour of ["#111111", "#222222", "#333333", "#444444"])
        version = await paint(version, colour);
      const burst = await points();
      assert.equal(
        burst.rowCount,
        1,
        "four quick saves keep one restore point",
      );
      assert.equal(burst.rows[0].scene_version, version);
      // the newest drawing is intact, not an older copy
      assert.equal(
        (await call(`/scenes/${scene.id}/data`, { cookie: admin })).body.scene
          .appState.viewBackgroundColor,
        "#444444",
      );
      // once the window passes, the next save starts a fresh restore point
      await db.query(
        "UPDATE scene_versions SET created_at=now()-interval '20 minutes' WHERE scene_id=$1",
        [scene.id],
      );
      version = await paint(version, "#555555");
      const later = await points();
      assert.equal(later.rowCount, 2, "a new window adds a restore point");
      assert.notEqual(
        later.rows[0].s3_key,
        later.rows[1].s3_key,
        "each restore point keeps its own stored file",
      );
      // a restored version is never overwritten by the saves that follow it
      const history = (
        await call(`/scenes/${scene.id}/versions`, { cookie: admin })
      ).body;
      assert.equal(history.items.length, 2);
      const older = history.items.find((v) => v.scene_version < version);
      const restored = await call(
        `/scenes/${scene.id}/versions/${older.id}/restore`,
        { cookie: admin, method: "POST", body: { version } },
      );
      assert.equal(restored.status, 200, JSON.stringify(restored.body));
      version = restored.body.version;
      version = await paint(version, "#666666");
      assert.equal(
        (await call(`/scenes/${scene.id}/data`, { cookie: admin })).body.scene
          .appState.viewBackgroundColor,
        "#666666",
      );
      // restoring reuses the old file on purpose, so the save after a restore has
      // to write its own file rather than overwrite the shared one
      const rows = (await points()).rows;
      const newest = rows[rows.length - 1];
      assert.ok(
        rows.slice(0, -1).every((row) => row.s3_key !== newest.s3_key),
        "a save after a restore never overwrites the restored file",
      );
    },
  );
  await t.test(
    "an assistant signs in with OAuth and acts as that person",
    async () => {
      const post = (path, body, headers = {}) =>
        fetch(origin + path, {
          method: "POST",
          redirect: "manual",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            ...headers,
          },
          body: new URLSearchParams(body).toString(),
        });
      // metadata the client reads first
      const resource = await (
        await fetch(origin + "/.well-known/oauth-protected-resource")
      ).json();
      assert.equal(resource.resource, origin + "/mcp");
      const server = await (
        await fetch(origin + "/.well-known/oauth-authorization-server")
      ).json();
      assert.deepEqual(server.code_challenge_methods_supported, ["S256"]);
      // an unauthenticated tool call points the client at that metadata
      const challenge = await fetch(origin + "/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      assert.equal(challenge.status, 401);
      assert.match(
        challenge.headers.get("www-authenticate") || "",
        /resource_metadata=/,
      );
      // the client registers itself
      const registered = await (
        await fetch(origin + "/oauth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_name: "Test Assistant",
            redirect_uris: ["http://127.0.0.1:9999/callback"],
          }),
        })
      ).json();
      assert.match(registered.client_id, /^mcp-/);
      assert.equal(
        (
          await fetch(origin + "/oauth/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ redirect_uris: ["http://evil.test/cb"] }),
          })
        ).status,
        400,
        "only https or loopback redirects are accepted",
      );
      const verifier = crypto.randomBytes(32).toString("base64url");
      const query = {
        client_id: registered.client_id,
        redirect_uri: "http://127.0.0.1:9999/callback",
        response_type: "code",
        scope: "drawings.read offline_access",
        state: "xyz",
        code_challenge: crypto
          .createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        code_challenge_method: "S256",
      };
      // signed out, the page asks for a password
      const prompt = await fetch(
        origin + "/oauth/authorize?" + new URLSearchParams(query),
      );
      assert.equal(prompt.status, 200);
      assert.match(await prompt.text(), /Sign in to connect/);
      // browsers apply form-action to the redirect a submission lands on, so the
      // client's callback origin must be allowed or approval silently does nothing
      assert.match(
        prompt.headers.get("content-security-policy") || "",
        /form-action 'self' http:\/\/127\.0\.0\.1:9999/,
      );
      assert.match(prompt.headers.get("cache-control") || "", /no-store/);
      const signedIn = await post("/oauth/sign-in", {
        ...query,
        username: "admin",
        password,
      });
      assert.equal(signedIn.status, 302);
      const cookie = signedIn.headers
        .getSetCookie()
        .filter(
          (c) => c.startsWith("ex_session=") && !c.startsWith("ex_session=;"),
        )
        .pop()
        ?.split(";")[0];
      assert.ok(cookie, "signing in on the consent page starts a session");
      const consent = await fetch(
        origin + "/oauth/authorize?" + new URLSearchParams(query),
        { headers: { Cookie: cookie } },
      );
      assert.match(await consent.text(), /Connect/);
      const refused = await post(
        "/oauth/authorize",
        { ...query, decision: "deny" },
        { Cookie: cookie },
      );
      assert.match(refused.headers.get("location"), /error=access_denied/);
      const granted = await post(
        "/oauth/authorize",
        { ...query, decision: "allow" },
        { Cookie: cookie },
      );
      const back = new URL(granted.headers.get("location"));
      assert.equal(back.searchParams.get("state"), "xyz");
      const code = back.searchParams.get("code");
      assert.ok(code);
      // the wrong verifier never exchanges
      assert.equal(
        (
          await (
            await post("/oauth/token", {
              grant_type: "authorization_code",
              code,
              client_id: registered.client_id,
              redirect_uri: query.redirect_uri,
              code_verifier: crypto.randomBytes(32).toString("base64url"),
            })
          ).json()
        ).error,
        "invalid_grant",
      );
      const issued = await (
        await post("/oauth/token", {
          grant_type: "authorization_code",
          code,
          client_id: registered.client_id,
          redirect_uri: query.redirect_uri,
          code_verifier: verifier,
        })
      ).json();
      assert.equal(issued.token_type, "Bearer");
      assert.ok(issued.access_token && issued.refresh_token);
      // a code is single use
      assert.equal(
        (
          await (
            await post("/oauth/token", {
              grant_type: "authorization_code",
              code,
              client_id: registered.client_id,
              redirect_uri: query.redirect_uri,
              code_verifier: verifier,
            })
          ).json()
        ).error,
        "invalid_grant",
      );
      // the token works on the MCP endpoint, as the person who approved it
      const rpc = (accessToken, method, params = {}, id = 1) =>
        fetch(origin + "/mcp", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        });
      assert.equal(
        (
          await rpc(issued.access_token, "initialize", {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "test", version: "1" },
          })
        ).status,
        200,
      );
      const tools = await (
        await rpc(issued.access_token, "tools/list", {}, 2)
      ).json();
      assert.ok(tools.result.tools.length >= 4);
      // refresh rotates: the old refresh token stops working
      const refreshed = await (
        await post("/oauth/token", {
          grant_type: "refresh_token",
          refresh_token: issued.refresh_token,
          client_id: registered.client_id,
        })
      ).json();
      assert.ok(refreshed.access_token);
      assert.equal(
        (
          await (
            await post("/oauth/token", {
              grant_type: "refresh_token",
              refresh_token: issued.refresh_token,
              client_id: registered.client_id,
            })
          ).json()
        ).error,
        "invalid_grant",
      );
      // revoking ends access immediately
      await post("/oauth/revoke", { token: refreshed.access_token });
      assert.equal(
        (await rpc(refreshed.access_token, "tools/list", {}, 3)).status,
        401,
      );
    },
  );
  await t.test(
    "MCP keys let an assistant work as one person and no further",
    async () => {
      const rpc = async (token, method, params = {}, id = 1) => {
        const response = await fetch(origin + "/mcp", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        });
        const text = await response.text();
        const body = text.startsWith("event:")
          ? JSON.parse(text.slice(text.indexOf("data:") + 5).trim())
          : text
          ? JSON.parse(text)
          : null;
        return { status: response.status, body };
      };
      const hello = {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      };
      assert.equal((await rpc(null, "initialize", hello)).status, 401);
      assert.equal(
        (await rpc("exmcp_" + "a".repeat(43), "initialize", hello)).status,
        401,
      );
      const created = await call("/admin/mcp-keys", {
        cookie: admin,
        method: "POST",
        body: { name: "Test assistant", scope: "read" },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const token = created.body.token;
      assert.match(token, /^exmcp_[A-Za-z0-9_-]{43}$/);
      // only a hash of the key is kept
      assert.equal(
        (
          await db.query("SELECT token_hash FROM mcp_keys WHERE id=$1", [
            created.body.id,
          ])
        ).rows[0].token_hash.includes(token.slice(6)),
        false,
      );
      assert.equal((await rpc(token, "initialize", hello)).status, 200);
      const tools = await rpc(token, "tools/list", {}, 2);
      // a read-only key sees the reading tools and the style guide, never the drawing ones
      assert.deepEqual(tools.body.result.tools.map((x) => x.name).sort(), [
        "drawing_style_guide",
        "export_drawing",
        "fetch",
        "list_collections",
        "list_icons",
        "search",
      ]);
      const collection = await createCollection("MCP visible");
      const scene = await createDrawing(admin, collection.id);
      const found = await rpc(
        token,
        "tools/call",
        { name: "search", arguments: { query: "A drawing" } },
        3,
      );
      const results = found.body.result.structuredContent.results;
      const hit = results.find((r) => r.id === scene.id);
      assert.ok(hit, JSON.stringify(found.body));
      assert.match(hit.url, /\/editor\?scene=/);
      const read = await rpc(
        token,
        "tools/call",
        { name: "fetch", arguments: { id: scene.id } },
        4,
      );
      assert.match(read.body.result.structuredContent.text, /MCP visible/);
      const folders = await rpc(
        token,
        "tools/call",
        { name: "list_collections", arguments: {} },
        5,
      );
      assert.ok(
        folders.body.result.structuredContent.collections.some(
          (c) => c.id === collection.id,
        ),
      );
      // a key carries its owner's limits: another member's private drawing stays hidden
      const member = await makeUser("mcp-reader");
      const hidden = await createDrawing(member.cookie, null, {
        private: true,
      });
      const memberKey = (
        await call("/admin/mcp-keys", {
          cookie: admin,
          method: "POST",
          body: { name: "Reader key", scope: "read" },
        })
      ).body.token;
      await db.query("UPDATE mcp_keys SET user_id=$2 WHERE token_hash=$1", [
        sha256(memberKey),
        member.id,
      ]);
      const adminScene = await createDrawing(admin, null, { private: true });
      const denied = await rpc(
        memberKey,
        "tools/call",
        { name: "fetch", arguments: { id: adminScene.id } },
        6,
      );
      assert.equal(denied.body.result.isError, true);
      const own = await rpc(
        memberKey,
        "tools/call",
        { name: "fetch", arguments: { id: hidden.id } },
        7,
      );
      assert.notEqual(own.body.result.isError, true);
      assert.equal(
        (
          await call(`/admin/mcp-keys/${created.body.id}`, {
            cookie: admin,
            method: "DELETE",
          })
        ).status,
        200,
      );
      assert.equal((await rpc(token, "initialize", hello)).status, 401);
    },
  );
  await t.test(
    "an assistant draws a diagram that opens as real shapes",
    async () => {
      const key = (
        await call("/admin/mcp-keys", {
          cookie: admin,
          method: "POST",
          body: { name: "Drawing key", scope: "write" },
        })
      ).body.token;
      const readOnly = (
        await call("/admin/mcp-keys", {
          cookie: admin,
          method: "POST",
          body: { name: "Reading key", scope: "read" },
        })
      ).body.token;
      const rpc = async (useKey, name, args, id = 1) => {
        const response = await fetch(origin + "/mcp", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Authorization: `Bearer ${useKey}`,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name, arguments: args },
          }),
        });
        const text = await response.text();
        return text.startsWith("event:")
          ? JSON.parse(text.slice(text.indexOf("data:") + 5).trim())
          : JSON.parse(text);
      };
      const tools = async (useKey) => {
        const response = await fetch(origin + "/mcp", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Authorization: `Bearer ${useKey}`,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 9,
            method: "tools/list",
            params: {},
          }),
        });
        const text = await response.text();
        const body = text.startsWith("event:")
          ? JSON.parse(text.slice(text.indexOf("data:") + 5).trim())
          : JSON.parse(text);
        return body.result.tools.map((tool) => tool.name);
      };
      // drawing tools appear only for a key allowed to write
      assert.ok((await tools(key)).includes("create_drawing"));
      assert.ok(!(await tools(readOnly)).includes("create_drawing"));
      const collection = await createCollection("Diagrams");
      const drawn = await rpc(key, "create_drawing", {
        name: "Cilium architecture",
        collection: collection.id,
        title: "Cilium",
        layout: "right",
        style: { font: "Inter", color: "blue" },
        nodes: [
          { id: "api", label: "k8s API Server" },
          { id: "op", label: "Cilium Operator" },
          { id: "agent", label: "DaemonSet Agent", color: "green" },
        ],
        edges: [
          { from: "api", to: "op", label: "watches" },
          { from: "op", to: "agent", label: "configures", style: "dashed" },
        ],
      });
      const made = drawn.result.structuredContent;
      assert.ok(made.id, JSON.stringify(drawn.result));
      assert.match(made.url, /\/editor\?scene=/);
      // the saved scene is a real drawing: shapes, labels and bound arrows
      const saved = (await call(`/scenes/${made.id}/data`, { cookie: admin }))
        .body.scene;
      const kinds = saved.elements.map((e) => e.type);
      assert.equal(kinds.filter((k) => k === "rectangle").length, 3);
      assert.equal(kinds.filter((k) => k === "arrow").length, 2);
      assert.ok(kinds.filter((k) => k === "text").length >= 5);
      const boxes = saved.elements.filter((e) => e.type === "rectangle");
      assert.ok(
        boxes.every((box) => box.width > 0 && box.height > 0),
        "every shape has a size",
      );
      assert.ok(
        new Set(boxes.map((box) => box.x)).size === 3,
        "boxes are laid out in sequence, not stacked",
      );
      const arrows = saved.elements.filter((e) => e.type === "arrow");
      assert.ok(
        arrows.every(
          (a) => a.startBinding?.elementId && a.endBinding?.elementId,
        ),
        "arrows stay attached to their boxes",
      );
      assert.ok(
        saved.elements.some((e) => e.text === "watches"),
        "arrow labels are drawn",
      );
      assert.equal(
        saved.elements.find((e) => e.text?.includes("API Server")).fontFamily,
        15,
        "the requested font is used",
      );
      // it lands in the collection it was asked for
      assert.ok(
        (
          await call(
            `/scenes?workspace=${workspace}&collection=${collection.id}`,
            { cookie: admin },
          )
        ).body.items.some((s) => s.id === made.id),
      );
      // redrawing replaces the contents and keeps the history
      const redrawn = await rpc(
        key,
        "update_drawing",
        {
          id: made.id,
          nodes: [{ id: "one", label: "Only box" }],
        },
        2,
      );
      assert.ok(redrawn.result.structuredContent.version > 1);
      const after = (await call(`/scenes/${made.id}/data`, { cookie: admin }))
        .body.scene;
      assert.equal(
        after.elements.filter((e) => e.type === "rectangle").length,
        1,
      );
      // a read-only key cannot draw
      const refused = await rpc(readOnly, "create_drawing", {
        name: "Not allowed",
        nodes: [{ id: "a", label: "a" }],
      });
      assert.ok(refused.error || refused.result?.isError);
      // nonsense input is rejected with a readable message
      const broken = await rpc(key, "create_drawing", {
        name: "Broken",
        nodes: [{ id: "a" }],
        edges: [{ from: "a", to: "ghost" }],
      });
      assert.match(
        JSON.stringify(broken.result ?? broken.error),
        /does not exist/,
      );
    },
  );
  await t.test(
    "icons from the workspace library are drawn inside the boxes",
    async () => {
      const key = (
        await call("/admin/mcp-keys", {
          cookie: admin,
          method: "POST",
          body: { name: "Icon key", scope: "write" },
        })
      ).body.token;
      // an icon already in the library, as an uploaded pack would be
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" fill="#326de6"/></svg>';
      const objectKey = `icons/${workspace}/testpack/${crypto.randomUUID()}.svg`;
      await mkdir(path.join(storage, path.dirname(objectKey)), {
        recursive: true,
      });
      await writeFile(path.join(storage, objectKey), svg);
      await db.query(
        `INSERT INTO icons(workspace_id,set_name,name,mime,s3_key,source,license)
         VALUES($1,'testpack','server','image/svg+xml',$2,'test','CC0')`,
        [workspace, objectKey],
      );
      const rpc = async (name, args, id = 1) => {
        const response = await fetch(origin + "/mcp", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name, arguments: args },
          }),
        });
        const text = await response.text();
        return text.startsWith("event:")
          ? JSON.parse(text.slice(text.indexOf("data:") + 5).trim())
          : JSON.parse(text);
      };
      const listed = await rpc("list_icons", {});
      assert.ok(
        listed.result.structuredContent.icons.includes("testpack/server"),
        "the library is listed for the assistant",
      );
      assert.equal(
        listed.result.structuredContent.fetching_allowed,
        false,
        "fetching from the internet stays off until an admin turns it on",
      );
      const drawn = await rpc(
        "create_drawing",
        {
          name: "With icons",
          nodes: [
            { id: "a", label: "API", icon: "testpack/server" },
            { id: "b", label: "Worker" },
          ],
          edges: [{ from: "a", to: "b" }],
        },
        2,
      );
      const made = drawn.result.structuredContent;
      const scene = (await call(`/scenes/${made.id}/data`, { cookie: admin }))
        .body.scene;
      const image = scene.elements.find((e) => e.type === "image");
      assert.ok(image, "the icon is placed as an image");
      assert.ok(
        scene.files[image.fileId]?.dataURL.startsWith("data:image/svg+xml"),
        "the icon travels with the drawing",
      );
      const box = scene.elements.find(
        (e) => e.type === "rectangle" && e.x === image.x - (e.width - 52) / 2,
      );
      assert.ok(box, "the icon sits inside its box");
      // an unknown icon leaves the drawing intact rather than failing
      const plain = await rpc(
        "create_drawing",
        {
          name: "Unknown icon",
          nodes: [{ id: "a", label: "API", icon: "testpack/missing" }],
        },
        3,
      );
      assert.ok(plain.result.structuredContent.id);
      assert.equal(
        (
          await call(`/scenes/${plain.result.structuredContent.id}/data`, {
            cookie: admin,
          })
        ).body.scene.elements.filter((e) => e.type === "image").length,
        0,
      );
    },
  );
  await t.test(
    "drawing listings credit the creator by display name",
    async () => {
      const author = await makeUser("mona");
      const scene = await createDrawing(author.cookie);
      const credited = async () =>
        (
          await call(`/scenes?workspace=${workspace}`, { cookie: admin })
        ).body.items.find((x) => x.id === scene.id)?.owner_name;
      // accounts without a display name keep showing their username
      assert.equal(await credited(), "mona");
      await db.query("UPDATE users SET display_name=$2 WHERE id=$1", [
        author.id,
        "Mona Lisa",
      ]);
      assert.equal(await credited(), "Mona Lisa");
    },
  );
  await t.test(
    "administrators read and edit private drawings without owning them",
    async () => {
      const owner = await makeUser("private-owner");
      const mine = await createDrawing(owner.cookie, null, { private: true });
      const adminId = (await call("/me", { cookie: admin })).body.id;
      assert.equal(
        (await call(`/scenes/${mine.id}/data`, { cookie: admin })).status,
        200,
      );
      assert.equal(
        (await call(`/scenes/${mine.id}/data`, { cookie: viewer.cookie }))
          .status,
        404,
      );
      const saved = await call(`/scenes/${mine.id}/data`, {
        cookie: admin,
        method: "PUT",
        body: {
          version: mine.version ?? 1,
          scene: {
            type: "excalidraw",
            version: 2,
            elements: [],
            appState: { viewBackgroundColor: "#0f0f0f" },
            files: {},
          },
        },
      });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      // the drawing stays owned by its author and out of the admin's own Private view
      assert.equal(
        (
          await db.query("SELECT private_owner_id FROM scenes WHERE id=$1", [
            mine.id,
          ])
        ).rows[0].private_owner_id,
        owner.id,
      );
      assert.equal(
        (
          await call(`/scenes?workspace=${workspace}&private=1`, {
            cookie: admin,
          })
        ).body.items.some((x) => x.id === mine.id),
        false,
      );
      assert.ok(
        (
          await call(`/scenes?workspace=${workspace}`, { cookie: admin })
        ).body.items.some((x) => x.id === mine.id),
      );
      assert.ok(adminId);
    },
  );
  await t.test(
    "sessions survive long idle periods and end only when they expire",
    async () => {
      const user = await makeUser("long-session");
      const expiry = async () =>
        (
          await db.query(
            "SELECT expires_at FROM sessions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1",
            [user.id],
          )
        ).rows[0].expires_at;
      const first = await expiry();
      // far beyond the old 30-minute idle cutoff
      await db.query(
        "UPDATE sessions SET last_seen_at=now()-interval '20 days' WHERE user_id=$1",
        [user.id],
      );
      assert.equal((await call("/me", { cookie: user.cookie })).status, 200);
      assert.ok(
        (await expiry()).getTime() >= first.getTime(),
        "each request slides the expiry forward",
      );
      assert.ok(
        (await expiry()).getTime() - Date.now() > 29 * 24 * 3600_000,
        "sessions last about a month from the last request",
      );
      await db.query(
        "UPDATE sessions SET expires_at=now()-interval '1 minute' WHERE user_id=$1",
        [user.id],
      );
      assert.equal((await call("/me", { cookie: user.cookie })).status, 401);
    },
  );
  await t.test(
    "collection restore recovers its scenes and workspace administration is gated",
    async () => {
      const c = await createCollection("Recover collection"),
        s = await createDrawing(admin, c.id);
      await call(`/collections/${c.id}`, { cookie: admin, method: "DELETE" });
      assert.equal(
        (
          await call(`/workspaces/${workspace}/collections`, { cookie: admin })
        ).body.some((x) => x.id === c.id),
        false,
      );
      assert.equal(
        (
          await call(`/collections/${c.id}/restore`, {
            cookie: admin,
            method: "POST",
          })
        ).status,
        200,
      );
      assert.ok(
        (
          await call(`/scenes?workspace=${workspace}&collection=${c.id}`, {
            cookie: admin,
          })
        ).body.items.some((x) => x.id === s.id),
      );
      assert.equal(
        (await call("/admin/workspaces", { cookie: editor.cookie })).status,
        403,
      );
      const created = await call("/admin/workspaces", {
        cookie: admin,
        method: "POST",
        body: { name: "New workspace" },
      });
      assert.equal(created.status, 201);
      assert.equal(
        (
          await call(`/admin/workspaces/${created.body.id}`, {
            cookie: admin,
            method: "PATCH",
            body: { name: "Renamed workspace" },
          })
        ).body.name,
        "Renamed workspace",
      );
    },
  );
  await t.test(
    "restoring history preserves newer versions and rejects stale edits",
    async () => {
      const s = await createDrawing(),
        payload = {
          type: "excalidraw",
          version: 2,
          elements: [],
          appState: { viewBackgroundColor: "#abcdef" },
          files: {},
        };
      // edits in one sitting share a restore point, so age the first one as if
      // the drawing were reopened on another day
      await db.query(
        "UPDATE scene_versions SET created_at=now()-interval '20 minutes' WHERE scene_id=$1",
        [s.id],
      );
      assert.equal(
        (
          await call(`/scenes/${s.id}/data`, {
            cookie: admin,
            method: "PUT",
            body: { version: 1, scene: payload },
          })
        ).status,
        200,
      );
      const history = (
        await call(`/scenes/${s.id}/versions`, { cookie: admin })
      ).body;
      assert.equal(history.items.length, 2);
      const first = history.items.find((x) => x.scene_version === 1);
      assert.equal(
        (
          await call(`/scenes/${s.id}/versions/${first.id}/restore`, {
            cookie: viewer.cookie,
            method: "POST",
            body: { version: 2 },
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await call(`/scenes/${s.id}/versions/${first.id}/restore`, {
            cookie: admin,
            method: "POST",
            body: { version: 1 },
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await call(`/scenes/${s.id}/versions/${first.id}/restore`, {
            cookie: admin,
            method: "POST",
            body: { version: 2 },
          })
        ).body.version,
        3,
      );
      const after = (await call(`/scenes/${s.id}/versions`, { cookie: admin }))
        .body;
      assert.equal(after.items.length, 3);
      assert.notEqual(
        (await call(`/scenes/${s.id}/data`, { cookie: admin })).body.scene
          .appState.viewBackgroundColor,
        "#abcdef",
      );
    },
  );
  await t.test(
    "bulk trash is atomic when a selected scene is inaccessible",
    async () => {
      const mine = await createDrawing(),
        unreachable = crypto.randomUUID();
      assert.equal(
        (
          await call("/scenes/bulk", {
            cookie: admin,
            method: "POST",
            body: { ids: [mine.id, unreachable], action: "trash" },
          })
        ).status,
        404,
      );
      assert.equal(
        (await call(`/scenes/${mine.id}/data`, { cookie: admin })).status,
        200,
      );
      assert.equal(
        (
          await call("/scenes/bulk", {
            cookie: admin,
            method: "POST",
            body: { ids: [mine.id], action: "trash" },
          })
        ).status,
        200,
      );
      assert.equal(
        (await call(`/scenes/${mine.id}/data`, { cookie: admin })).status,
        404,
      );
      assert.equal(
        (
          await call("/scenes/bulk", {
            cookie: admin,
            method: "POST",
            body: { ids: [mine.id], action: "restore" },
          })
        ).status,
        200,
      );
    },
  );
  await t.test(
    "team access applies to listings, payloads and trash without broadening access",
    async () => {
      const c = await createCollection("Team-only collection"),
        scene = await createDrawing(admin, c.id);
      const team = await call(`/admin/workspaces/${workspace}/teams`, {
        cookie: admin,
        method: "POST",
        body: { name: "Design team", color: "#6965db", members: [editor.id] },
      });
      assert.equal(team.status, 201, JSON.stringify(team.body));
      assert.equal(
        (
          await call(`/admin/workspaces/${workspace}/teams`, {
            cookie: viewer.cookie,
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await call(`/admin/collections/${c.id}/access`, {
            cookie: admin,
            method: "PUT",
            body: {
              restricted: true,
              teams: [team.body.id],
              version: c.version,
            },
          })
        ).status,
        200,
      );
      assert.equal(
        (await call(`/scenes/${scene.id}/data`, { cookie: editor.cookie }))
          .status,
        200,
      );
      assert.equal(
        (await call(`/scenes/${scene.id}/data`, { cookie: viewer.cookie }))
          .status,
        404,
      );
      assert.equal(
        (
          await call(`/scenes?workspace=${workspace}`, {
            cookie: viewer.cookie,
          })
        ).body.items.some((x) => x.id === scene.id),
        false,
      );
      assert.equal(
        (
          await call(`/workspaces/${workspace}/collections`, {
            cookie: viewer.cookie,
          })
        ).body.some((x) => x.id === c.id),
        false,
      );
      await call(`/collections/${c.id}`, { cookie: admin, method: "DELETE" });
      assert.equal(
        (await call(`/scenes/${scene.id}/data`, { cookie: viewer.cookie }))
          .status,
        404,
      );
      await call(`/collections/${c.id}/restore`, {
        cookie: admin,
        method: "POST",
      });
      assert.equal(
        (
          await call(`/admin/workspaces/${workspace}/teams/${team.body.id}`, {
            cookie: admin,
            method: "PATCH",
            body: {
              name: "Design team",
              color: "#6965db",
              members: [],
              version: 1,
            },
          })
        ).status,
        200,
      );
      assert.equal(
        (await call(`/scenes/${scene.id}/data`, { cookie: editor.cookie }))
          .status,
        404,
      );
      assert.equal(
        (
          await call(`/admin/workspaces/${otherWorkspace}/teams`, {
            cookie: admin,
            method: "POST",
            body: {
              name: "Invalid cross-workspace team",
              color: "#6965db",
              members: [editor.id],
            },
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await db.query(
            "SELECT 1 FROM workspace_teams WHERE name='Invalid cross-workspace team'",
          )
        ).rowCount,
        0,
      );
    },
  );
  await t.test(
    "first workspace loads establish one persistent collaboration room",
    async () => {
      const scene = await createDrawing();
      const loads = await Promise.all([
        call(`/scenes/${scene.id}/data`, { cookie: admin }),
        call(`/scenes/${scene.id}/data`, { cookie: editor.cookie }),
      ]);
      assert.deepEqual(
        loads.map((result) => result.status),
        [200, 200],
      );
      assert.match(
        loads[0].body.collaboration.roomId,
        /^[a-zA-Z0-9_-]{10,100}$/,
      );
      // the editor only accepts 22-character keys and hex room ids
      assert.match(loads[0].body.collaboration.roomKey, /^[a-zA-Z0-9_-]{22}$/);
      assert.match(loads[0].body.collaboration.roomId, /^[0-9a-f]{20}$/);
      assert.deepEqual(
        loads[1].body.collaboration,
        loads[0].body.collaboration,
      );
      assert.equal(loads[0].body.room_id, loads[0].body.collaboration.roomId);
      const stored = (
        await db.query(
          "SELECT room_id,encrypted_key FROM scene_room_keys WHERE scene_id=$1",
          [scene.id],
        )
      ).rows[0];
      assert.equal(stored.room_id, loads[0].body.collaboration.roomId);
      assert.notEqual(
        stored.encrypted_key,
        loads[0].body.collaboration.roomKey,
      );
    },
  );
  await t.test(
    "collaboration snapshots converge without lost elements or stale resurrection",
    async () => {
      const s = await createDrawing(),
        room = "test-collab-" + crypto.randomUUID();
      // age the creation point so the saves below become their own restore points
      await db.query(
        "UPDATE scene_versions SET created_at=now()-interval '20 minutes' WHERE scene_id=$1",
        [s.id],
      );
      assert.equal(
        (
          await call(`/scenes/${s.id}/room`, {
            cookie: admin,
            method: "POST",
            body: { room_id: room },
          })
        ).status,
        200,
      );
      const payload = (elements) => ({
        type: "excalidraw",
        version: 2,
        elements,
        appState: {},
        files: {},
      });
      const a = {
          id: "a",
          type: "rectangle",
          version: 1,
          versionNonce: 10,
          index: "a0",
        },
        b = {
          id: "b",
          type: "ellipse",
          version: 1,
          versionNonce: 20,
          index: "a1",
        };
      const saves = await Promise.all(
        [
          [admin, a],
          [editor.cookie, b],
        ].map(([cookie, element]) =>
          call(`/scenes/${s.id}/data`, {
            cookie,
            method: "PUT",
            body: { version: 1, room_id: room, scene: payload([element]) },
          }),
        ),
      );
      assert.deepEqual(
        saves.map((x) => x.status),
        [200, 200],
      );
      let loaded = (await call(`/scenes/${s.id}/data`, { cookie: admin })).body;
      assert.equal(loaded.version, 3);
      assert.deepEqual(
        loaded.scene.elements.map((x) => x.id),
        ["a", "b"],
      );
      assert.equal(
        (
          await call(`/scenes/${s.id}/data`, {
            cookie: admin,
            method: "PUT",
            body: {
              version: 3,
              room_id: room,
              scene: payload([{ ...a, version: 2, isDeleted: true }]),
            },
          })
        ).status,
        200,
      );
      await call(`/scenes/${s.id}/data`, {
        cookie: editor.cookie,
        method: "PUT",
        body: { version: 1, room_id: room, scene: payload([a, b]) },
      });
      loaded = (await call(`/scenes/${s.id}/data`, { cookie: admin })).body;
      assert.equal(
        loaded.scene.elements.find((x) => x.id === "a").isDeleted,
        true,
      );
      assert.equal(loaded.scene.elements.length, 2);
      assert.equal(
        (
          await call(`/scenes/${s.id}/data`, {
            cookie: admin,
            method: "PUT",
            body: {
              version: 1,
              room_id: "unrelated-room",
              scene: payload([a]),
            },
          })
        ).status,
        409,
      );
      const history = (
        await call(`/scenes/${s.id}/versions`, { cookie: admin })
      ).body;
      await call(
        `/scenes/${s.id}/versions/${
          history.items.find((v) => v.scene_version === 1).id
        }/restore`,
        { cookie: admin, method: "POST", body: { version: loaded.version } },
      );
      assert.equal(
        (await call(`/rooms/${room}/scene`, { cookie: editor.cookie })).status,
        404,
      );
    },
  );
  await t.test(
    "saved collaboration keys are protected and reused only after scene authorization",
    async () => {
      const s = await createDrawing(),
        room = "persistent-" + crypto.randomUUID(),
        // a 128-bit key, the only size the editor accepts (22 base64url chars)
        key = crypto.randomBytes(16).toString("base64url");
      const first = await call(`/scenes/${s.id}/room`, {
        cookie: admin,
        method: "POST",
        body: { room_id: room, room_key: key },
      });
      assert.equal(first.status, 200);
      const repeat = await call(`/scenes/${s.id}/room`, {
        cookie: admin,
        method: "POST",
        body: {
          room_id: "another-" + crypto.randomUUID(),
          room_key: crypto.randomBytes(16).toString("base64url"),
        },
      });
      assert.deepEqual(repeat.body, first.body);
      assert.notEqual(
        (
          await db.query(
            "SELECT encrypted_key FROM scene_room_keys WHERE scene_id=$1",
            [s.id],
          )
        ).rows[0].encrypted_key,
        key,
      );
      assert.deepEqual(
        (await call(`/scenes/${s.id}/data`, { cookie: viewer.cookie })).body
          .collaboration,
        { roomId: room, roomKey: key },
      );
      assert.equal((await call(`/scenes/${s.id}/data`)).status, 401);
      const privateScene = await createDrawing(editor.cookie, null, {
        private: true,
      });
      const privateRoom = "private-" + crypto.randomUUID();
      await call(`/scenes/${privateScene.id}/room`, {
        cookie: editor.cookie,
        method: "POST",
        body: { room_id: privateRoom, room_key: key },
      });
      // a private drawing keeps its room key from everyone but its owner and administrators
      assert.equal(
        (
          await call(`/scenes/${privateScene.id}/data`, {
            cookie: viewer.cookie,
          })
        ).status,
        404,
      );
      assert.deepEqual(
        (await call(`/scenes/${privateScene.id}/data`, { cookie: admin })).body
          .collaboration,
        { roomId: privateRoom, roomKey: key },
      );
    },
  );
  await t.test(
    "recovery is generic and deduplicated; token replays and wrong purpose reject",
    async () => {
      const first = await call("/auth/forgot-password", {
          method: "POST",
          body: { username: "editor" },
        }),
        missing = await call("/auth/forgot-password", {
          method: "POST",
          body: { username: "missing" },
        });
      assert.deepEqual(first.body, missing.body);
      await call("/auth/forgot-password", {
        method: "POST",
        body: { username: "EDITOR" },
      });
      assert.equal(
        (
          await db.query(
            "SELECT 1 FROM password_reset_requests WHERE user_id=$1 AND status='pending'",
            [editor.id],
          )
        ).rowCount,
        1,
      );
      assert.equal((await call("/me", { cookie: editor.cookie })).status, 200);
      const issued = await call(`/admin/users/${editor.id}/password-link`, {
        cookie: admin,
        method: "POST",
        body: { identity_verified: true },
      });
      const token = new URL(issued.body.url).hash.slice(7),
        body = {
          token,
          purpose: "reset",
          password: "New secret for orchard and library 98",
          confirmation: "New secret for orchard and library 98",
        };
      assert.equal(
        (
          await call("/auth/reset-password", {
            method: "POST",
            body: { ...body, purpose: "setup" },
          })
        ).status,
        400,
      );
      const results = await Promise.all(
        [1, 2].map(() =>
          call("/auth/reset-password", { method: "POST", body }),
        ),
      );
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
      assert.equal((await call("/me", { cookie: editor.cookie })).status, 401);
    },
  );
  await t.test(
    "last administrator check and immediately applied overrides",
    async () => {
      const users = (await call("/admin/users", { cookie: admin })).body.items,
        adminUser = users.find((u) => u.username === "admin");
      const result = await call(`/admin/users/${adminUser.id}`, {
        cookie: admin,
        method: "PATCH",
        body: { ...adminUser, is_active: false },
      });
      assert.equal(result.status, 409);
      const v = users.find((u) => u.id === viewer.id);
      const updated = await call(`/admin/users/${v.id}`, {
        cookie: admin,
        method: "PATCH",
        body: {
          ...v,
          assignments: [
            {
              workspace_id: workspace,
              role: "viewer",
              overrides: {
                "collection.create": "allow",
                "collection.delete": "deny",
              },
            },
          ],
        },
      });
      assert.equal(updated.status, 200, JSON.stringify(updated.body));
      assert.equal((await call("/me", { cookie: viewer.cookie })).status, 401);
      viewer.cookie = await login("viewer");
      const c = await createCollection("Allowed override", viewer.cookie);
      assert.equal(
        (
          await call(`/collections/${c.id}`, {
            cookie: viewer.cookie,
            method: "DELETE",
          })
        ).status,
        403,
      );
    },
  );
  await t.test(
    "reauthentication, token expiry, regeneration and deactivation",
    async () => {
      const u = await makeUser("lifecycle");
      const issue = () =>
        call(`/admin/users/${u.id}/password-link`, {
          cookie: admin,
          method: "POST",
          body: { identity_verified: true },
        });
      const first = await issue(),
        second = await issue();
      const tokenA = new URL(first.body.url).hash.slice(7),
        tokenB = new URL(second.body.url).hash.slice(7);
      assert.equal(
        (
          await call("/auth/check-token", {
            method: "POST",
            body: { token: tokenA, purpose: "reset" },
          })
        ).status,
        400,
      );
      await db.query(
        "UPDATE password_tokens SET expires_at=now()-interval '1 second' WHERE user_id=$1",
        [u.id],
      );
      assert.equal(
        (
          await call("/auth/check-token", {
            method: "POST",
            body: { token: tokenB, purpose: "reset" },
          })
        ).status,
        400,
      );
      await db.query(
        "UPDATE sessions SET reauthenticated_at=now()-interval '6 minutes' WHERE user_id=(SELECT id FROM users WHERE username='admin')",
      );
      assert.equal((await issue()).status, 403);
      const refreshed = await call("/auth/reauthenticate", {
        cookie: admin,
        method: "POST",
        body: { password },
      });
      assert.equal(refreshed.status, 200);
      admin = refreshed.cookie;
      const row = (
        await call("/admin/users?search=lifecycle", { cookie: admin })
      ).body.items[0];
      assert.equal(
        (
          await call(`/admin/users/${u.id}`, {
            cookie: admin,
            method: "PATCH",
            body: { ...row, is_active: false },
          })
        ).status,
        200,
      );
      assert.equal((await call("/me", { cookie: u.cookie })).status, 401);
      assert.equal(
        (
          await call("/auth/login", {
            method: "POST",
            body: { username: "lifecycle", password },
          })
        ).body.error,
        "Invalid username or password.",
      );
      assert.equal(
        (
          await call(`/admin/users/${u.id}`, {
            cookie: admin,
            method: "PATCH",
            body: { ...row, is_active: true },
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await call("/auth/check-token", {
            method: "POST",
            body: { token: tokenB, purpose: "reset" },
          })
        ).status,
        400,
      );
    },
  );
  await t.test(
    "deleting a user removes only the account and keeps their content",
    async () => {
      const adminId = (await call("/me", { cookie: admin })).body.id;
      const gone = await makeUser("departing");
      const shared = await createDrawing(gone.cookie);
      const hidden = await createDrawing(gone.cookie, null, { private: true });
      const collection = await createCollection("Departing work", gone.cookie);
      const remove = (id, cookie = admin) =>
        call(`/admin/users/${id}`, { cookie, method: "DELETE" });
      assert.equal((await remove(adminId, gone.cookie)).status, 403);
      assert.equal((await remove(adminId)).status, 409);
      assert.equal((await remove(gone.id)).status, 200);
      assert.equal((await remove(gone.id)).status, 404);
      assert.equal((await call("/me", { cookie: gone.cookie })).status, 401);
      assert.equal(
        (await db.query("SELECT 1 FROM users WHERE id=$1", [gone.id])).rowCount,
        0,
      );
      const scenes = await db.query(
        "SELECT id,private_owner_id FROM scenes WHERE id=ANY($1) AND deleted_at IS NULL",
        [[shared.id, hidden.id]],
      );
      assert.equal(scenes.rowCount, 2);
      assert.equal(
        scenes.rows.find((s) => s.id === hidden.id).private_owner_id,
        adminId,
      );
      assert.equal(
        (await call(`/scenes/${hidden.id}/versions`, { cookie: admin })).status,
        200,
      );
      assert.equal(
        (
          await db.query(
            "SELECT 1 FROM collections WHERE id=$1 AND deleted_at IS NULL",
            [collection.id],
          )
        ).rowCount,
        1,
      );
      const entry = await db.query(
        "SELECT metadata FROM audit_log WHERE action='user.delete' AND target_id=$1",
        [gone.id],
      );
      assert.equal(entry.rows[0].metadata.username, "departing");
      const list = (await call("/admin/users", { cookie: admin })).body.items;
      assert.equal(list[0].is_superadmin, true);
    },
  );
  await t.test(
    "two administrators deleting each other always leave one administrator",
    async () => {
      const created = await call("/admin/users", {
        cookie: admin,
        method: "POST",
        body: {
          username: "second-admin",
          is_superadmin: true,
          confirm_global_admin: true,
          assignments: [],
        },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      await call("/auth/reset-password", {
        method: "POST",
        body: {
          token: new URL(created.body.url).hash.slice(7),
          purpose: "setup",
          password,
          confirmation: password,
        },
      });
      const second = (
        await call("/auth/reauthenticate", {
          cookie: await login("second-admin"),
          method: "POST",
          body: { password },
        })
      ).cookie;
      const adminId = (await call("/me", { cookie: admin })).body.id;
      const results = await Promise.all([
        call(`/admin/users/${created.body.id}`, {
          cookie: admin,
          method: "DELETE",
        }),
        call(`/admin/users/${adminId}`, { cookie: second, method: "DELETE" }),
      ]);
      assert.deepEqual(
        results.map((r) => r.status).sort(),
        [200, 409],
        JSON.stringify(results.map((r) => r.body)),
      );
      const remaining = await db.query(
        "SELECT username FROM users WHERE is_superadmin AND is_active AND NOT pending_setup",
      );
      assert.equal(remaining.rowCount, 1);
      if (remaining.rows[0].username !== "admin")
        throw new Error("Later tests rely on the original admin account.");
    },
  );
  await t.test(
    "authenticated collaboration rejects viewers sending encrypted mutations and revokes connections",
    async () => {
      const drawing = await createDrawing(),
        room = "room_" + crypto.randomBytes(10).toString("hex");
      assert.equal(
        (
          await call(`/scenes/${drawing.id}/room`, {
            cookie: admin,
            method: "POST",
            body: { room_id: room },
          })
        ).status,
        200,
      );
      const connect = async (cookie) => {
        const socket = socketClient(origin, {
          transports: ["websocket"],
          extraHeaders: { Origin: origin, Cookie: cookie },
          reconnection: false,
        });
        await new Promise((resolve, reject) => {
          socket.on("init-room", () => {
            socket.emit("join-room", room);
          });
          socket.on("room-user-change", () => resolve());
          socket.on("connect_error", reject);
          setTimeout(
            () => reject(new Error("Socket connect timed out")),
            4000,
          ).unref();
        });
        return socket;
      };
      const writer = await connect(admin),
        reader = await connect(viewer.cookie);
      try {
        const incoming = once(reader, "client-broadcast");
        writer.emit(
          "server-broadcast",
          room,
          Buffer.from("encrypted"),
          Buffer.alloc(12),
        );
        assert.equal((await incoming)[0].toString(), "encrypted");
        const disconnected = once(reader, "disconnect");
        reader.emit(
          "server-broadcast",
          room,
          Buffer.from("illicit"),
          Buffer.alloc(12),
        );
        await disconnected;
        const second = await connect(viewer.cookie);
        const kicked = once(second, "disconnect");
        const row = (
          await call("/admin/users?search=viewer", { cookie: admin })
        ).body.items[0];
        await call(`/admin/users/${viewer.id}`, {
          cookie: admin,
          method: "PATCH",
          body: { ...row, is_active: false },
        });
        await kicked;
        second.close();
      } finally {
        writer.close();
        reader.close();
      }
    },
  );
  await t.test(
    "dashboard DOM forms use the real backend for sign-in, collections and admin setup links",
    async () => {
      const html = await readFile(
        new URL("../../dashboard/index.html", import.meta.url),
        "utf8",
      );
      const dom = new JSDOM(html, { url: origin, runScripts: "outside-only" }),
        win = dom.window;
      let cookie = "";
      const errors = [];
      win.addEventListener("error", (e) => errors.push(e.message));
      win.HTMLDialogElement.prototype.showModal = function () {
        this.open = true;
      };
      win.HTMLDialogElement.prototype.close = function () {
        this.open = false;
        this.dispatchEvent(new win.Event("close"));
      };
      win.BroadcastChannel = class {
        postMessage() {}
        close() {}
      };
      win.crypto.randomUUID = () => crypto.randomUUID();
      win.fetch = async (url, options = {}) => {
        const response = await fetch(new URL(url, origin), {
          ...options,
          headers: {
            ...options.headers,
            Origin: origin,
            ...(cookie ? { Cookie: cookie } : {}),
          },
        });
        for (const value of response.headers.getSetCookie())
          if (value.startsWith("ex_session=")) cookie = value.split(";")[0];
        return response;
      };
      const wait = async (predicate) => {
        for (let i = 0; i < 500; i++) {
          if (predicate()) return;
          await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error(
          "DOM state timed out: " + win.document.body.textContent.slice(-1500),
        );
      };
      const set = (name, value) => {
        win.document.querySelector(`[name="${name}"]`).value = value;
      };
      const submit = (selector) =>
        win.document
          .querySelector(selector)
          .dispatchEvent(
            new win.Event("submit", { bubbles: true, cancelable: true }),
          );
      const click = (selector) => win.document.querySelector(selector).click();
      try {
        const catalog = (
          await readFile(
            new URL("../../dashboard/permissions.js", import.meta.url),
            "utf8",
          )
        ).replaceAll("export ", "");
        const source = (
          await readFile(
            new URL("../../dashboard/app.js", import.meta.url),
            "utf8",
          )
        ).replace(/^import .*;\n/gm, "");
        const ui = (
          await readFile(
            new URL("../../dashboard/ui.js", import.meta.url),
            "utf8",
          )
        ).replaceAll("export ", "");
        win.eval(`(()=>{${catalog}\n${ui}\n${source}})()`);
        await wait(() => win.document.querySelector("[name=username]"));
        set("username", "admin");
        set("password", "incorrect");
        submit(".login-card");
        await wait(
          () =>
            win.document.querySelector(".error")?.textContent ===
            "Invalid username or password.",
        );
        assert.equal(
          win.document.querySelector("[name=username]").value,
          "admin",
        );
        set("password", password);
        submit(".login-card");
        await wait(() => win.document.querySelector("#new-collection"));
        click("#new-collection");
        set("name", "DOM collection");
        submit("#dialog form");
        await wait(() =>
          win.document
            .querySelector("#page h1")
            ?.textContent.includes("DOM collection"),
        );
        click('a[href="/admin/users"]');
        await wait(() => win.document.querySelector("#create-user"));
        click("#create-user");
        await wait(() => win.document.querySelector("#dialog [name=password]"));
        set("password", password);
        submit("#dialog form");
        await wait(() => win.document.querySelector("#dialog [name=username]"));
        set("username", "dom-created-user");
        submit("#dialog form");
        await wait(() => win.document.querySelector("#dialog textarea"));
        assert.match(
          win.document.querySelector("#dialog textarea").value,
          /set-password#token=/,
        );
        assert.equal(
          (
            await db.query(
              "SELECT pending_setup FROM users WHERE username='dom-created-user'",
            )
          ).rows[0].pending_setup,
          true,
        );
        assert.deepEqual(errors, []);
      } finally {
        win.close();
      }
    },
  );
  await t.test(
    "concurrent demotions preserve one active administrator",
    async () => {
      const created = await call("/admin/users", {
        cookie: admin,
        method: "POST",
        body: {
          username: "second-admin",
          is_superadmin: true,
          confirm_global_admin: true,
          assignments: [],
        },
      });
      assert.equal(created.status, 201);
      const token = new URL(created.body.url).hash.slice(7);
      assert.equal(
        (
          await call("/auth/reset-password", {
            method: "POST",
            body: { token, purpose: "setup", password, confirmation: password },
          })
        ).status,
        200,
      );
      const secondCookie = await login("second-admin");
      const rows = (await call("/admin/users?search=admin", { cookie: admin }))
        .body.items;
      const first = rows.find((u) => u.username === "admin"),
        second = rows.find((u) => u.username === "second-admin");
      const results = await Promise.all(
        [
          [first, admin],
          [second, secondCookie],
        ].map(([user, cookie]) =>
          call(`/admin/users/${user.id}`, {
            cookie,
            method: "PATCH",
            body: { ...user, is_superadmin: false },
          }),
        ),
      );
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM users WHERE is_superadmin AND is_active AND NOT pending_setup",
          )
        ).rows[0].n,
        1,
      );
    },
  );
});
