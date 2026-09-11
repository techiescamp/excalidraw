-- Runtime configuration set from the dashboard, so an operator can point the
-- instance at object storage without editing files on the server.
-- Secrets are stored encrypted (AES-256-GCM, key derived from JWT_SECRET).
CREATE TABLE IF NOT EXISTS app_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL DEFAULT '{}',
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON ALL TABLES IN SCHEMA public TO excalidraw;
