CREATE TABLE workspace_exports (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 requested_by uuid NOT NULL REFERENCES users(id),
 scope text NOT NULL CHECK(scope IN ('accessible','all','member')),
 member_id uuid REFERENCES users(id),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','exporting','ready','failed','expired')),
 object_key text, scene_count integer NOT NULL DEFAULT 0, error text,
 created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days'
);
CREATE INDEX ON workspace_exports(workspace_id,created_at DESC);
CREATE TABLE workspace_import_files (
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 requested_by uuid NOT NULL REFERENCES users(id), request_id uuid NOT NULL,
 file_path text NOT NULL, fingerprint text NOT NULL, scene_id uuid REFERENCES scenes(id) ON DELETE SET NULL,
 PRIMARY KEY(workspace_id,requested_by,request_id,file_path)
);
GRANT ALL ON workspace_exports,workspace_import_files TO excalidraw;
