import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { io as socketClient } from "socket.io-client";
import { JSDOM } from "jsdom";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { hashPassword } from "../lib/passwords.js";
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
  await t.test("password policy accepts eight characters and rejects seven", async () => {
    await assert.doesNotReject(() => hashPassword("K7!mQ2#z"));
    assert.throws(
      () => hashPassword("K7!mQ2#"),
      /Use 8–128 characters/,
    );
  });
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
      assert.equal(
        (await call(`/scenes/${s.id}/data`, { cookie: admin })).status,
        404,
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
        privateScene = await createDrawing(editor.cookie, null, {
          private: true,
        });
      assert.equal(
        (
          await call("/scenes/bulk", {
            cookie: admin,
            method: "POST",
            body: { ids: [mine.id, privateScene.id], action: "trash" },
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
      assert.match(loads[0].body.collaboration.roomId, /^[a-zA-Z0-9_-]{10,100}$/);
      assert.match(loads[0].body.collaboration.roomKey, /^[a-zA-Z0-9_-]{20,100}$/);
      assert.deepEqual(loads[1].body.collaboration, loads[0].body.collaboration);
      assert.equal(loads[0].body.room_id, loads[0].body.collaboration.roomId);
      const stored = (
        await db.query(
          "SELECT room_id,encrypted_key FROM scene_room_keys WHERE scene_id=$1",
          [scene.id],
        )
      ).rows[0];
      assert.equal(stored.room_id, loads[0].body.collaboration.roomId);
      assert.notEqual(stored.encrypted_key, loads[0].body.collaboration.roomKey);
    },
  );
  await t.test(
    "collaboration snapshots converge without lost elements or stale resurrection",
    async () => {
      const s = await createDrawing(),
        room = "test-collab-" + crypto.randomUUID();
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
        key = crypto.randomBytes(32).toString("base64url");
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
          room_key: crypto.randomBytes(32).toString("base64url"),
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
      await call(`/scenes/${privateScene.id}/room`, {
        cookie: editor.cookie,
        method: "POST",
        body: { room_id: "private-" + crypto.randomUUID(), room_key: key },
      });
      assert.equal(
        (await call(`/scenes/${privateScene.id}/data`, { cookie: admin }))
          .status,
        404,
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
