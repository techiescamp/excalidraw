ALTER TABLE icons
  ADD COLUMN category text NOT NULL DEFAULT 'General'
    CHECK (char_length(category) BETWEEN 1 AND 40 AND category = btrim(category));

ALTER TABLE icons
  ADD COLUMN display_name text
    CHECK (display_name IS NULL OR (char_length(display_name) BETWEEN 1 AND 80 AND display_name = btrim(display_name)));
