-- ── collections (the "Collections" sidebar) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS collections (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL,
  icon         text NOT NULL DEFAULT 'folder',
  is_private   boolean NOT NULL DEFAULT false,
  position     integer NOT NULL DEFAULT 0,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS collections_ws_idx ON collections (workspace_id, position, name);

-- a private collection is visible only to its creator
CREATE UNIQUE INDEX IF NOT EXISTS collections_ws_name_idx
  ON collections (workspace_id, lower(name));

ALTER TABLE scenes ADD COLUMN IF NOT EXISTS collection_id uuid
  REFERENCES collections(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS scenes_collection_idx ON scenes (collection_id)
  WHERE deleted_at IS NULL;

-- who last opened what, for "Recently modified by you"
ALTER TABLE scenes ADD COLUMN IF NOT EXISTS last_opened_at timestamptz;

DROP TRIGGER IF EXISTS collections_touch ON collections;
CREATE TRIGGER collections_touch BEFORE UPDATE ON collections
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

GRANT ALL ON ALL TABLES IN SCHEMA public TO excalidraw;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO excalidraw;
