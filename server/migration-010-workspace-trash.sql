ALTER TABLE workspaces ADD COLUMN deleted_at timestamptz;
ALTER TABLE workspaces ADD COLUMN deleted_by uuid REFERENCES users(id);
ALTER TABLE workspaces ADD COLUMN purge_after timestamptz;
ALTER TABLE workspaces ADD COLUMN purging_at timestamptz;
CREATE TABLE workspace_cleanup_objects (
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 object_key text NOT NULL, completed_at timestamptz,
 PRIMARY KEY(workspace_id,object_key)
);
CREATE INDEX ON workspaces(purge_after) WHERE deleted_at IS NOT NULL;
GRANT ALL ON workspace_cleanup_objects TO excalidraw;
-- Serialize child writes with deletion so a confirmed workspace cannot receive late saves.
CREATE FUNCTION require_active_workspace() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM workspaces WHERE id=NEW.workspace_id AND deleted_at IS NULL FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Workspace is unavailable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER scenes_active_workspace BEFORE INSERT OR UPDATE ON scenes FOR EACH ROW EXECUTE FUNCTION require_active_workspace();
CREATE TRIGGER collections_active_workspace BEFORE INSERT OR UPDATE ON collections FOR EACH ROW EXECUTE FUNCTION require_active_workspace();
CREATE TRIGGER members_active_workspace BEFORE INSERT ON workspace_members FOR EACH ROW EXECUTE FUNCTION require_active_workspace();
CREATE TRIGGER exports_active_workspace BEFORE INSERT ON workspace_exports FOR EACH ROW EXECUTE FUNCTION require_active_workspace();
