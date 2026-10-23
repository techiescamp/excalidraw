-- Images lived inside each scene as base64, so a drawing carrying 109 of them
-- was 27 MB, every save rewrote all of it, and a collaborative save first read
-- it all back. Store the bytes once per workspace, keyed by their own digest,
-- and let scenes point at them.
CREATE TABLE workspace_blobs (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sha256       text NOT NULL,
  mime         text NOT NULL,
  size_bytes   bigint NOT NULL,
  s3_key       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, sha256)
);

-- Which drawing uses which image, under the file id its elements already carry.
-- Two drawings may name identical bytes differently, so the mapping is per
-- scene and element data never has to be rewritten.
CREATE TABLE scene_blob_refs (
  scene_id     uuid NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  file_id      text NOT NULL,
  sha256       text NOT NULL,
  PRIMARY KEY (scene_id, file_id)
);
CREATE INDEX ON scene_blob_refs (workspace_id, sha256);

GRANT ALL ON ALL TABLES IN SCHEMA public TO excalidraw;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO excalidraw;
