// Disposable local browser-verification fixture; never used by production startup.
import pg from "pg";
import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashPassword } from "../lib/passwords.js";
const base = process.env.TEST_DATABASE_URL;
if (!base || !["localhost", "127.0.0.1"].includes(new URL(base).hostname))
  throw new Error("An isolated localhost TEST_DATABASE_URL is required.");
const control = new pg.Pool({ connectionString: base });
const name = "excalidraw_browser_" + process.pid;
await control.query(`CREATE DATABASE ${name}`);
await control.end();
const url = new URL(base);
url.pathname = "/" + name;
const db = new pg.Pool({ connectionString: url.href });
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
])
  await db.query(
    await readFile(new URL("../" + file, import.meta.url), "utf8"),
  );
const user = await db.query(
  "INSERT INTO users(username,password_hash,is_superadmin) VALUES('browser-admin',$1,true) RETURNING id",
  [await hashPassword("Local browser verification password 2026!")],
);
await db.query(
  "INSERT INTO workspaces(name,slug,owner_id) VALUES('Design workspace','design',$1)",
  [user.rows[0].id],
);
await db.end();
process.env.DATABASE_URL = url.href;
process.env.PORT = process.env.BROWSER_PORT || "55442";
process.env.APP_ORIGIN = "http://127.0.0.1:" + process.env.PORT;
process.env.COOKIE_SECURE = "false";
process.env.JWT_SECRET = "disposable-browser-fixture-secret-not-production";
process.env.LOCAL_STORAGE_ROOT = await mkdtemp(
  path.join(tmpdir(), "excalidraw-browser-"),
);
await writeFile(
  "/private/tmp/excalidraw-browser-fixture.json",
  JSON.stringify({
    database: name,
    storage: process.env.LOCAL_STORAGE_ROOT,
    url: url.href,
  }),
);
await import("../server.js");
