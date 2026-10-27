-- One copy of each image, keyed by what it contains. The same logo added by
-- ten people under ten names is stored once; the names are rows that point at
-- it. This is the arrangement the drawings themselves already use.
CREATE TABLE icon_blobs (
  digest text PRIMARY KEY CHECK (digest ~ '^[0-9a-f]{64}$'),
  bytes bytea NOT NULL,
  mime text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON icon_blobs TO excalidraw;

ALTER TABLE icons ADD COLUMN digest text REFERENCES icon_blobs(digest);
CREATE INDEX icons_digest ON icons(digest);

-- Existing icons move into the shared store. ON CONFLICT collapses the
-- duplicates that are already there, which is the whole point.
INSERT INTO icon_blobs(digest, bytes, mime)
SELECT encode(sha256(COALESCE(icon_data, svg_data)), 'hex'),
       COALESCE(icon_data, svg_data),
       mime
  FROM icons
 WHERE COALESCE(icon_data, svg_data) IS NOT NULL
ON CONFLICT (digest) DO NOTHING;

UPDATE icons
   SET digest = encode(sha256(COALESCE(icon_data, svg_data)), 'hex')
 WHERE COALESCE(icon_data, svg_data) IS NOT NULL;

-- The bytes are now held once in icon_blobs, so the per-row copies go. This
-- would normally wait a release, because a migration must be safe while the
-- old code is still serving — here the icon library has never been deployed,
-- so there is no old code reading these columns.
UPDATE icons SET icon_data = NULL, svg_data = NULL WHERE digest IS NOT NULL;
