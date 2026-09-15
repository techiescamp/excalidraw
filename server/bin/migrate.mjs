import pg from "pg";
import { readFile } from "node:fs/promises";
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = await db.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(4271900)");
  await client.query("CREATE EXTENSION IF NOT EXISTS citext");
  await client.query(
    "CREATE TABLE IF NOT EXISTS app_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const files = [
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
  ];
  const checks = [
    "users",
    "collections",
    "app_settings",
    null,
    "creation_requests",
    "scene_visits",
    "workspace_teams",
    "scene_room_keys",
    "workspace_exports",
    "workspace_cleanup_objects",
  ];
  for (const [index, file] of files.entries()) {
    if (
      (await client.query("SELECT 1 FROM app_migrations WHERE name=$1", [file]))
        .rowCount
    )
      continue;
    const exists = checks[index]
      ? (
          await client.query("SELECT to_regclass($1) AS present", [
            checks[index],
          ])
        ).rows[0].present
      : index === 3
      ? (
          await client.query(
            "SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='users' AND column_name='username'",
          )
        ).rowCount
      : false;
    if (!exists)
      await client.query(
        await readFile(new URL("../" + file, import.meta.url), "utf8"),
      );
    await client.query("INSERT INTO app_migrations(name) VALUES($1)", [file]);
    console.log(file, exists ? "adopted existing schema" : "applied");
  }
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK");
  console.error("Migration failed; no changes committed:", error.message);
  process.exitCode = 1;
} finally {
  client.release();
  await db.end();
}
