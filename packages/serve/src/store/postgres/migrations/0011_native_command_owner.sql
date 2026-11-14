-- A bounded connector owner is derived from the exact command JSON by the server, preserving payload bytes (including
-- escaped NUL, which PostgreSQL JSON extraction cannot read). Existing rows are backfilled before polling is served.
ALTER TABLE settings ADD COLUMN IF NOT EXISTS connector_id TEXT COLLATE "C";
CREATE INDEX IF NOT EXISTS settings_native_commands ON settings (connector_id, key)
  WHERE key >= 'native.remote.command.' AND key < 'native.remote.command/';
UPDATE store_meta SET schema_version = 11 WHERE singleton = 1;
