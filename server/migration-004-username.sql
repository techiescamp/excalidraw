-- Single-tenant instance: usernames replace email addresses as the identity.
-- Email becomes optional and is no longer used for sign-in or invitations.
ALTER TABLE users ADD COLUMN IF NOT EXISTS username citext;

-- derive a username for anyone who predates this migration
UPDATE users
   SET username = regexp_replace(
         coalesce(nullif(display_name, ''), split_part(email, '@', 1)),
         '[^A-Za-z0-9_.-]', '', 'g')
 WHERE username IS NULL;

-- de-duplicate before enforcing uniqueness
UPDATE users u SET username = u.username || '_' || left(u.id::text, 4)
  WHERE EXISTS (
    SELECT 1 FROM users o
     WHERE lower(o.username) = lower(u.username) AND o.id <> u.id
       AND o.created_at < u.created_at);

ALTER TABLE users ALTER COLUMN username SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_username_idx ON users (username);

-- email is now optional; Postgres allows many NULLs under a UNIQUE index
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;

-- invitations were email-based; accounts are created directly instead
DROP TABLE IF EXISTS workspace_invites;

GRANT ALL ON ALL TABLES IN SCHEMA public TO excalidraw;
