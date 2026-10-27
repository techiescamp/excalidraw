-- New icon SVGs live in PostgreSQL; retain nullable object keys for legacy rows.
ALTER TABLE icons ADD COLUMN svg_data bytea;
ALTER TABLE icons ALTER COLUMN s3_key DROP NOT NULL;
