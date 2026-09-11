-- ── enums ────────────────────────────────────────────────────────────────────
CREATE TYPE member_role  AS ENUM ('owner','admin','editor','viewer');
CREATE TYPE scene_perm   AS ENUM ('edit','view');
CREATE TYPE invite_state AS ENUM ('pending','accepted','revoked','expired');

-- ── users ────────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext UNIQUE NOT NULL,
  password_hash text,                       -- null when SSO-only
  display_name  text NOT NULL DEFAULT '',
  avatar_url    text,
  is_active     boolean NOT NULL DEFAULT true,
  is_superadmin boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

-- ── workspaces (teams) ───────────────────────────────────────────────────────
CREATE TABLE workspaces (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  slug       citext UNIQUE NOT NULL,
  owner_id   uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- "user-add option": who belongs to a workspace and at what level
CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         member_role NOT NULL DEFAULT 'editor',
  added_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  added_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX ON workspace_members (user_id);

-- invite a user who does not have an account yet
CREATE TABLE workspace_invites (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email        citext NOT NULL,
  role         member_role NOT NULL DEFAULT 'editor',
  token_hash   text NOT NULL UNIQUE,
  state        invite_state NOT NULL DEFAULT 'pending',
  invited_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at   timestamptz NOT NULL DEFAULT now() + interval '14 days',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON workspace_invites (workspace_id, email);

-- ── scenes: metadata in Postgres, payload in S3 ──────────────────────────────
CREATE TABLE scenes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_id      uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name          text NOT NULL DEFAULT 'Untitled',
  s3_key        text NOT NULL,              -- current payload object
  thumb_s3_key  text,
  size_bytes    bigint NOT NULL DEFAULT 0,
  scene_version integer NOT NULL DEFAULT 0, -- Excalidraw's getSceneVersion()
  is_encrypted  boolean NOT NULL DEFAULT false,
  room_id       text UNIQUE,                -- links a live collab room to a scene
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  deleted_at    timestamptz                 -- soft delete / trash
);
CREATE INDEX ON scenes (workspace_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX ON scenes (owner_id);

-- immutable version history; enables "restore previous version"
CREATE TABLE scene_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scene_id      uuid NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  s3_key        text NOT NULL,
  scene_version integer NOT NULL,
  size_bytes    bigint NOT NULL DEFAULT 0,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON scene_versions (scene_id, created_at DESC);

-- "edit option": explicit per-user grants on top of workspace role
CREATE TABLE scene_permissions (
  scene_id   uuid NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission scene_perm NOT NULL DEFAULT 'view',
  granted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scene_id, user_id)
);

-- anonymous/link sharing, view-only or editable
CREATE TABLE share_links (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scene_id   uuid NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  permission scene_perm NOT NULL DEFAULT 'view',
  expires_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- image/binary assets referenced by elements (fileId → S3 object)
CREATE TABLE scene_files (
  file_id    text NOT NULL,                 -- Excalidraw FileId
  scene_id   uuid REFERENCES scenes(id) ON DELETE CASCADE,
  room_id    text,
  s3_key     text NOT NULL,
  mime_type  text NOT NULL DEFAULT 'application/octet-stream',
  size_bytes bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (file_id, s3_key)
);
CREATE INDEX ON scene_files (scene_id);
CREATE INDEX ON scene_files (room_id);

-- share-link payloads for the /#json=<id>,<key> flow (ciphertext in S3)
CREATE TABLE shared_scenes (
  id         text PRIMARY KEY,              -- short random id used in the URL
  s3_key     text NOT NULL,
  size_bytes bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz
);

-- ── auth sessions and audit ──────────────────────────────────────────────────
CREATE TABLE refresh_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  user_agent text,
  ip         inet,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON refresh_tokens (user_id);

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  actor_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  action      text NOT NULL,                -- scene.update, member.add, perm.grant …
  target_type text,
  target_id   text,
  metadata    jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_log (created_at DESC);

-- ── updated_at trigger ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_touch  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER scenes_touch BEFORE UPDATE ON scenes
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

GRANT ALL ON ALL TABLES IN SCHEMA public TO excalidraw;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO excalidraw;
