-- Additive migration: retain all existing drawings and collection memberships.
ALTER TABLE collections ADD COLUMN deleted_at timestamptz;
ALTER TABLE scenes ADD COLUMN private_owner_id uuid REFERENCES users(id);
ALTER TABLE scenes ADD COLUMN pinned boolean NOT NULL DEFAULT false;
CREATE TABLE scene_visits (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 scene_id uuid NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
 visited_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,scene_id)
);
CREATE INDEX ON scene_visits(user_id,visited_at DESC);
CREATE TABLE workspace_activity (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 scene_id uuid REFERENCES scenes(id) ON DELETE CASCADE, actor_id uuid REFERENCES users(id),
 action text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON workspace_activity(workspace_id,created_at DESC);
GRANT ALL ON ALL TABLES IN SCHEMA public TO excalidraw;
