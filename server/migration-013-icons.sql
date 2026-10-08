-- Icon library: uploaded packs and icons fetched once from approved sources.
CREATE TABLE icons (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 set_name text NOT NULL CHECK (char_length(set_name) BETWEEN 1 AND 60),
 name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
 mime text NOT NULL,
 s3_key text NOT NULL,
 width integer NOT NULL DEFAULT 64,
 height integer NOT NULL DEFAULT 64,
 source text,
 license text,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid REFERENCES users(id),
 UNIQUE (workspace_id, set_name, name)
);
CREATE INDEX icons_lookup ON icons(workspace_id, set_name);
GRANT ALL ON icons TO excalidraw;

-- Admin switch for fetching missing icons from the internet; off until enabled.
INSERT INTO app_settings(key, value) VALUES('icons', '{"fetch_enabled": false}'::jsonb)
 ON CONFLICT (key) DO NOTHING;
