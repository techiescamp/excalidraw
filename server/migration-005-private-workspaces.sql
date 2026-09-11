-- Run once, in a transaction, after migrations 002–004. Existing ownership stays intact.
ALTER TABLE users ADD COLUMN pending_setup boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN credential_version integer NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX users_canonical_username ON users (lower(username::text));
CREATE TABLE sessions (
 token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
 credential_version integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 last_seen_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 reauthenticated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON sessions(user_id);
CREATE TABLE password_tokens (
 token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
 purpose text NOT NULL CHECK (purpose IN ('setup','reset')), expires_at timestamptz NOT NULL,
 consumed_at timestamptz, revoked_at timestamptz, issued_by uuid REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON password_tokens(user_id);
CREATE TABLE password_reset_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id),
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved','rejected')),
 created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz, resolved_by uuid REFERENCES users(id)
);
CREATE UNIQUE INDEX reset_pending_user ON password_reset_requests(user_id) WHERE status='pending';
CREATE TABLE permission_overrides (
 user_id uuid NOT NULL, workspace_id uuid NOT NULL, permission text NOT NULL,
 effect text NOT NULL CHECK (effect IN ('allow','deny')),
 PRIMARY KEY(user_id, workspace_id, permission),
 FOREIGN KEY(workspace_id,user_id) REFERENCES workspace_members(workspace_id,user_id) ON DELETE CASCADE
);
CREATE TABLE auth_rate_limits (key text PRIMARY KEY, hits integer NOT NULL, expires_at timestamptz NOT NULL);
ALTER TABLE collections ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE collections ADD COLUMN normalized_name text;
-- PostgreSQL UTF8 normalization; collision aborts migration for explicit operator resolution.
UPDATE collections SET name=btrim(name), normalized_name=lower(normalize(btrim(name), NFKC));
ALTER TABLE collections ALTER COLUMN normalized_name SET NOT NULL;
ALTER TABLE collections ADD CONSTRAINT collections_valid_name CHECK(char_length(name) BETWEEN 1 AND 80);
CREATE UNIQUE INDEX collections_normalized_unique ON collections(workspace_id, normalized_name);
ALTER TABLE collections ADD CONSTRAINT collections_workspace_key UNIQUE(workspace_id,id);
ALTER TABLE scenes ADD CONSTRAINT scenes_workspace_key UNIQUE(workspace_id,id);
ALTER TABLE scenes ADD COLUMN collab_s3_key text;
ALTER TABLE scenes ADD COLUMN metadata_version integer NOT NULL DEFAULT 1;
CREATE TABLE collection_drawings (
 workspace_id uuid NOT NULL, collection_id uuid NOT NULL, drawing_id uuid NOT NULL,
 added_by uuid REFERENCES users(id), added_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(collection_id,drawing_id),
 FOREIGN KEY(workspace_id,collection_id) REFERENCES collections(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,drawing_id) REFERENCES scenes(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX ON collection_drawings(drawing_id);
-- A legacy cross-workspace association must be investigated, never silently exposed.
INSERT INTO collection_drawings(workspace_id,collection_id,drawing_id)
 SELECT workspace_id,collection_id,id FROM scenes WHERE collection_id IS NOT NULL;
CREATE TABLE creation_requests (
 user_id uuid NOT NULL REFERENCES users(id), request_id uuid NOT NULL,
 kind text NOT NULL, fingerprint text NOT NULL, result jsonb NOT NULL,
 PRIMARY KEY(user_id,request_id)
);
-- Old bearer sessions must not survive the authentication migration.
UPDATE refresh_tokens SET revoked_at=now() WHERE revoked_at IS NULL;

-- Preserve historical private collection restrictions independently of future membership/deletion.
CREATE TABLE legacy_scene_visibility (
 scene_id uuid PRIMARY KEY REFERENCES scenes(id) ON DELETE CASCADE,
 visible_to uuid NOT NULL REFERENCES users(id)
);
INSERT INTO legacy_scene_visibility(scene_id,visible_to)
 SELECT s.id,c.created_by FROM scenes s JOIN collections c ON c.id=s.collection_id WHERE c.is_private;

-- Tables created by a superuser are not usable by the application role otherwise.
GRANT ALL ON ALL TABLES IN SCHEMA public TO excalidraw;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO excalidraw;
