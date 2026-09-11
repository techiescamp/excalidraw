ALTER TABLE collections ADD COLUMN team_restricted boolean NOT NULL DEFAULT false;
CREATE TABLE workspace_teams (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 name text NOT NULL CHECK(char_length(name) BETWEEN 1 AND 80), color text NOT NULL DEFAULT '#6965db',
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(workspace_id,id)
);
CREATE UNIQUE INDEX workspace_team_names ON workspace_teams(workspace_id,lower(name));
CREATE TABLE workspace_team_members (
 workspace_id uuid NOT NULL, team_id uuid NOT NULL, user_id uuid NOT NULL,
 PRIMARY KEY(team_id,user_id),
 FOREIGN KEY(workspace_id,team_id) REFERENCES workspace_teams(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,user_id) REFERENCES workspace_members(workspace_id,user_id) ON DELETE CASCADE
);
CREATE TABLE workspace_team_collections (
 workspace_id uuid NOT NULL,team_id uuid NOT NULL,collection_id uuid NOT NULL,
 PRIMARY KEY(team_id,collection_id),
 FOREIGN KEY(workspace_id,team_id) REFERENCES workspace_teams(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,collection_id) REFERENCES collections(workspace_id,id) ON DELETE CASCADE
);
GRANT ALL ON ALL TABLES IN SCHEMA public TO excalidraw;
