-- Workspace icon uploads can be raster images as well as SVGs. Keep the old
-- column for compatibility with rows created before this migration.
ALTER TABLE icons ADD COLUMN icon_data bytea;
UPDATE icons SET icon_data = svg_data WHERE svg_data IS NOT NULL;
