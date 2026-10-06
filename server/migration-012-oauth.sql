-- OAuth for MCP clients (Claude, ChatGPT). Secrets are stored only as hashes.
CREATE TABLE oauth_clients (
 client_id text PRIMARY KEY,
 name text NOT NULL,
 redirect_uris text[] NOT NULL,
 secret_hash text,
 created_at timestamptz NOT NULL DEFAULT now(),
 last_used_at timestamptz
);
CREATE TABLE oauth_codes (
 code_hash text PRIMARY KEY,
 client_id text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 redirect_uri text NOT NULL,
 scope text NOT NULL,
 code_challenge text NOT NULL,
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz
);
CREATE TABLE oauth_tokens (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 token_hash text NOT NULL UNIQUE,
 kind text NOT NULL CHECK (kind IN ('access','refresh')),
 client_id text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 scope text NOT NULL,
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oauth_tokens_owner ON oauth_tokens(user_id) WHERE revoked_at IS NULL;
CREATE INDEX oauth_codes_expiry ON oauth_codes(expires_at);
GRANT ALL ON oauth_clients, oauth_codes, oauth_tokens TO excalidraw;
