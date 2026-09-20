-- Keys that let an AI assistant act as one person through the MCP endpoint.
CREATE TABLE mcp_keys (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
 name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
 token_hash text NOT NULL UNIQUE,
 scope text NOT NULL DEFAULT 'read' CHECK (scope IN ('read','write')),
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid REFERENCES users(id),
 last_used_at timestamptz,
 revoked_at timestamptz
);
CREATE INDEX mcp_keys_owner ON mcp_keys(user_id) WHERE revoked_at IS NULL;
GRANT ALL ON mcp_keys TO excalidraw;
