-- An icon saved by one person is useful to everyone, so the library is shared
-- across the whole instance rather than kept inside the workspace it came from.
-- Existing icons become shared: that is the behaviour that was asked for, and
-- nothing is hidden that a colleague could not already see.
ALTER TABLE icons ADD COLUMN shared boolean NOT NULL DEFAULT true;
CREATE INDEX icons_shared_lookup ON icons(shared, set_name, name);
